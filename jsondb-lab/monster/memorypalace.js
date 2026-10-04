'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {
  now, ensureDir, exists, readJson, atomicJson, merkleRoot, listFilesRecursive
} = require('./jsonfs');
const { canonical } = require('./truth');

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function stableBytes(value) { return Buffer.from(JSON.stringify(canonical(value))); }

const GEAR = Array.from({ length: 256 }, (_, i) => crypto.createHash('sha256').update(`jsondb-gear:${i}`).digest().readUInt32BE(0));

function contentDefinedChunks(buffer, options = {}) {
  const min = Math.max(1024, Number(options.min || 8 * 1024));
  const avg = Math.max(min * 2, Number(options.avg || 32 * 1024));
  const max = Math.max(avg * 2, Number(options.max || 128 * 1024));
  const power = Math.max(8, Math.min(22, Math.round(Math.log2(avg))));
  const mask = (2 ** Math.min(power, 30)) - 1;
  const chunks = [];
  let start = 0;
  let hash = 0;
  for (let i = 0; i < buffer.length; i++) {
    hash = (((hash << 1) >>> 0) + GEAR[buffer[i]]) >>> 0;
    const length = i - start + 1;
    if (length >= min && ((hash & mask) === 0 || length >= max)) {
      chunks.push(buffer.subarray(start, i + 1));
      start = i + 1;
      hash = 0;
    }
  }
  if (start < buffer.length || !chunks.length) chunks.push(buffer.subarray(start));
  return { chunks, config: { min, avg, max, mask } };
}

class MemoryPalace {
  constructor(engine, savior, options = {}) {
    this.engine = engine;
    this.savior = savior;
    this.root = path.join(savior.root, 'memory-palace');
    this.objects = path.join(this.root, 'objects');
    this.manifests = path.join(this.root, 'manifests');
    this.vaults = path.join(this.root, 'vaults');
    this.vaultCount = Math.max(3, Number(options.vaults || 3));
  }

  vaultNames() { return Array.from({ length: this.vaultCount }, (_, i) => `vault-${String(i + 1).padStart(2, '0')}`); }

  async init() {
    await ensureDir(this.objects);
    await ensureDir(this.manifests);
    await ensureDir(this.vaults);
    for (const name of this.vaultNames()) await ensureDir(path.join(this.vaults, name));
  }

  objectFile(hash, root = this.objects) { return path.join(root, hash.slice(0, 2), `${hash}.json`); }

  async world() {
    const catalog = await this.engine.catalog();
    const meta = await this.engine.meta();
    const tables = {};
    for (const name of Object.keys(catalog.collections || {}).sort()) tables[name] = await this.engine.loadCurrent(name);
    return { format: 'JSONDB-MEMORY-WORLD-1', catalog, meta, tables };
  }

  async putChunk(buffer, ordinal) {
    const hash = sha256(buffer);
    const payload = {
      format: 'JSONDB-CAS-CHUNK-1', sha256: hash, bytes: buffer.length,
      ordinalHint: ordinal, base64: buffer.toString('base64')
    };
    const primary = this.objectFile(hash);
    if (!(await exists(primary))) {
      await ensureDir(path.dirname(primary));
      await atomicJson(primary, payload);
    }
    for (const vault of this.vaultNames()) {
      const file = this.objectFile(hash, path.join(this.vaults, vault));
      if (!(await exists(file))) {
        await ensureDir(path.dirname(file));
        await atomicJson(file, payload);
      }
    }
    return { hash, bytes: buffer.length };
  }

  async snapshot(label = 'memory-palace', options = {}) {
    await this.init();
    const world = await this.world();
    const bytes = stableBytes(world);
    const split = contentDefinedChunks(bytes, options.chunking || {});
    const chunks = [];
    let reused = 0;
    let created = 0;
    for (let i = 0; i < split.chunks.length; i++) {
      const buf = split.chunks[i];
      const hash = sha256(buf);
      if (await exists(this.objectFile(hash))) reused++; else created++;
      chunks.push(await this.putChunk(buf, i));
    }
    const previous = await readJson(path.join(this.root, 'latest.json'), null);
    const worldSha256 = sha256(bytes);
    const id = `${Date.now()}-${worldSha256.slice(0, 12)}`;
    const manifest = {
      format: 'JSONDB-MEMORY-PALACE-1', id, label, createdAt: now(),
      parent: previous?.id || null,
      worldSha256, worldBytes: bytes.length,
      chunking: split.config,
      chunkCount: chunks.length,
      chunkMerkleRoot: merkleRoot(chunks.map(x => x.hash)),
      chunks,
      dedup: { reused, created, reuseRatio: chunks.length ? reused / chunks.length : 0 },
      vaults: this.vaultNames(),
      doctrine: 'Chunks are immutable content-addressed objects. Manifests form an ancestry chain; restoration depends on object hashes, not filenames.'
    };
    await atomicJson(path.join(this.manifests, `${id}.json`), manifest);
    await atomicJson(path.join(this.root, 'latest.json'), manifest);
    for (const vault of this.vaultNames()) await atomicJson(path.join(this.vaults, vault, 'LATEST-MANIFEST.json'), manifest);
    return manifest;
  }

  async readChunk(hash, options = {}) {
    const candidates = [
      { source: 'primary', file: this.objectFile(hash) },
      ...this.vaultNames().map(vault => ({ source: vault, file: this.objectFile(hash, path.join(this.vaults, vault)) }))
    ];
    const evidence = [];
    for (const candidate of candidates) {
      try {
        const payload = await readJson(candidate.file, null);
        if (!payload?.base64) throw new Error('missing base64 payload');
        const buffer = Buffer.from(payload.base64, 'base64');
        const actual = sha256(buffer);
        const valid = actual === hash && payload.sha256 === hash;
        evidence.push({ source: candidate.source, file: candidate.file, valid, actual });
        if (valid) {
          if (candidate.source !== 'primary' && options.repairPrimary !== false) {
            const target = this.objectFile(hash);
            await ensureDir(path.dirname(target));
            await atomicJson(target, { ...payload, repairedAt: now(), repairedFrom: candidate.source });
          }
          return { buffer, source: candidate.source, evidence };
        }
      } catch (error) {
        evidence.push({ source: candidate.source, file: candidate.file, valid: false, error: error.message });
      }
    }
    return { buffer: null, source: null, evidence };
  }

  async verify(id = null, options = {}) {
    await this.init();
    const manifest = id ? await readJson(path.join(this.manifests, `${id}.json`), null) : await readJson(path.join(this.root, 'latest.json'), null);
    if (!manifest) return { status: 'ABSENT', valid: false, reason: 'Memory Palace manifest missing.' };
    const buffers = [];
    const chunkResults = [];
    for (const spec of manifest.chunks || []) {
      const read = await this.readChunk(spec.hash, { repairPrimary: options.repairPrimary !== false });
      chunkResults.push({ hash: spec.hash, recovered: Boolean(read.buffer), source: read.source, evidence: read.evidence });
      if (!read.buffer) continue;
      buffers.push(read.buffer);
    }
    const allRecovered = buffers.length === (manifest.chunks || []).length;
    const reconstructed = allRecovered ? Buffer.concat(buffers).subarray(0, manifest.worldBytes) : null;
    const worldHash = reconstructed ? sha256(reconstructed) : null;
    const merkle = merkleRoot((manifest.chunks || []).map(x => x.hash));
    const valid = Boolean(allRecovered && worldHash === manifest.worldSha256 && merkle === manifest.chunkMerkleRoot);
    return {
      format: 'JSONDB-MEMORY-PALACE-VERIFY-1', id: manifest.id,
      status: valid ? 'TRUSTED' : allRecovered ? 'HASH_MISMATCH' : 'INCOMPLETE',
      valid, expectedWorldSha256: manifest.worldSha256, reconstructedWorldSha256: worldHash,
      expectedMerkleRoot: manifest.chunkMerkleRoot, computedMerkleRoot: merkle,
      recoveredChunks: buffers.length, totalChunks: manifest.chunks?.length || 0,
      chunkResults,
      _buffer: reconstructed
    };
  }

  async restore(target, id = null) {
    const verification = await this.verify(id, { repairPrimary: true });
    if (!verification.valid || !verification._buffer) throw new Error(`Memory Palace restore refused: ${verification.status}`);
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, verification._buffer);
    return { target, id: verification.id, sha256: verification.reconstructedWorldSha256, chunks: verification.totalChunks };
  }

  async ancestry(limit = 100) {
    let current = await readJson(path.join(this.root, 'latest.json'), null);
    const chain = [];
    while (current && chain.length < limit) {
      chain.push({ id: current.id, parent: current.parent, createdAt: current.createdAt, label: current.label, worldSha256: current.worldSha256, chunks: current.chunkCount, dedup: current.dedup });
      if (!current.parent) break;
      current = await readJson(path.join(this.manifests, `${current.parent}.json`), null);
    }
    return chain;
  }

  async gcPlan() {
    await this.init();
    const manifests = (await fsp.readdir(this.manifests).catch(() => [])).filter(x => x.endsWith('.json'));
    const reachable = new Set();
    for (const file of manifests) {
      const manifest = await readJson(path.join(this.manifests, file), null);
      for (const chunk of manifest?.chunks || []) reachable.add(chunk.hash);
    }
    const objects = await listFilesRecursive(this.objects);
    const unreachable = [];
    for (const file of objects) {
      const name = path.basename(file, '.json');
      if (!reachable.has(name)) unreachable.push(file);
    }
    return {
      manifests: manifests.length, reachableObjects: reachable.size,
      objectFiles: objects.length, unreachable,
      doctrine: 'GC is plan-only by default. Last-savior storage prefers leaks over accidental amnesia.'
    };
  }
}

module.exports = { MemoryPalace, contentDefinedChunks, stableBytes, sha256 };
