'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, readJsonl, atomicJson } = require('./jsonfs');

function normalize(value) {
  if (Array.isArray(value)) {
    const items = value.map(normalize);
    if (items.every(x => x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string')) items.sort((a,b)=>a.id.localeCompare(b.id));
    return items;
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, normalize(value[k])]));
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex'); }
function entryDigest(entry) {
  const copy = { ...entry };
  delete copy.entryHash;
  return digest(copy);
}

class SemanticChronicle {
  constructor(engine, root) {
    this.engine = engine;
    this.root = root || path.join(engine.data, 'advanced', 'semantic-chronicle');
    this.genesisFile = path.join(this.root, 'genesis.json');
    this.chainFile = path.join(this.root, 'commits.jsonl');
    this.headFile = path.join(this.root, 'head.json');
  }

  async init() {
    await ensureDir(this.root);
    if (!(await readJson(this.genesisFile, null))) {
      const world = await this.world();
      const genesis = {
        format: 'JSONDB-SEMANTIC-GENESIS-1', createdAt: now(),
        world, worldRoot: digest(world)
      };
      await atomicJson(this.genesisFile, genesis);
      await atomicJson(this.headFile, { sequence: 0, entryHash: null, worldRoot: genesis.worldRoot, at: genesis.createdAt });
    }
    return this.verify();
  }

  async world() {
    const catalog = await this.engine.catalog();
    const collections = {};
    for (const name of Object.keys(catalog.collections || {}).sort()) {
      const table = await this.engine.loadCurrent(name);
      collections[name] = (table.rows || []).map(row => normalize(row)).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
    }
    return { collections };
  }

  async prepare(ops = []) {
    await this.init();
    const world = await this.world();
    const head = await readJson(this.headFile, { sequence: 0, entryHash: null, worldRoot: digest(world) });
    return {
      preparedAt: now(), beforeRoot: digest(world), head,
      touched: [...new Set((ops || []).map(x => x.collection))]
    };
  }

  committedOperations(ops, result) {
    const rows = result?.results || [];
    if (rows.length !== ops.length) throw new Error(`Chronicle cannot materialize commit: ${ops.length} operations but ${rows.length} results.`);
    return ops.map((op, i) => {
      const materialized = rows[i];
      if (op.type === 'insert') return { type: 'put', collection: op.collection, id: materialized.id, row: normalize(materialized), sourceType: 'insert' };
      if (op.type === 'update') return { type: 'put', collection: op.collection, id: materialized.id || op.id, row: normalize(materialized), sourceType: 'update' };
      if (op.type === 'delete') return { type: 'delete', collection: op.collection, id: op.id || materialized.id, sourceType: 'delete' };
      throw new Error(`Chronicle unsupported operation ${op.type}`);
    });
  }

  async commit(prepared, ops, result, metadata = {}) {
    await this.init();
    const currentHead = await readJson(this.headFile, { sequence: 0, entryHash: null });
    if (currentHead.entryHash !== prepared.head.entryHash || currentHead.sequence !== prepared.head.sequence) {
      throw new Error('Semantic Chronicle head moved between prepare and commit. Refusing ambiguous history append.');
    }
    const world = await this.world();
    const afterRoot = digest(world);
    const entry = {
      format: 'JSONDB-SEMANTIC-COMMIT-1',
      sequence: Number(currentHead.sequence || 0) + 1,
      at: now(), tx: result?.tx ?? null,
      previousEntryHash: currentHead.entryHash || null,
      beforeRoot: prepared.beforeRoot,
      afterRoot,
      touched: prepared.touched,
      operations: this.committedOperations(ops, result),
      metadata: normalize(metadata)
    };
    entry.entryHash = entryDigest(entry);
    await fsp.appendFile(this.chainFile, `${JSON.stringify(entry)}\n`, 'utf8');
    await atomicJson(this.headFile, { sequence: entry.sequence, entryHash: entry.entryHash, worldRoot: entry.afterRoot, at: entry.at, tx: entry.tx });
    return entry;
  }

  apply(world, operations) {
    const next = JSON.parse(JSON.stringify(world));
    next.collections ||= {};
    for (const op of operations || []) {
      next.collections[op.collection] ||= [];
      const rows = next.collections[op.collection];
      const index = rows.findIndex(r => r.id === op.id);
      if (op.type === 'put') {
        if (index >= 0) rows[index] = normalize(op.row);
        else rows.push(normalize(op.row));
      } else if (op.type === 'delete') {
        if (index >= 0) rows.splice(index, 1);
      } else throw new Error(`Unknown chronicle reducer operation ${op.type}`);
      rows.sort((a,b)=>String(a.id).localeCompare(String(b.id)));
    }
    return next;
  }

  async verify() {
    const genesis = await readJson(this.genesisFile, null);
    if (!genesis) return { valid: false, reason: 'genesis missing' };
    let world = JSON.parse(JSON.stringify(genesis.world));
    let worldRoot = digest(world);
    const failures = [];
    if (worldRoot !== genesis.worldRoot) failures.push({ sequence: 0, reason: 'genesis world root mismatch', expected: genesis.worldRoot, actual: worldRoot });
    const entries = await readJsonl(this.chainFile);
    let previousEntryHash = null;
    let expectedSequence = 1;
    let applied = 0;
    for (const entry of entries) {
      if (entry.__corrupt) { failures.push({ sequence: expectedSequence, reason: 'corrupt JSONL entry' }); expectedSequence++; continue; }
      if (entry.sequence !== expectedSequence) failures.push({ sequence: entry.sequence, reason: 'sequence discontinuity', expectedSequence });
      if (entry.previousEntryHash !== previousEntryHash) failures.push({ sequence: entry.sequence, reason: 'previous entry hash mismatch', expected: previousEntryHash, actual: entry.previousEntryHash });
      const actualEntryHash = entryDigest(entry);
      if (actualEntryHash !== entry.entryHash) failures.push({ sequence: entry.sequence, reason: 'entry hash mismatch', expected: entry.entryHash, actual: actualEntryHash });
      if (entry.beforeRoot !== worldRoot) failures.push({ sequence: entry.sequence, reason: 'beforeRoot disagrees with independent replay', expected: worldRoot, actual: entry.beforeRoot });
      try {
        world = this.apply(world, entry.operations || []);
        worldRoot = digest(world);
        if (entry.afterRoot !== worldRoot) failures.push({ sequence: entry.sequence, reason: 'afterRoot disagrees with independent replay', expected: worldRoot, actual: entry.afterRoot });
      } catch (error) { failures.push({ sequence: entry.sequence, reason: `reducer failure: ${error.message}` }); }
      previousEntryHash = entry.entryHash;
      expectedSequence++;
      applied++;
    }
    const live = await this.world().catch(() => null);
    const liveRoot = live ? digest(live) : null;
    const head = await readJson(this.headFile, null);
    if (head && head.entryHash !== previousEntryHash) failures.push({ reason: 'head file entryHash disagrees with replay', expected: previousEntryHash, actual: head.entryHash });
    if (head && head.worldRoot !== worldRoot) failures.push({ reason: 'head file worldRoot disagrees with replay', expected: worldRoot, actual: head.worldRoot });
    const liveMatchesReplay = liveRoot === worldRoot;
    if (!liveMatchesReplay) failures.push({ reason: 'live semantic world differs from replayed chronicle', replayRoot: worldRoot, liveRoot });
    return {
      format: 'JSONDB-SEMANTIC-CHRONICLE-VERIFY-1', valid: failures.length === 0,
      appliedCommits: applied, replayRoot: worldRoot, liveRoot, liveMatchesReplay,
      head, failures, replayWorld: failures.length ? world : undefined
    };
  }

  async resetGenesis(reason = 'operator reset') {
    const world = await this.world();
    const old = { genesis: await readJson(this.genesisFile, null), commits: await readJsonl(this.chainFile) };
    await atomicJson(path.join(this.root, `archive-${Date.now()}.json`), { archivedAt: now(), reason, ...old });
    const genesis = { format: 'JSONDB-SEMANTIC-GENESIS-1', createdAt: now(), reason, world, worldRoot: digest(world) };
    await atomicJson(this.genesisFile, genesis);
    await fsp.writeFile(this.chainFile, '', 'utf8');
    await atomicJson(this.headFile, { sequence: 0, entryHash: null, worldRoot: genesis.worldRoot, at: genesis.createdAt });
    return genesis;
  }
}

module.exports = { SemanticChronicle, normalize, digest, entryDigest };
