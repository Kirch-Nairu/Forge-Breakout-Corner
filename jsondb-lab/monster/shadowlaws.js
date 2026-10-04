'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');
const { canonical } = require('./truth');

const PRIME = (1n << 61n) - 1n;
function sha(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest(); }
function hex(value) { return sha(value).toString('hex'); }
function modBytes(buf) {
  let x = 0n;
  for (const byte of buf) x = ((x << 8n) + BigInt(byte)) % PRIME;
  return x;
}
function fingerprint(row) { return modBytes(sha(canonical(row))); }
function coefficient(seed, collection, law, rowId) {
  const h = crypto.createHmac('sha256', Buffer.from(seed, 'hex'));
  h.update(`${collection}\0${law}\0${rowId}`);
  return (modBytes(h.digest()) || 1n);
}
function recordHash(record) {
  const copy = { ...record }; delete copy.recordHash; delete copy.attestation;
  return hex(copy);
}

class ShadowLawEngine {
  constructor({ engine, savior, cryptoCouncil }) {
    this.engine = engine;
    this.savior = savior;
    this.cryptoCouncil = cryptoCouncil;
    this.root = path.join(savior.root, 'shadow-laws');
    this.records = path.join(this.root, 'records');
  }

  async init() { await ensureDir(this.records); }

  async liveWorld() {
    const catalog = await this.engine.catalog();
    const tables = {};
    for (const name of Object.keys(catalog.collections || {}).sort()) tables[name] = await this.engine.loadCurrent(name);
    return { catalog, tables };
  }

  tableRows(world, name) {
    const table = world.tables?.[name];
    return Array.isArray(table?.rows) ? [...table.rows].sort((a,b)=>String(a.id||'').localeCompare(String(b.id||''))) : [];
  }

  residue(rows, collection, lawIndex, seed) {
    let acc = 0n;
    let count = 0n;
    let idAcc = 0n;
    for (const row of rows) {
      const id = String(row?.id ?? '');
      const c = coefficient(seed, collection, lawIndex, id);
      const f = fingerprint(row);
      acc = (acc + c * f) % PRIME;
      idAcc = (idAcc + c * modBytes(sha(id))) % PRIME;
      count++;
    }
    return { residue: acc.toString(), idResidue: idAcc.toString(), rows: Number(count) };
  }

  async capture(label = 'shadow-laws', options = {}) {
    await this.init();
    const world = await this.liveWorld();
    const lawsPerCollection = Math.max(2, Math.min(64, Number(options.lawsPerCollection || 12)));
    const seeds = Array.from({ length: lawsPerCollection }, () => crypto.randomBytes(32).toString('hex'));
    const collections = {};
    for (const name of Object.keys(world.tables || {}).sort()) {
      const rows = this.tableRows(world, name);
      collections[name] = {
        rows: rows.length,
        laws: seeds.map((seed, i) => ({ index: i, seed, ...this.residue(rows, name, i, seed) }))
      };
    }
    const record = {
      format: 'JSONDB-SHADOW-LAWS-1',
      id: `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
      label, createdAt: now(), prime: PRIME.toString(),
      algorithm: 'Random HMAC-SHA256 row coefficients and SHA-256 row fingerprints accumulated modulo 2^61-1.',
      collections,
      note: 'Seeds are revealed in the record so independent future implementations can verify candidates. Security comes from post-state randomization plus attestation/offline preservation, not permanent secrecy.'
    };
    record.recordHash = recordHash(record);
    record.attestation = await this.cryptoCouncil.attest(record.recordHash, {
      purpose: 'shadow-laws', label, lawRecordId: record.id,
      collections: Object.keys(collections).length, lawsPerCollection
    });
    await atomicJson(path.join(this.records, `${record.id}.json`), record);
    await atomicJson(path.join(this.root, 'latest.json'), record);
    return record;
  }

  async load(id = null) {
    await this.init();
    return id ? readJson(path.join(this.records, `${id}.json`), null) : readJson(path.join(this.root, 'latest.json'), null);
  }

  async verifyRecord(id = null) {
    const record = await this.load(id);
    if (!record) return { valid: false, status: 'ABSENT' };
    const actual = recordHash(record);
    const attestation = record.attestation?.id ? await this.cryptoCouncil.verify(record.attestation.id).catch(error => ({ valid: false, error: error.message })) : { valid: false, error: 'missing attestation' };
    const sameAttestedRoot = attestation.worldRoot === record.recordHash;
    return { valid: actual === record.recordHash && attestation.valid === true && sameAttestedRoot, id: record.id, expected: record.recordHash, actual, attestation, sameAttestedRoot };
  }

  async challenge(world = null, id = null) {
    const record = await this.load(id);
    if (!record) return { status: 'ABSENT', confidence: 0 };
    const recordCheck = await this.verifyRecord(record.id);
    if (!recordCheck.valid) return { status: 'LAW_RECORD_UNTRUSTED', confidence: 0, recordCheck };
    const candidate = world || await this.liveWorld();
    const results = [];
    let total = 0, passed = 0;
    for (const [name, spec] of Object.entries(record.collections || {})) {
      const rows = this.tableRows(candidate, name);
      for (const law of spec.laws || []) {
        total++;
        const actual = this.residue(rows, name, law.index, law.seed);
        const ok = actual.residue === law.residue && actual.idResidue === law.idResidue && actual.rows === law.rows;
        if (ok) passed++;
        results.push({ collection: name, law: law.index, ok, expected: { residue: law.residue, idResidue: law.idResidue, rows: law.rows }, actual });
      }
    }
    const confidence = total ? Math.round(passed / total * 10000) / 100 : 100;
    return {
      format: 'JSONDB-SHADOW-LAW-CHALLENGE-1', lawRecordId: record.id,
      status: passed === total ? 'SATISFIED' : passed ? 'PARTIAL_FAILURE' : 'FAILED',
      confidence, passed, total, failed: results.filter(x=>!x.ok),
      doctrine: 'Shadow Laws are randomized corroboration. They may reject a candidate; satisfying them does not alone authorize promotion.'
    };
  }
}

module.exports = { ShadowLawEngine, PRIME };
