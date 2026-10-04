'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, uuid, ensureDir, readJson, atomicJson } = require('./jsonfs');
const { canonical } = require('./truth');

function bytes(value) { return Buffer.from(JSON.stringify(canonical(value))); }
function sha(value) { return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : bytes(value)).digest(); }
function hex(value) { return sha(value).toString('hex'); }
function xorHex(a, b) {
  const A = Buffer.from(a || '00'.repeat(32), 'hex');
  const B = Buffer.from(b || '00'.repeat(32), 'hex');
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) out[i] = A[i] ^ B[i];
  return out.toString('hex');
}
function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }
function safeName(v) { return String(v || 'hologram').replace(/[^A-Za-z0-9_.-]/g, '_'); }

class SemanticHologram {
  constructor({ engine, savior }) {
    this.engine = engine;
    this.savior = savior;
    this.root = path.join(savior.root, 'semantic-holograms');
    this.records = path.join(this.root, 'records');
  }

  async init() { await ensureDir(this.records); }

  async liveWorld() {
    const catalog = await this.engine.catalog();
    const tables = {};
    for (const name of Object.keys(catalog.collections || {}).sort()) tables[name] = await this.engine.loadCurrent(name);
    return { catalog, tables };
  }

  projectionSeed(baseSeed, projection) {
    return crypto.createHash('sha256').update(`${baseSeed}:${projection}`).digest();
  }

  tableSketch(table, options = {}) {
    const width = Math.max(8, Math.min(512, Number(options.width || 64)));
    const projections = Math.max(2, Math.min(32, Number(options.projections || 8)));
    const seed = String(options.seed || 'jsondb-hologram');
    const rows = Array.isArray(table?.rows) ? table.rows : [];
    const fields = {};
    const idHashes = [];
    let rowXor = '00'.repeat(32);

    for (const row of rows) {
      const rowHash = hex(row);
      rowXor = xorHex(rowXor, rowHash);
      if (row?.id != null) idHashes.push(hex(String(row.id)));
      for (const [name, value] of Object.entries(row || {})) {
        const f = fields[name] ||= {
          present: 0, nulls: 0, types: {}, distinctHashes: new Set(),
          numeric: { count: 0, sum: 0, sumSquares: 0, min: null, max: null },
          strings: { count: 0, totalLength: 0, minLength: null, maxLength: null }
        };
        f.present++;
        if (value === null) f.nulls++;
        const t = typeOf(value); f.types[t] = (f.types[t] || 0) + 1;
        f.distinctHashes.add(hex(value).slice(0, 24));
        if (typeof value === 'number' && Number.isFinite(value)) {
          f.numeric.count++; f.numeric.sum += value; f.numeric.sumSquares += value * value;
          f.numeric.min = f.numeric.min == null ? value : Math.min(f.numeric.min, value);
          f.numeric.max = f.numeric.max == null ? value : Math.max(f.numeric.max, value);
        }
        if (typeof value === 'string') {
          f.strings.count++; f.strings.totalLength += value.length;
          f.strings.minLength = f.strings.minLength == null ? value.length : Math.min(f.strings.minLength, value.length);
          f.strings.maxLength = f.strings.maxLength == null ? value.length : Math.max(f.strings.maxLength, value.length);
        }
      }
    }

    const cookedFields = {};
    for (const [name, f] of Object.entries(fields)) {
      cookedFields[name] = {
        present: f.present, nulls: f.nulls, types: f.types,
        distinctFingerprintCount: f.distinctHashes.size,
        numeric: f.numeric.count ? f.numeric : null,
        strings: f.strings.count ? f.strings : null
      };
    }

    idHashes.sort();
    const idSetRoot = hex(idHashes);
    const vectors = [];
    for (let p = 0; p < projections; p++) {
      const vector = Array.from({ length: width }, () => ({ count: 0, xor: '00'.repeat(32), signedLo: 0 }));
      const pseed = this.projectionSeed(seed, p);
      for (const row of rows) {
        const rh = sha(row);
        const route = crypto.createHash('sha256').update(pseed).update(rh).digest();
        const bucket = route.readUInt32BE(0) % width;
        const sign = route[4] & 1 ? 1 : -1;
        const slot = vector[bucket];
        slot.count++;
        slot.xor = xorHex(slot.xor, rh.toString('hex'));
        slot.signedLo = (slot.signedLo + sign * rh.readUInt32BE(28)) % 4294967291;
      }
      vectors.push(vector);
    }

    return {
      name: table?.name || null,
      rows: rows.length,
      fields: cookedFields,
      idSetRoot,
      rowXor,
      sketch: { width, projections, seed, vectors },
      exactSemanticRoot: hex(rows.map(canonical).sort((a,b)=>String(a.id||'').localeCompare(String(b.id||''))))
    };
  }

  worldSketch(world, options = {}) {
    const tables = {};
    for (const name of Object.keys(world.tables || {}).sort()) tables[name] = this.tableSketch(world.tables[name], options);
    return {
      collectionNames: Object.keys(tables),
      catalogShapeHash: hex(Object.keys(world.catalog?.collections || {}).sort()),
      tables
    };
  }

  async capture(label = 'trusted-world', options = {}) {
    await this.init();
    const world = await this.liveWorld();
    const seed = options.seed || crypto.randomBytes(16).toString('hex');
    const sketch = this.worldSketch(world, { ...options, seed });
    const record = {
      format: 'JSONDB-SEMANTIC-HOLOGRAM-1',
      id: `${Date.now()}-${uuid().slice(0,8)}`,
      label: safeName(label), capturedAt: now(),
      seed, width: Number(options.width || 64), projections: Number(options.projections || 8),
      sketch,
      warning: 'A semantic hologram is lossy validation evidence. It cannot reconstruct original rows and must never be treated as a backup.'
    };
    record.hologramHash = hex(record);
    await atomicJson(path.join(this.records, `${record.id}.json`), record);
    await atomicJson(path.join(this.root, 'latest.json'), record);
    return record;
  }

  similarity(expected, actual) {
    const details = [];
    let possible = 0, earned = 0;
    const award = (name, weight, ok, data = null) => { possible += weight; if (ok) earned += weight; details.push({ name, weight, ok, data }); };
    award('row-count', 10, expected.rows === actual.rows, { expected: expected.rows, actual: actual.rows });
    award('id-set-root', 20, expected.idSetRoot === actual.idSetRoot);
    award('row-xor', 10, expected.rowXor === actual.rowXor);
    award('exact-semantic-root', 30, expected.exactSemanticRoot === actual.exactSemanticRoot);
    const fields = new Set([...Object.keys(expected.fields || {}), ...Object.keys(actual.fields || {})]);
    let fieldMatches = 0;
    for (const name of fields) if (JSON.stringify(expected.fields?.[name] || null) === JSON.stringify(actual.fields?.[name] || null)) fieldMatches++;
    const fieldRatio = fields.size ? fieldMatches / fields.size : 1;
    possible += 15; earned += 15 * fieldRatio; details.push({ name: 'field-profile-ratio', weight: 15, ok: fieldRatio === 1, data: fieldRatio });
    const expVectors = expected.sketch?.vectors || [], actVectors = actual.sketch?.vectors || [];
    let same = 0, total = 0;
    for (let p = 0; p < Math.min(expVectors.length, actVectors.length); p++) {
      for (let i = 0; i < Math.min(expVectors[p].length, actVectors[p].length); i++) {
        total++;
        if (JSON.stringify(expVectors[p][i]) === JSON.stringify(actVectors[p][i])) same++;
      }
    }
    const sketchRatio = total ? same / total : 0;
    possible += 15; earned += 15 * sketchRatio; details.push({ name: 'seeded-projection-ratio', weight: 15, ok: sketchRatio === 1, data: sketchRatio });
    return { score: possible ? Math.round(earned / possible * 10000) / 100 : 0, details };
  }

  async compare(world, id = null, options = {}) {
    const readOnly = options.readOnly === true;
    if (!readOnly) await this.init();
    const record = id ? await readJson(path.join(this.records, `${id}.json`), null) : await readJson(path.join(this.root, 'latest.json'), null);
    if (!record) return { status: 'ABSENT', confidence: 0, readOnly };
    const candidate = world || await this.liveWorld();
    const actual = this.worldSketch(candidate, { seed: record.seed, width: record.width, projections: record.projections });
    const names = new Set([...Object.keys(record.sketch.tables || {}), ...Object.keys(actual.tables || {})]);
    const tables = {};
    let total = 0;
    for (const name of names) {
      if (!record.sketch.tables?.[name] || !actual.tables?.[name]) { tables[name] = { score: 0, reason: 'collection missing on one side' }; continue; }
      tables[name] = this.similarity(record.sketch.tables[name], actual.tables[name]); total += tables[name].score;
    }
    const confidence = names.size ? Math.round(total / names.size * 100) / 100 : 100;
    let status = 'ALIEN';
    if (confidence === 100) status = 'IDENTICAL_SHADOW';
    else if (confidence >= 90) status = 'NEAR_SHADOW';
    else if (confidence >= 70) status = 'PARTIAL_SHADOW';
    else if (confidence >= 40) status = 'WEAK_RESEMBLANCE';
    return {
      format: 'JSONDB-SEMANTIC-HOLOGRAM-COMPARE-2', hologramId: record.id,
      readOnly, status, confidence, collectionCount: names.size, tables,
      doctrine: 'Hologram similarity is corroborating evidence only. It cannot authorize promotion and cannot invent missing records.'
    };
  }
}

module.exports = { SemanticHologram };
