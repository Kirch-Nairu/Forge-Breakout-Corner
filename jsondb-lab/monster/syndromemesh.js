'use strict';

const crypto = require('crypto');
const path = require('path');
const { now, ensureDir, readJson, atomicJson, hashFile } = require('./jsonfs');

function digestBytes(hex) { return Buffer.from(hex, 'hex'); }
function xorBuffers(buffers) {
  if (!buffers.length) return Buffer.alloc(32);
  const out = Buffer.alloc(buffers[0].length);
  for (const buffer of buffers) for (let i = 0; i < out.length; i++) out[i] ^= buffer[i];
  return out;
}
function h(text) { return crypto.createHash('sha256').update(String(text)).digest('hex'); }
function randomInt(seed, counter, max) {
  const bytes = crypto.createHash('sha256').update(`${seed}:${counter}`).digest();
  return max ? bytes.readUInt32BE(0) % max : 0;
}

class SyndromeMesh {
  constructor({ savior, braid = null }) {
    this.savior = savior;
    this.braid = braid;
    this.root = path.join(savior.root, 'syndrome-mesh');
    this.generations = path.join(this.root, 'generations');
  }

  async init() { await ensureDir(this.generations); }

  async seed(explicit = null) {
    if (explicit) return String(explicit);
    if (this.braid) {
      const head = await readJson(this.braid.head, null);
      if (head?.epochHash) return head.epochHash;
    }
    return h(JSON.stringify(await this.savior.status()));
  }

  async nodes() {
    const files = await this.savior.criticalFiles();
    const rows = [];
    for (const file of files.sort()) {
      try {
        rows.push({ file, relative: path.relative(this.savior.engine.data, file).split(path.sep).join('/'), sha256: await hashFile(file) });
      } catch {
        rows.push({ file, relative: path.relative(this.savior.engine.data, file).split(path.sep).join('/'), sha256: null });
      }
    }
    return rows;
  }

  chooseEdge(count, width, seed, edgeIndex) {
    const set = new Set();
    let counter = 0;
    while (set.size < Math.min(width, count)) set.add(randomInt(`${seed}:edge:${edgeIndex}`, counter++, count));
    return [...set].sort((a,b)=>a-b);
  }

  async build(options = {}) {
    await this.init();
    const nodes = await this.nodes();
    const usable = nodes.filter(x => x.sha256);
    if (usable.length < 3) throw new Error('Syndrome Mesh needs at least three readable critical files.');
    const seed = await this.seed(options.seed);
    const checksPerNode = Math.max(3, Math.min(20, Number(options.checksPerNode || 6)));
    const widths = [3,4,5].filter(x => x <= usable.length);
    const edgeCount = Math.max(usable.length, Math.ceil(usable.length * checksPerNode / Math.max(1, widths.reduce((a,b)=>a+b,0)/widths.length)));
    const checks = [];
    for (let i = 0; i < edgeCount; i++) {
      const width = widths[i % widths.length];
      const indexes = this.chooseEdge(usable.length, width, seed, i);
      const members = indexes.map(index => usable[index]);
      const parity = xorBuffers(members.map(x => digestBytes(x.sha256))).toString('hex');
      checks.push({
        id: `check-${String(i).padStart(6,'0')}`, width,
        members: members.map(x => x.relative),
        parity,
        descriptorHash: h(JSON.stringify({ seed, i, members: members.map(x=>x.relative), parity }))
      });
    }
    const generation = `${Date.now()}-${h(seed).slice(0,12)}`;
    const manifest = {
      format: 'JSONDB-SYNDROME-MESH-1', generation, createdAt: now(), seed,
      nodes: usable.map(x => ({ relative: x.relative, sha256: x.sha256 })),
      checks,
      doctrine: 'Overlapping digest-parity checks localize suspicious artifacts. Syndrome evidence does not by itself authorize repair.'
    };
    await atomicJson(path.join(this.generations, `${generation}.json`), manifest);
    await atomicJson(path.join(this.root, 'latest.json'), manifest);
    return { generation, nodes: manifest.nodes.length, checks: checks.length, seed };
  }

  async diagnose(generation = null) {
    await this.init();
    const manifest = generation ? await readJson(path.join(this.generations, `${generation}.json`), null) : await readJson(path.join(this.root, 'latest.json'), null);
    if (!manifest) return { status: 'ABSENT', failures: [] };
    const current = new Map();
    for (const node of manifest.nodes || []) {
      const file = path.join(this.savior.engine.data, node.relative);
      let sha256 = null;
      try { sha256 = await hashFile(file); } catch {}
      current.set(node.relative, { relative: node.relative, sha256, expected: node.sha256, directlyMatches: sha256 === node.sha256 });
    }
    const checkResults = [];
    for (const check of manifest.checks || []) {
      const members = check.members.map(relative => current.get(relative));
      const readable = members.every(x => x?.sha256);
      const parity = readable ? xorBuffers(members.map(x => digestBytes(x.sha256))).toString('hex') : null;
      const ok = readable && parity === check.parity;
      checkResults.push({ id: check.id, members: check.members, ok, readable, expectedParity: check.parity, actualParity: parity });
    }
    const failed = checkResults.filter(x => !x.ok);
    const score = new Map();
    const participation = new Map();
    for (const check of checkResults) for (const member of check.members) participation.set(member, (participation.get(member)||0)+1);
    for (const check of failed) for (const member of check.members) score.set(member, (score.get(member)||0)+1);
    const ranking = [...current.keys()].map(relative => {
      const failedChecks = score.get(relative) || 0;
      const totalChecks = participation.get(relative) || 0;
      const direct = current.get(relative);
      return {
        relative, failedChecks, totalChecks,
        syndromeRatio: totalChecks ? failedChecks / totalChecks : 0,
        directlyMatchesExpected: direct.directlyMatches,
        readable: Boolean(direct.sha256),
        expectedSha256: direct.expected,
        actualSha256: direct.sha256
      };
    }).sort((a,b)=>Number(a.directlyMatchesExpected)-Number(b.directlyMatchesExpected) || b.syndromeRatio-a.syndromeRatio || b.failedChecks-a.failedChecks || a.relative.localeCompare(b.relative));

    const suspects = ranking.filter(x => !x.directlyMatchesExpected || x.syndromeRatio >= .5);
    const status = failed.length === 0 ? 'CLEAN' : suspects.length ? 'SYNDROME_ACTIVE' : 'AMBIGUOUS';
    const report = {
      format: 'JSONDB-SYNDROME-DIAGNOSIS-1', at: now(), generation: manifest.generation,
      status, failedChecks: failed.length, totalChecks: checkResults.length,
      suspects, ranking,
      doctrine: 'High syndrome participation localizes suspicion. Direct hash mismatch is stronger evidence than syndrome score. Never repair canonical data from syndrome score alone.'
    };
    await atomicJson(path.join(this.root, 'latest-diagnosis.json'), report);
    return report;
  }
}

module.exports = { SyndromeMesh, xorBuffers, randomInt };
