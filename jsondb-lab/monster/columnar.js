'use strict';

const path = require('path');
const { ensureDir, atomicJson, readJson, now } = require('./jsonfs');
const { get } = require('./query');

function bitset(size) { return Buffer.alloc(Math.ceil(size / 8)); }
function setBit(buffer, i) { buffer[Math.floor(i / 8)] |= 1 << (i % 8); }
function hasBit(buffer, i) { return (buffer[Math.floor(i / 8)] & (1 << (i % 8))) !== 0; }

class JsonColumnStore {
  constructor(engine) {
    this.engine = engine;
    this.root = path.join(engine.data, 'advanced', 'columnar');
  }

  dir(collection) { return path.join(this.root, collection); }
  manifestFile(collection) { return path.join(this.dir(collection), 'manifest.json'); }
  columnFile(collection, field) { return path.join(this.dir(collection), 'columns', `${field.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`); }

  async build(collection, fields = null) {
    const rows = await this.engine.readAt(collection);
    if (!fields?.length) {
      const set = new Set();
      for (const row of rows) for (const field of Object.keys(row)) if (row[field] == null || ['string','number','boolean'].includes(typeof row[field])) set.add(field);
      fields = [...set];
    }
    await ensureDir(path.join(this.dir(collection), 'columns'));
    const manifest = { collection, builtAt: now(), rows: rows.length, fields: {}, rowIds: rows.map(row => row.id) };
    for (const field of fields) {
      const raw = rows.map(row => get(row, field));
      const nulls = bitset(rows.length);
      raw.forEach((v, i) => { if (v == null) setBit(nulls, i); });
      const strings = raw.filter(v => typeof v === 'string');
      const dictionaryUseful = strings.length > 0 && new Set(strings).size <= Math.max(256, Math.floor(strings.length * .7));
      let encoding = 'plain'; let data = raw; let dictionary = null;
      if (dictionaryUseful) {
        encoding = 'dictionary';
        dictionary = [...new Set(strings)].sort();
        const ids = new Map(dictionary.map((v, i) => [v, i]));
        data = raw.map(v => typeof v === 'string' ? ids.get(v) : v);
      }
      const bitmapIndexes = {};
      const distinct = [...new Set(raw.filter(v => v != null).map(v => JSON.stringify(v)))];
      if (distinct.length <= 64) {
        for (const encoded of distinct) {
          const target = JSON.parse(encoded); const bits = bitset(rows.length);
          raw.forEach((v, i) => { if (v === target) setBit(bits, i); });
          bitmapIndexes[encoded] = bits.toString('base64');
        }
      }
      const column = { field, encoding, dictionary, data, nullBitmap: nulls.toString('base64'), bitmapIndexes };
      await atomicJson(this.columnFile(collection, field), column);
      manifest.fields[field] = { encoding, distinct: distinct.length, dictionarySize: dictionary?.length || 0, bitmapValues: Object.keys(bitmapIndexes).length };
    }
    await atomicJson(this.manifestFile(collection), manifest);
    return manifest;
  }

  async loadColumn(collection, field) {
    const column = await readJson(this.columnFile(collection, field), null);
    if (!column) throw Object.assign(new Error(`Column not built: ${collection}.${field}`), { status: 404 });
    return column;
  }

  decode(column, i) {
    const nulls = Buffer.from(column.nullBitmap, 'base64');
    if (hasBit(nulls, i)) return null;
    const v = column.data[i];
    return column.encoding === 'dictionary' && typeof v === 'number' ? column.dictionary[v] : v;
  }

  async filter(collection, field, value, limit = 10000) {
    const manifest = await readJson(this.manifestFile(collection), null);
    if (!manifest) throw Object.assign(new Error('Column store not built.'), { status: 404 });
    const column = await this.loadColumn(collection, field);
    const bitmap = column.bitmapIndexes[JSON.stringify(value)];
    const positions = [];
    let examined = 0;
    if (bitmap) {
      const bits = Buffer.from(bitmap, 'base64');
      for (let i = 0; i < manifest.rows && positions.length < limit; i++) if (hasBit(bits, i)) positions.push(i);
      return { collection, field, value, algorithm: 'bitmap-index', examined: positions.length, positions, rowIds: positions.map(i => manifest.rowIds[i]) };
    }
    for (let i = 0; i < manifest.rows && positions.length < limit; i++) {
      examined++;
      if (this.decode(column, i) === value) positions.push(i);
    }
    return { collection, field, value, algorithm: 'column-vector-scan', examined, positions, rowIds: positions.map(i => manifest.rowIds[i]) };
  }

  async aggregate(collection, field, op = 'sum', filter = null) {
    const manifest = await readJson(this.manifestFile(collection), null);
    if (!manifest) throw Object.assign(new Error('Column store not built.'), { status: 404 });
    const column = await this.loadColumn(collection, field);
    let positions = Array.from({ length: manifest.rows }, (_, i) => i);
    let filterPlan = null;
    if (filter?.field) {
      filterPlan = await this.filter(collection, filter.field, filter.value, manifest.rows);
      positions = filterPlan.positions;
    }
    const values = positions.map(i => this.decode(column, i)).filter(v => v != null && (op === 'count' || typeof v === 'number'));
    let result;
    if (op === 'count') result = values.length;
    else if (op === 'sum') result = values.reduce((a, b) => a + b, 0);
    else if (op === 'avg') result = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    else if (op === 'min') result = values.length ? Math.min(...values) : null;
    else if (op === 'max') result = values.length ? Math.max(...values) : null;
    else throw Object.assign(new Error(`Unknown aggregate: ${op}`), { status: 400 });
    return { collection, field, op, rows: positions.length, filterPlan, algorithm: 'columnar-vector-ish', result };
  }

  async reconstruct(collection, positions = null, fields = null) {
    const manifest = await readJson(this.manifestFile(collection), null);
    if (!manifest) throw Object.assign(new Error('Column store not built.'), { status: 404 });
    fields ||= Object.keys(manifest.fields);
    positions ||= Array.from({ length: manifest.rows }, (_, i) => i);
    const columns = Object.fromEntries(await Promise.all(fields.map(async field => [field, await this.loadColumn(collection, field)])));
    return positions.map(i => Object.fromEntries(fields.map(field => [field, this.decode(columns[field], i)])));
  }
}

module.exports = { JsonColumnStore };
