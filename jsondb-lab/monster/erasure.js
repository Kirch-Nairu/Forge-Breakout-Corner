'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, uuid, ensureDir, exists, readJson, atomicJson, merkleRoot } = require('./jsonfs');

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < EXP.length; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) { return (!a || !b) ? 0 : EXP[LOG[a] + LOG[b]]; }
function gfInv(a) { if (!a) throw new Error('GF inverse of zero'); return EXP[255 - LOG[a]]; }
function gfPow(a, n) {
  if (n === 0) return 1;
  if (a === 0) return 0;
  return EXP[(LOG[a] * n) % 255];
}
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function matrixIdentity(n) {
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => r === c ? 1 : 0));
}
function matrixMultiply(a, b) {
  const rows = a.length, inner = b.length, cols = b[0].length;
  const out = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let value = 0;
    for (let k = 0; k < inner; k++) value ^= gfMul(a[r][k], b[k][c]);
    out[r][c] = value;
  }
  return out;
}
function matrixInvert(input) {
  const n = input.length;
  const a = input.map(row => [...row]);
  const inv = matrixIdentity(n);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    while (pivot < n && a[pivot][col] === 0) pivot++;
    if (pivot === n) throw new Error('Singular GF matrix');
    if (pivot !== col) { [a[pivot], a[col]] = [a[col], a[pivot]]; [inv[pivot], inv[col]] = [inv[col], inv[pivot]]; }
    const scale = gfInv(a[col][col]);
    for (let c = 0; c < n; c++) { a[col][c] = gfMul(a[col][c], scale); inv[col][c] = gfMul(inv[col][c], scale); }
    for (let r = 0; r < n; r++) {
      if (r === col || a[r][col] === 0) continue;
      const factor = a[r][col];
      for (let c = 0; c < n; c++) {
        a[r][c] ^= gfMul(factor, a[col][c]);
        inv[r][c] ^= gfMul(factor, inv[col][c]);
      }
    }
  }
  return inv;
}
function generatorMatrix(dataShards, parityShards) {
  const total = dataShards + parityShards;
  if (total >= 255) throw new Error('GF(256) implementation supports fewer than 255 total shards.');
  const vandermonde = Array.from({ length: total }, (_, r) => Array.from({ length: dataShards }, (_, c) => gfPow(r + 1, c)));
  const topInv = matrixInvert(vandermonde.slice(0, dataShards));
  return matrixMultiply(vandermonde, topInv);
}
function combineRow(coefficients, shards, size) {
  const out = Buffer.alloc(size);
  for (let s = 0; s < coefficients.length; s++) {
    const coef = coefficients[s];
    if (!coef) continue;
    const shard = shards[s];
    for (let i = 0; i < size; i++) out[i] ^= gfMul(coef, shard[i]);
  }
  return out;
}

class ReedSolomonArk {
  constructor(root, dataShards = 6, parityShards = 3) {
    this.root = root;
    this.archives = path.join(root, 'archives');
    this.quarantine = path.join(root, 'quarantine');
    this.k = Math.max(2, Number(dataShards || 6));
    this.m = Math.max(1, Number(parityShards || 3));
    this.generator = generatorMatrix(this.k, this.m);
  }

  async init() { await ensureDir(this.archives); await ensureDir(this.quarantine); }

  encode(buffer) {
    const size = Math.ceil(buffer.length / this.k) || 1;
    const padded = Buffer.alloc(size * this.k);
    buffer.copy(padded);
    const data = Array.from({ length: this.k }, (_, i) => Buffer.from(padded.subarray(i * size, (i + 1) * size)));
    const shards = [...data];
    for (let p = 0; p < this.m; p++) shards.push(combineRow(this.generator[this.k + p], data, size));
    return { shards, size, originalBytes: buffer.length };
  }

  async archiveBuffer(logicalName, buffer) {
    await this.init();
    const generation = `${now().replace(/[:.]/g, '-')}-${uuid().slice(0, 8)}`;
    const dir = path.join(this.archives, generation);
    await ensureDir(dir);
    const encoded = this.encode(buffer);
    const manifest = {
      format: 'JSONDB-RS-ARK-1', algorithm: 'systematic-vandermonde-gf256', generation,
      logicalName, createdAt: now(), dataShards: this.k, parityShards: this.m,
      shardSize: encoded.size, originalBytes: encoded.originalBytes,
      originalSha256: sha256(buffer), generator: this.generator, shards: []
    };
    for (let i = 0; i < encoded.shards.length; i++) {
      const buf = encoded.shards[i];
      const file = `shard-${String(i).padStart(2, '0')}.json`;
      const payload = { format: 'JSONDB-RS-SHARD-1', index: i, kind: i < this.k ? 'data' : 'parity', sha256: sha256(buf), base64: buf.toString('base64') };
      await atomicJson(path.join(dir, file), payload);
      manifest.shards.push({ index: i, file, kind: payload.kind, sha256: payload.sha256 });
    }
    manifest.merkleRoot = merkleRoot(manifest.shards.map(x => x.sha256));
    await atomicJson(path.join(dir, 'manifest.json'), manifest);
    return manifest;
  }

  async loadValid(dir, manifest) {
    const buffers = new Array(manifest.shards.length).fill(null);
    const damaged = [];
    for (const spec of manifest.shards) {
      try {
        const payload = await readJson(path.join(dir, spec.file), null);
        const buf = Buffer.from(payload?.base64 || '', 'base64');
        if (!payload?.base64 || sha256(buf) !== spec.sha256) throw new Error('checksum mismatch');
        buffers[spec.index] = buf;
      } catch (error) { damaged.push({ index: spec.index, file: spec.file, reason: error.message }); }
    }
    return { buffers, damaged };
  }

  recoverAll(buffers, manifest) {
    const available = [];
    for (let i = 0; i < buffers.length && available.length < manifest.dataShards; i++) if (buffers[i]) available.push(i);
    if (available.length < manifest.dataShards) throw new Error(`Need ${manifest.dataShards} surviving shards; only ${available.length} remain.`);
    const matrix = available.map(i => manifest.generator[i]);
    const inverse = matrixInvert(matrix);
    const selected = available.map(i => buffers[i]);
    const data = inverse.map(row => combineRow(row, selected, manifest.shardSize));
    const recovered = new Array(manifest.shards.length);
    for (let i = 0; i < manifest.dataShards; i++) recovered[i] = data[i];
    for (let i = manifest.dataShards; i < recovered.length; i++) recovered[i] = combineRow(manifest.generator[i], data, manifest.shardSize);
    return recovered;
  }

  async verifyAndRepair(generation) {
    await this.init();
    const dir = path.join(this.archives, generation);
    const manifest = await readJson(path.join(dir, 'manifest.json'), null);
    if (!manifest) throw new Error(`RS ARK generation not found: ${generation}`);
    const { buffers, damaged } = await this.loadValid(dir, manifest);
    if (damaged.length > manifest.parityShards) return { generation, healthy: false, recoverable: false, damaged, tolerance: manifest.parityShards, reason: 'Erasure count exceeds parity shard count.' };
    let recovered;
    try { recovered = this.recoverAll(buffers, manifest); }
    catch (error) { return { generation, healthy: false, recoverable: false, damaged, reason: error.message }; }
    const original = Buffer.concat(recovered.slice(0, manifest.dataShards)).subarray(0, manifest.originalBytes);
    if (sha256(original) !== manifest.originalSha256) return { generation, healthy: false, recoverable: false, damaged, reason: 'Reconstructed world checksum does not match original.' };
    const repaired = [];
    for (const fault of damaged) {
      const spec = manifest.shards[fault.index];
      const target = path.join(dir, spec.file);
      if (await exists(target)) {
        const q = path.join(this.quarantine, `${generation}-${spec.file}-${Date.now()}.json`);
        await fsp.rename(target, q).catch(() => {});
      }
      const buf = recovered[fault.index];
      await atomicJson(target, { format: 'JSONDB-RS-SHARD-1', index: fault.index, kind: spec.kind, sha256: spec.sha256, base64: buf.toString('base64'), repairedAt: now() });
      repaired.push(spec.file);
    }
    return { generation, healthy: true, recoverable: true, damaged, repaired, restoredSha256: sha256(original), expectedSha256: manifest.originalSha256, buffer: original, tolerance: manifest.parityShards };
  }

  async restore(generation, target) {
    const result = await this.verifyAndRepair(generation);
    if (!result.healthy) throw new Error(`RS ARK ${generation} cannot be restored.`);
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, result.buffer);
    return { generation, target, sha256: result.restoredSha256, repaired: result.repaired, tolerance: result.tolerance };
  }
}

module.exports = { ReedSolomonArk, gfMul, gfInv, gfPow, matrixInvert, generatorMatrix };
