'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

class TimeWeave {
  constructor({ savior, omegaEpochRoot, polyhash = null }) {
    this.savior = savior;
    this.omegaEpochRoot = omegaEpochRoot;
    this.epochDir = path.join(omegaEpochRoot, 'epochs');
    this.polyhash = polyhash;
    this.root = path.join(savior.root, 'time-weave');
    this.nodes = path.join(this.root, 'nodes');
    this.indexFile = path.join(this.root, 'index.json');
  }

  async init() {
    await ensureDir(this.nodes);
    if (!(await readJson(this.indexFile, null))) await atomicJson(this.indexFile, { format: 'JSONDB-TIME-WEAVE-INDEX-1', createdAt: now(), nodes: [] });
  }

  async epoch(id) {
    return readJson(path.join(this.epochDir, `${id}.json`), null);
  }

  async append(epoch) {
    await this.init();
    if (!epoch?.id || !epoch?.epochHash) throw new Error('Time Weave requires a sealed OMEGA epoch.');
    const index = await readJson(this.indexFile, { nodes: [] });
    if (index.nodes.some(x => x.epochId === epoch.id)) return readJson(path.join(this.nodes, `${epoch.id}.json`), null);
    const position = index.nodes.length;
    const anchors = [];
    for (let distance = 1; distance <= position; distance *= 2) {
      const target = index.nodes[position - distance];
      if (!target) continue;
      anchors.push({ distance, epochId: target.epochId, epochHash: target.epochHash, weaveHash: target.weaveHash });
    }
    const body = {
      format: 'JSONDB-TIME-WEAVE-NODE-1',
      position, createdAt: now(), epochId: epoch.id,
      epochHash: epoch.epochHash,
      semanticWorldSha256: epoch.semanticWorldSha256,
      anchors,
      doctrine: 'Each epoch cross-links exponentially spaced ancestors. A long-range rewrite must contradict many future nodes, not merely one successor.'
    };
    body.weaveHash = digest(body);
    if (this.polyhash) body.polyhash = await this.polyhash.envelope(body, { purpose: 'time-weave-node' });
    await atomicJson(path.join(this.nodes, `${epoch.id}.json`), body);
    index.nodes.push({ position, epochId: epoch.id, epochHash: epoch.epochHash, weaveHash: body.weaveHash, semanticWorldSha256: epoch.semanticWorldSha256 });
    index.updatedAt = now();
    await atomicJson(this.indexFile, index);
    await atomicJson(path.join(this.root, 'latest.json'), body);
    return body;
  }

  async verifyNode(nodeOrId) {
    await this.init();
    const node = typeof nodeOrId === 'object' ? nodeOrId : await readJson(path.join(this.nodes, `${nodeOrId}.json`), null);
    if (!node) return { valid: false, reason: 'node missing' };
    const copy = { ...node }; delete copy.weaveHash; delete copy.polyhash;
    const computed = digest(copy);
    const failures = [];
    if (computed !== node.weaveHash) failures.push({ type: 'WEAVE_HASH', expected: node.weaveHash, actual: computed });
    const epoch = await this.epoch(node.epochId);
    if (!epoch) failures.push({ type: 'EPOCH_MISSING', epochId: node.epochId });
    else if (epoch.epochHash !== node.epochHash) failures.push({ type: 'EPOCH_HASH_MISMATCH', expected: node.epochHash, actual: epoch.epochHash });
    for (const anchor of node.anchors || []) {
      const target = await readJson(path.join(this.nodes, `${anchor.epochId}.json`), null);
      if (!target) { failures.push({ type: 'ANCHOR_NODE_MISSING', anchor }); continue; }
      if (target.epochHash !== anchor.epochHash || target.weaveHash !== anchor.weaveHash) failures.push({ type: 'ANCHOR_CONTRADICTION', anchor, actual: { epochHash: target.epochHash, weaveHash: target.weaveHash } });
    }
    let polyhash = null;
    if (this.polyhash && node.polyhash) polyhash = await this.polyhash.verify({ ...copy, weaveHash: node.weaveHash }, node.polyhash);
    if (polyhash && !polyhash.valid) failures.push({ type: 'POLYHASH_INVALID' });
    return { valid: failures.length === 0, epochId: node.epochId, position: node.position, failures, polyhash };
  }

  async verifyAll() {
    await this.init();
    const index = await readJson(this.indexFile, { nodes: [] });
    const results = [];
    for (const spec of index.nodes) results.push(await this.verifyNode(spec.epochId));
    const invalid = results.filter(x => !x.valid);
    return { format: 'JSONDB-TIME-WEAVE-VERIFY-1', valid: invalid.length === 0, nodes: results.length, invalid, results };
  }

  async proof(fromEpochId, toEpochId = null) {
    await this.init();
    const index = await readJson(this.indexFile, { nodes: [] });
    const byId = new Map(index.nodes.map(x => [x.epochId, x]));
    const from = byId.get(fromEpochId);
    const to = toEpochId ? byId.get(toEpochId) : index.nodes.at(-1);
    if (!from || !to) throw new Error('Time Weave proof endpoints not found.');
    if (from.position > to.position) throw new Error('Time Weave proof must move forward in time.');
    let cursor = to;
    const pathProof = [];
    while (cursor.position > from.position) {
      const node = await readJson(path.join(this.nodes, `${cursor.epochId}.json`), null);
      if (!node) throw new Error(`Time Weave node missing: ${cursor.epochId}`);
      const eligible = (node.anchors || []).filter(a => byId.get(a.epochId)?.position >= from.position).sort((a,b)=>b.distance-a.distance);
      const next = eligible.find(a => byId.get(a.epochId)?.position < cursor.position);
      if (!next) throw new Error(`No Time Weave path from ${cursor.epochId} toward ${fromEpochId}.`);
      pathProof.push({ from: cursor.epochId, to: next.epochId, distance: next.distance, expectedEpochHash: next.epochHash, expectedWeaveHash: next.weaveHash });
      cursor = byId.get(next.epochId);
    }
    const reached = cursor.epochId === fromEpochId;
    return {
      format: 'JSONDB-TIME-WEAVE-PROOF-1', from: fromEpochId, to: to.epochId,
      reached, hops: pathProof.length, span: to.position - from.position,
      path: pathProof,
      note: 'Proof uses exponentially spaced backward anchors; hop count should grow logarithmically for well-formed index positions.'
    };
  }
}

module.exports = { TimeWeave };
