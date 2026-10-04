'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson, appendJsonl, readJsonl } = require('./jsonfs');
const { canonical } = require('./truth');

function semanticHash(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function canonicalBytes(value) { return Buffer.from(JSON.stringify(canonical(value))); }

class FormatPolyglotCapsule {
  constructor(engine, savior) {
    this.engine = engine;
    this.savior = savior;
    this.root = path.join(savior.root, 'format-polyglot');
    this.generations = path.join(this.root, 'generations');
  }

  async init() { await ensureDir(this.generations); }

  async world() {
    const catalog = await this.engine.catalog();
    const meta = await this.engine.meta();
    const tables = {};
    for (const name of Object.keys(catalog.collections || {}).sort()) tables[name] = await this.engine.loadCurrent(name);
    return { format: 'JSONDB-FORMAT-POLYGLOT-WORLD-1', catalog, meta, tables };
  }

  async archive(label = 'format-polyglot') {
    await this.init();
    const world = canonical(await this.world());
    const bytes = canonicalBytes(world);
    const expectedSemanticHash = semanticHash(world);
    const id = `${Date.now()}-${expectedSemanticHash.slice(0,12)}`;
    const dir = path.join(this.generations, id);
    await ensureDir(dir);

    await atomicJson(path.join(dir, 'direct.json'), { format: 'JSONDB-DIRECT-WORLD-1', world });
    await atomicJson(path.join(dir, 'base64.json'), { format: 'JSONDB-BASE64-WORLD-1', bytes: bytes.length, base64: bytes.toString('base64') });
    const hex = bytes.toString('hex');
    const hexChunks = [];
    for (let i = 0; i < hex.length; i += 8192) hexChunks.push(hex.slice(i, i + 8192));
    await atomicJson(path.join(dir, 'hex.json'), { format: 'JSONDB-HEX-WORLD-1', bytes: bytes.length, chunks: hexChunks });

    const recordsFile = path.join(dir, 'records.jsonl');
    await fsp.writeFile(recordsFile, '', 'utf8');
    await appendJsonl(recordsFile, { type: 'header', format: world.format, catalog: world.catalog, meta: world.meta });
    for (const [name, table] of Object.entries(world.tables || {})) {
      await appendJsonl(recordsFile, { type: 'table-meta', collection: name, name: table.name, meta: table.meta });
      for (const row of table.rows || []) await appendJsonl(recordsFile, { type: 'row', collection: name, row });
    }

    const manifest = {
      format: 'JSONDB-FORMAT-POLYGLOT-CAPSULE-1', id, label, createdAt: now(),
      expectedSemanticHash, canonicalBytes: bytes.length,
      quorum: 3,
      representations: ['direct-json','base64-json','hex-json','record-jsonl'],
      doctrine: 'Three of four representation decoders must reconstruct the same expected semantic world before the capsule is trusted.'
    };
    await atomicJson(path.join(dir, 'manifest.json'), manifest);
    await atomicJson(path.join(this.root, 'latest.json'), manifest);
    return manifest;
  }

  async decodeDirect(dir) {
    const doc = await readJson(path.join(dir, 'direct.json'), null);
    if (!doc?.world) throw new Error('direct world missing');
    return doc.world;
  }

  async decodeBase64(dir) {
    const doc = await readJson(path.join(dir, 'base64.json'), null);
    if (!doc?.base64) throw new Error('base64 world missing');
    return JSON.parse(Buffer.from(doc.base64, 'base64').toString('utf8'));
  }

  async decodeHex(dir) {
    const doc = await readJson(path.join(dir, 'hex.json'), null);
    if (!Array.isArray(doc?.chunks)) throw new Error('hex chunks missing');
    return JSON.parse(Buffer.from(doc.chunks.join(''), 'hex').toString('utf8'));
  }

  async decodeRecords(dir) {
    const records = await readJsonl(path.join(dir, 'records.jsonl'));
    if (records.some(x => x.__corrupt)) throw new Error('record JSONL contains corrupt lines');
    const header = records.find(x => x.type === 'header');
    if (!header) throw new Error('record header missing');
    const world = { format: header.format, catalog: header.catalog, meta: header.meta, tables: {} };
    for (const record of records) {
      if (record.type === 'table-meta') world.tables[record.collection] = { name: record.name || record.collection, meta: record.meta || {}, rows: [] };
      if (record.type === 'row') {
        world.tables[record.collection] ||= { name: record.collection, meta: {}, rows: [] };
        world.tables[record.collection].rows.push(record.row);
      }
    }
    return canonical(world);
  }

  async verify(id = null) {
    await this.init();
    const manifest = id ? await readJson(path.join(this.generations, id, 'manifest.json'), null) : await readJson(path.join(this.root, 'latest.json'), null);
    if (!manifest) return { status: 'ABSENT', trusted: false, reason: 'No format-polyglot capsule.' };
    const dir = path.join(this.generations, manifest.id);
    const decoders = [
      ['direct-json', () => this.decodeDirect(dir)],
      ['base64-json', () => this.decodeBase64(dir)],
      ['hex-json', () => this.decodeHex(dir)],
      ['record-jsonl', () => this.decodeRecords(dir)]
    ];
    const results = [];
    for (const [name, fn] of decoders) {
      try {
        const world = canonical(await fn());
        const hash = semanticHash(world);
        results.push({ name, ok: true, hash, matchesExpected: hash === manifest.expectedSemanticHash, world });
      } catch (error) {
        results.push({ name, ok: false, hash: null, matchesExpected: false, error: error.message, world: null });
      }
    }
    const votes = new Map();
    for (const r of results.filter(x => x.ok)) votes.set(r.hash, (votes.get(r.hash) || 0) + 1);
    const ranking = [...votes.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]));
    const winner = ranking[0] || null;
    const trusted = Boolean(winner && winner[1] >= Number(manifest.quorum || 3) && winner[0] === manifest.expectedSemanticHash);
    return {
      format: 'JSONDB-FORMAT-POLYGLOT-VERIFY-1', id: manifest.id,
      status: trusted ? 'TRUSTED' : winner && winner[0] === manifest.expectedSemanticHash ? 'DEGRADED' : 'LOST',
      trusted, expectedSemanticHash: manifest.expectedSemanticHash,
      winner: winner ? { hash: winner[0], votes: winner[1] } : null,
      quorum: manifest.quorum,
      decoders: results.map(({world,...x})=>x),
      _worlds: results
    };
  }

  async restore(target, id = null, options = {}) {
    const verification = await this.verify(id);
    if (verification.status === 'LOST') throw new Error('Format-polyglot capsule has no trustworthy semantic winner.');
    if (verification.status === 'DEGRADED' && options.allowDegraded !== true) throw new Error('Format-polyglot recovery is degraded; explicit override required.');
    const source = verification._worlds.find(x => x.ok && x.hash === verification.expectedSemanticHash && x.world);
    if (!source) throw new Error('No expected semantic world available.');
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, `${JSON.stringify(canonical(source.world), null, 2)}\n`, 'utf8');
    return { target, id: verification.id, status: verification.status, decoder: source.name, semanticHash: verification.expectedSemanticHash };
  }
}

module.exports = { FormatPolyglotCapsule, semanticHash, canonicalBytes };
