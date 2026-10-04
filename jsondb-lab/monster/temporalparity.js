'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
function mul(a, b) { if (!a || !b) return 0; return EXP[LOG[a] + LOG[b]]; }
function inv(a) { if (!a) throw new Error('GF inverse of zero'); return EXP[255 - LOG[a]]; }
function div(a, b) { if (!a) return 0; return mul(a, inv(b)); }
function coefficient(index) { return EXP[index % 255]; }

class TemporalParityArchive {
  constructor({ savior, omegaEpochRoot }) {
    this.savior = savior;
    this.omegaEpochRoot = omegaEpochRoot;
    this.epochDir = path.join(omegaEpochRoot, 'epochs');
    this.root = path.join(savior.root, 'temporal-parity');
    this.windows = path.join(this.root, 'windows');
  }

  async init() { await ensureDir(this.windows); }

  async epochFiles(limit = 8) {
    await this.init();
    const names = (await fsp.readdir(this.epochDir).catch(() => [])).filter(x => x.endsWith('.json'));
    const rows = [];
    for (const name of names) {
      const file = path.join(this.epochDir, name);
      const stat = await fsp.stat(file).catch(() => null);
      if (stat) rows.push({ name, file, mtimeMs: stat.mtimeMs });
    }
    rows.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    return rows.slice(-Math.max(2, Math.min(32, Number(limit || 8))));
  }

  async seal(options = {}) {
    await this.init();
    const files = await this.epochFiles(options.window || 8);
    if (files.length < 2) throw new Error('Temporal parity needs at least two OMEGA epoch files.');
    const buffers = await Promise.all(files.map(x => fsp.readFile(x.file)));
    const shardSize = Math.max(...buffers.map(x => x.length));
    const padded = buffers.map(buf => { const p = Buffer.alloc(shardSize); buf.copy(p); return p; });
    const p0 = Buffer.alloc(shardSize);
    const p1 = Buffer.alloc(shardSize);
    for (let i = 0; i < padded.length; i++) {
      const c = coefficient(i + 1);
      for (let j = 0; j < shardSize; j++) {
        p0[j] ^= padded[i][j];
        p1[j] ^= mul(padded[i][j], c);
      }
    }
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const dir = path.join(this.windows, id);
    await ensureDir(dir);
    const manifest = {
      format: 'JSONDB-TEMPORAL-PARITY-1', id, createdAt: now(),
      algorithm: 'GF(256) dual parity across complete OMEGA epoch-file bytes',
      shardSize, dataEpochs: files.map((x, i) => ({ index: i, file: x.name, bytes: buffers[i].length, sha256: sha(buffers[i]), coefficient: coefficient(i + 1) })),
      parity: [
        { equation: 'xor', file: 'parity-0.json', sha256: sha(p0) },
        { equation: 'vandermonde-1', file: 'parity-1.json', sha256: sha(p1) }
      ],
      tolerance: 'Up to two missing/corrupt epoch files within this exact window, if both parity files survive.',
      doctrine: 'Temporal parity repairs historical epoch artifacts only. It never promotes a historical world into canonical state.'
    };
    await atomicJson(path.join(dir, 'parity-0.json'), { format: 'JSONDB-TEMPORAL-PARITY-SHARD-1', equation: 0, sha256: sha(p0), base64: p0.toString('base64') });
    await atomicJson(path.join(dir, 'parity-1.json'), { format: 'JSONDB-TEMPORAL-PARITY-SHARD-1', equation: 1, sha256: sha(p1), base64: p1.toString('base64') });
    await atomicJson(path.join(dir, 'manifest.json'), manifest);
    await atomicJson(path.join(this.root, 'latest.json'), { id, createdAt: manifest.createdAt });
    return manifest;
  }

  async loadWindow(id = null) {
    await this.init();
    if (!id) id = (await readJson(path.join(this.root, 'latest.json'), null))?.id;
    if (!id) throw new Error('No temporal parity window exists.');
    const dir = path.join(this.windows, id);
    const manifest = await readJson(path.join(dir, 'manifest.json'), null);
    if (!manifest) throw new Error(`Temporal parity window not found: ${id}`);
    return { id, dir, manifest };
  }

  async parityBuffer(dir, name, expected) {
    const doc = await readJson(path.join(dir, name), null);
    if (!doc?.base64) throw new Error(`Temporal parity shard missing: ${name}`);
    const buf = Buffer.from(doc.base64, 'base64');
    if (sha(buf) !== expected) throw new Error(`Temporal parity shard corrupt: ${name}`);
    return buf;
  }

  async inspect(id = null) {
    const { dir, manifest } = await this.loadWindow(id);
    const states = [];
    for (const spec of manifest.dataEpochs) {
      const file = path.join(this.epochDir, spec.file);
      try {
        const buf = await fsp.readFile(file);
        states.push({ ...spec, state: sha(buf) === spec.sha256 ? 'GOOD' : 'CORRUPT', actualSha256: sha(buf), buffer: sha(buf) === spec.sha256 ? buf : null });
      } catch (error) { states.push({ ...spec, state: 'MISSING', error: error.message, buffer: null }); }
    }
    const parity = [];
    for (const spec of manifest.parity) {
      try { parity.push({ ...spec, state: 'GOOD', buffer: await this.parityBuffer(dir, spec.file, spec.sha256) }); }
      catch (error) { parity.push({ ...spec, state: 'BAD', error: error.message, buffer: null }); }
    }
    return { manifest, states, parity, damaged: states.filter(x => x.state !== 'GOOD').length };
  }

  recoverOne(states, p0, missing, shardSize) {
    const out = Buffer.from(p0);
    for (const state of states) {
      if (state.index === missing || !state.buffer) continue;
      const padded = Buffer.alloc(shardSize); state.buffer.copy(padded);
      for (let j = 0; j < shardSize; j++) out[j] ^= padded[j];
    }
    return out;
  }

  recoverTwo(states, p0, p1, a, b, shardSize) {
    const s0 = Buffer.from(p0);
    const s1 = Buffer.from(p1);
    for (const state of states) {
      if (state.index === a || state.index === b || !state.buffer) continue;
      const padded = Buffer.alloc(shardSize); state.buffer.copy(padded);
      const c = coefficient(state.index + 1);
      for (let j = 0; j < shardSize; j++) {
        s0[j] ^= padded[j];
        s1[j] ^= mul(padded[j], c);
      }
    }
    const ca = coefficient(a + 1), cb = coefficient(b + 1);
    const denom = ca ^ cb;
    if (!denom) throw new Error('Temporal parity coefficient collision.');
    const A = Buffer.alloc(shardSize), B = Buffer.alloc(shardSize);
    for (let j = 0; j < shardSize; j++) {
      // A + B = s0 ; ca*A + cb*B = s1
      // (ca+cb)A = s1 + cb*s0
      A[j] = div(s1[j] ^ mul(cb, s0[j]), denom);
      B[j] = s0[j] ^ A[j];
    }
    return new Map([[a, A], [b, B]]);
  }

  async recover(id = null, options = {}) {
    const inspection = await this.inspect(id);
    const bad = inspection.states.filter(x => x.state !== 'GOOD');
    if (!bad.length) return { status: 'HEALTHY', recovered: [], window: inspection.manifest.id };
    if (bad.length > 2) return { status: 'UNRECOVERABLE', reason: `${bad.length} damaged epochs exceeds dual temporal parity tolerance.`, damaged: bad.map(x => x.file) };
    const p0 = inspection.parity[0]?.buffer, p1 = inspection.parity[1]?.buffer;
    if (!p0) return { status: 'UNRECOVERABLE', reason: 'XOR temporal parity is unavailable.' };
    if (bad.length === 2 && !p1) return { status: 'UNRECOVERABLE', reason: 'Second temporal parity equation is unavailable.' };
    const recoveredMap = bad.length === 1
      ? new Map([[bad[0].index, this.recoverOne(inspection.states, p0, bad[0].index, inspection.manifest.shardSize)]])
      : this.recoverTwo(inspection.states, p0, p1, bad[0].index, bad[1].index, inspection.manifest.shardSize);
    const recovered = [];
    for (const state of bad) {
      const padded = recoveredMap.get(state.index);
      const bytes = padded.subarray(0, state.bytes);
      const actual = sha(bytes);
      if (actual !== state.sha256) return { status: 'UNRECOVERABLE', reason: `Reconstructed epoch ${state.file} failed expected SHA-256.`, expected: state.sha256, actual };
      const targetDir = path.join(this.root, 'recovered', inspection.manifest.id);
      await ensureDir(targetDir);
      const target = path.join(targetDir, state.file);
      await fsp.writeFile(target, bytes);
      recovered.push({ file: state.file, target, sha256: actual });
      if (options.repairInPlace === true) {
        const original = path.join(this.epochDir, state.file);
        const quarantine = path.join(this.root, 'quarantine', `${Date.now()}-${state.file}`);
        await ensureDir(path.dirname(quarantine));
        try { await fsp.rename(original, quarantine); } catch {}
        await fsp.writeFile(original, bytes);
      }
    }
    return {
      status: options.repairInPlace === true ? 'RECOVERED_AND_REPAIRED' : 'RECOVERED_TO_SANDBOX',
      window: inspection.manifest.id, recovered,
      doctrine: 'Default recovery is sandbox-only. In-place repair requires explicit repairInPlace=true.'
    };
  }
}

module.exports = { TemporalParityArchive, mul, div };
