'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {
  now, uuid, ensureDir, exists, readJson, atomicJson, hashFile,
  listFilesRecursive, copyDir, merkleRoot
} = require('./jsonfs');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function rel(root, file) { return path.relative(root, file).split(path.sep).join('/'); }
function stamp() { return now().replace(/[:.]/g, '-'); }

class XorArk {
  constructor(root) {
    this.root = root;
    this.archives = path.join(root, 'archives');
    this.quarantine = path.join(root, 'quarantine');
  }

  async init() {
    await ensureDir(this.archives);
    await ensureDir(this.quarantine);
  }

  encode(buffer, dataShards = 4) {
    dataShards = Math.max(2, Math.min(16, Number(dataShards || 4)));
    const shardSize = Math.ceil(buffer.length / dataShards) || 1;
    const padded = Buffer.alloc(shardSize * dataShards);
    buffer.copy(padded);
    const shards = [];
    const parity = Buffer.alloc(shardSize);
    for (let i = 0; i < dataShards; i++) {
      const shard = Buffer.from(padded.subarray(i * shardSize, (i + 1) * shardSize));
      shards.push(shard);
      for (let j = 0; j < shard.length; j++) parity[j] ^= shard[j];
    }
    return { shards, parity, shardSize, originalBytes: buffer.length };
  }

  async archiveBuffer(logicalName, buffer, options = {}) {
    await this.init();
    const generation = `${stamp()}-${uuid().slice(0, 8)}`;
    const dir = path.join(this.archives, generation);
    await ensureDir(dir);
    const encoded = this.encode(buffer, options.dataShards || 4);
    const manifest = {
      format: 'JSONDB-XOR-ARK-1', generation, logicalName, createdAt: now(),
      dataShards: encoded.shards.length, parityShards: 1,
      shardSize: encoded.shardSize, originalBytes: encoded.originalBytes,
      originalSha256: sha256(buffer), shards: []
    };
    const all = [...encoded.shards, encoded.parity];
    for (let i = 0; i < all.length; i++) {
      const kind = i < encoded.shards.length ? 'data' : 'parity';
      const file = `shard-${String(i).padStart(2, '0')}.json`;
      const payload = { format: 'JSONDB-XOR-SHARD-1', index: i, kind, bytes: all[i].length, sha256: sha256(all[i]), base64: all[i].toString('base64') };
      await atomicJson(path.join(dir, file), payload);
      manifest.shards.push({ index: i, kind, file, sha256: payload.sha256 });
    }
    manifest.merkleRoot = merkleRoot(manifest.shards.map(s => s.sha256));
    await atomicJson(path.join(dir, 'manifest.json'), manifest);
    return manifest;
  }

  async archiveFile(file, logicalName = path.basename(file), options = {}) {
    return this.archiveBuffer(logicalName, await fsp.readFile(file), options);
  }

  async verifyAndRepair(generation) {
    await this.init();
    const dir = path.join(this.archives, generation);
    const manifest = await readJson(path.join(dir, 'manifest.json'), null);
    if (!manifest) throw new Error(`ARK generation not found: ${generation}`);
    const buffers = new Array(manifest.shards.length).fill(null);
    const damaged = [];
    for (const spec of manifest.shards) {
      const file = path.join(dir, spec.file);
      try {
        const payload = await readJson(file, null);
        if (!payload?.base64) throw new Error('missing payload');
        const buf = Buffer.from(payload.base64, 'base64');
        if (sha256(buf) !== spec.sha256) throw new Error('checksum mismatch');
        buffers[spec.index] = buf;
      } catch (error) {
        damaged.push({ index: spec.index, file, reason: error.message });
      }
    }
    if (damaged.length > 1) return { generation, healthy: false, recoverable: false, damaged, reason: 'XOR parity tolerates exactly one lost/corrupt shard.' };
    let repaired = null;
    if (damaged.length === 1) {
      const missing = damaged[0].index;
      const recovered = Buffer.alloc(manifest.shardSize);
      for (let i = 0; i < buffers.length; i++) {
        if (i === missing || !buffers[i]) continue;
        for (let j = 0; j < recovered.length; j++) recovered[j] ^= buffers[i][j];
      }
      buffers[missing] = recovered;
      const spec = manifest.shards[missing];
      if (sha256(recovered) !== spec.sha256) return { generation, healthy: false, recoverable: false, damaged, reason: 'Parity reconstruction produced the wrong checksum.' };
      const original = path.join(dir, spec.file);
      if (await exists(original)) {
        const q = path.join(this.quarantine, `${generation}-${path.basename(spec.file)}-${Date.now()}.json`);
        await fsp.rename(original, q).catch(() => {});
      }
      await atomicJson(original, { format: 'JSONDB-XOR-SHARD-1', index: missing, kind: spec.kind, bytes: recovered.length, sha256: spec.sha256, base64: recovered.toString('base64'), repairedAt: now() });
      repaired = spec.file;
    }
    const data = Buffer.concat(buffers.slice(0, manifest.dataShards)).subarray(0, manifest.originalBytes);
    const restoredSha256 = sha256(data);
    return { generation, healthy: restoredSha256 === manifest.originalSha256, recoverable: true, damaged, repaired, restoredSha256, expectedSha256: manifest.originalSha256, buffer: data };
  }

  async restore(generation, target) {
    const result = await this.verifyAndRepair(generation);
    if (!result.healthy) throw new Error(`ARK generation ${generation} is not restorable.`);
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, result.buffer);
    return { generation, target, sha256: result.restoredSha256, repaired: result.repaired };
  }
}

class MirrorQuorum {
  constructor(root, cellCount = 5) {
    this.root = root;
    this.cellsRoot = path.join(root, 'mirrors');
    this.quarantine = path.join(root, 'mirror-quarantine');
    this.cellCount = Math.max(3, Number(cellCount || 5));
  }
  cells() { return Array.from({ length: this.cellCount }, (_, i) => `cell-${String(i + 1).padStart(2, '0')}`); }
  async init() {
    await ensureDir(this.cellsRoot);
    await ensureDir(this.quarantine);
    for (const cell of this.cells()) await ensureDir(path.join(this.cellsRoot, cell));
  }
  async capture(worldRoot, files) {
    await this.init();
    const captured = [];
    for (const file of files) {
      if (!(await exists(file))) continue;
      const relative = rel(worldRoot, file);
      const bytes = await fsp.readFile(file);
      const hash = sha256(bytes);
      for (const cell of this.cells()) {
        const target = path.join(this.cellsRoot, cell, relative);
        await ensureDir(path.dirname(target));
        await fsp.writeFile(target, bytes);
      }
      captured.push({ relative, sha256: hash, bytes: bytes.length });
    }
    const manifest = { capturedAt: now(), cellCount: this.cellCount, quorum: Math.floor(this.cellCount / 2) + 1, files: captured };
    await atomicJson(path.join(this.cellsRoot, 'latest-capture.json'), manifest);
    return manifest;
  }
  async scrub() {
    await this.init();
    const manifest = await readJson(path.join(this.cellsRoot, 'latest-capture.json'), null);
    if (!manifest) return { healthy: false, reason: 'No mirror capture exists yet.', repaired: [], unresolved: [] };
    const quorum = Math.floor(this.cellCount / 2) + 1;
    const repaired = [];
    const unresolved = [];
    for (const fileSpec of manifest.files) {
      const votes = new Map();
      const states = [];
      for (const cell of this.cells()) {
        const file = path.join(this.cellsRoot, cell, fileSpec.relative);
        let hash = null;
        try { hash = await hashFile(file); } catch {}
        states.push({ cell, file, hash });
        if (hash) votes.set(hash, (votes.get(hash) || 0) + 1);
      }
      const winner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
      if (!winner || winner[1] < quorum) {
        unresolved.push({ relative: fileSpec.relative, votes: Object.fromEntries(votes), required: quorum });
        continue;
      }
      const [winnerHash] = winner;
      const source = states.find(s => s.hash === winnerHash);
      const bytes = await fsp.readFile(source.file);
      for (const state of states) {
        if (state.hash === winnerHash) continue;
        if (state.hash) {
          const q = path.join(this.quarantine, `${state.cell}-${path.basename(fileSpec.relative)}-${Date.now()}-${state.hash.slice(0, 10)}.bin`);
          await fsp.copyFile(state.file, q).catch(() => {});
        }
        await ensureDir(path.dirname(state.file));
        await fsp.writeFile(state.file, bytes);
        repaired.push({ relative: fileSpec.relative, cell: state.cell, fromHash: state.hash, toHash: winnerHash });
      }
    }
    return { healthy: unresolved.length === 0, quorum, repaired, unresolved, checkedFiles: manifest.files.length };
  }
}

class SaviorSystem {
  constructor(engine, options = {}) {
    this.engine = engine;
    this.root = path.join(engine.data, 'advanced', 'savior');
    this.stateFile = path.join(this.root, 'state.json');
    this.journal = path.join(this.root, 'guardian-journal.jsonl');
    this.capsules = path.join(this.root, 'capsules');
    this.ark = new XorArk(path.join(this.root, 'ark'));
    this.mirrors = new MirrorQuorum(path.join(this.root, 'quorum'), options.cells || 5);
  }
  async init() {
    await ensureDir(this.root);
    await ensureDir(this.capsules);
    await this.ark.init();
    await this.mirrors.init();
    if (!(await readJson(this.stateFile, null))) {
      await atomicJson(this.stateFile, { format: 'JSONDB-SAVIOR-STATE-1', mode: 'read-write', epoch: 1, createdAt: now(), reason: null, lastGuardianRun: null, lastGoodCapsule: null });
    }
    return this.status();
  }
  async status() { return readJson(this.stateFile, { mode: 'unknown', epoch: 0 }); }
  async assertWritable() {
    const state = await this.status();
    if (state.mode !== 'read-write') throw Object.assign(new Error(`SAVIOR circuit breaker is ${state.mode}: ${state.reason || 'writes are frozen'}`), { status: 503 });
  }
  async setMode(mode, reason) {
    if (!['read-write', 'read-only', 'panic'].includes(mode)) throw new Error('Invalid SAVIOR mode.');
    const state = await this.status();
    state.mode = mode; state.reason = reason || null; state.epoch = (state.epoch || 0) + 1; state.changedAt = now();
    await atomicJson(this.stateFile, state);
    return state;
  }
  async criticalFiles() {
    const files = [this.engine.catalogFile, this.engine.metaFile, this.engine.wal];
    for (const file of await listFilesRecursive(this.engine.current)) files.push(file);
    for (const file of await listFilesRecursive(this.engine.indexes)) files.push(file);
    return files;
  }
  async canary() {
    const dir = path.join(this.root, 'canary');
    await ensureDir(dir);
    const token = crypto.randomBytes(64);
    const file = path.join(dir, `canary-${uuid()}.bin`);
    await fsp.writeFile(file, token);
    const expected = sha256(token);
    const actual = await hashFile(file);
    await fsp.unlink(file).catch(() => {});
    return { ok: expected === actual, expected, actual };
  }
  async captureMirrors() { return this.mirrors.capture(this.engine.data, await this.criticalFiles()); }
  async capsule(label = 'doomsday') {
    const id = `${stamp()}-${String(label).replace(/[^A-Za-z0-9_-]/g, '_')}-${uuid().slice(0, 8)}`;
    const dir = path.join(this.capsules, id);
    await ensureDir(dir);
    const current = path.join(dir, 'current');
    await copyDir(this.engine.current, current);
    const copyIf = async (src, dst) => { if (await exists(src)) await fsp.copyFile(src, dst); };
    await copyIf(this.engine.catalogFile, path.join(dir, 'catalog.json'));
    await copyIf(this.engine.metaFile, path.join(dir, 'meta.json'));
    await copyIf(this.engine.wal, path.join(dir, 'wal.jsonl'));
    const inferred = await this.inferCatalog();
    await atomicJson(path.join(dir, 'inferred-catalog.json'), inferred);
    const files = await listFilesRecursive(dir);
    const hashes = [];
    const entries = [];
    for (const file of files) {
      if (file.endsWith('manifest.json')) continue;
      const hash = await hashFile(file); hashes.push(hash);
      entries.push({ path: rel(dir, file), bytes: (await fsp.stat(file)).size, sha256: hash });
    }
    const manifest = { format: 'JSONDB-DOOMSDAY-CAPSULE-1', id, label, createdAt: now(), engineRoot: this.engine.data, entries, merkleRoot: merkleRoot(hashes), instructions: 'Rebuild catalog from inferred-catalog.json if catalog.json is lost. Canonical tables live under current/. WAL is evidence, not the only recovery source.' };
    await atomicJson(path.join(dir, 'manifest.json'), manifest);
    const packed = Buffer.from(JSON.stringify({ manifest, inferred, tables: await this.readCurrentTables() }));
    const ark = await this.ark.archiveBuffer(`capsule:${id}`, packed, { dataShards: 6 });
    const state = await this.status();
    state.lastGoodCapsule = id; state.lastCapsuleAt = now();
    await atomicJson(this.stateFile, state);
    return { manifest, arkGeneration: ark.generation };
  }
  async readCurrentTables() {
    const out = {};
    for (const file of await listFilesRecursive(this.engine.current)) {
      if (!file.endsWith('.json')) continue;
      out[path.basename(file, '.json')] = await readJson(file, null);
    }
    return out;
  }
  async inferCatalog() {
    const collections = {};
    for (const file of await listFilesRecursive(this.engine.current)) {
      if (!file.endsWith('.json')) continue;
      const table = await readJson(file, null);
      if (!table?.name || !Array.isArray(table.rows)) continue;
      const fields = {};
      for (const row of table.rows) {
        for (const [field, value] of Object.entries(row)) {
          const t = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
          fields[field] ||= { observed: {}, present: 0, nulls: 0 };
          fields[field].observed[t] = (fields[field].observed[t] || 0) + 1;
          fields[field].present++;
          if (value === null) fields[field].nulls++;
        }
      }
      collections[table.name] = { inferredAt: now(), rows: table.rows.length, fields: Object.fromEntries(Object.entries(fields).map(([name, f]) => [name, { types: Object.keys(f.observed), counts: f.observed, nullable: f.nulls > 0, optional: f.present < table.rows.length }])) };
    }
    return { format: 'JSONDB-INFERRED-CATALOG-1', inferredAt: now(), collections };
  }
  async rebuildCatalogFromWorld(target = null) {
    const inferred = await this.inferCatalog();
    const existing = await this.engine.catalog().catch(() => ({ version: 2, collections: {}, materializedViews: {} }));
    const rebuilt = { version: existing.version || 2, rebuiltAt: now(), collections: {}, materializedViews: existing.materializedViews || {} };
    for (const [name] of Object.entries(inferred.collections)) rebuilt.collections[name] = existing.collections?.[name] || { createdAt: now(), unique: [], foreignKeys: [], indexes: [] };
    const file = target || path.join(this.root, `reconstructed-catalog-${Date.now()}.json`);
    await atomicJson(file, rebuilt);
    return { file, inferred, rebuilt };
  }
  async guardianCycle(options = {}) {
    await this.init();
    const canary = await this.canary();
    if (options.capture !== false) await this.captureMirrors();
    const scrub = await this.mirrors.scrub();
    const integrity = await this.engine.verifyIntegrity().catch(error => ({ status: 'error', error: error.message }));
    const severe = !canary.ok || scrub.unresolved?.length > 0 || integrity.status === 'error';
    if (severe && options.autoFreeze !== false) await this.setMode('read-only', `Guardian detected unsafe storage: canary=${canary.ok}, unresolved=${scrub.unresolved?.length || 0}, integrity=${integrity.status || 'unknown'}`);
    const state = await this.status();
    state.lastGuardianRun = now();
    state.lastGuardianResult = { canary: canary.ok, mirrorHealthy: scrub.healthy, integrity: integrity.status || 'unknown' };
    await atomicJson(this.stateFile, state);
    const report = { at: now(), state, canary, scrub, integrity };
    await fsp.appendFile(this.journal, `${JSON.stringify(report)}\n`, 'utf8');
    return report;
  }
}

module.exports = { XorArk, MirrorQuorum, SaviorSystem, sha256 };
