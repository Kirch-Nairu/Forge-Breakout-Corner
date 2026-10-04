'use strict';

const crypto = require('crypto');
const path = require('path');
const { now, ensureDir, atomicJson } = require('./jsonfs');

function isRowArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(x => x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string');
}
function orderedArray(value) { return isRowArray(value) ? [...value].sort((a,b)=>a.id.localeCompare(b.id)) : value; }
function hash(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

function canonicalObject(value) {
  if (Array.isArray(value)) return orderedArray(value).map(canonicalObject);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalObject(value[key]);
    return out;
  }
  return value;
}
function canonicalA(value) { return JSON.stringify(canonicalObject(value)); }

function direct(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${orderedArray(value).map(direct).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${direct(value[key])}`).join(',')}}`;
  return JSON.stringify(null);
}
function canonicalB(value) { return direct(value); }

function buildTuple(value) {
  if (value === null) return ['scalar', null];
  if (Array.isArray(value)) return ['array', orderedArray(value).map(buildTuple)];
  if (value && typeof value === 'object') return ['object', Object.keys(value).sort().map(key => [key, buildTuple(value[key])])];
  return ['scalar', value];
}
function emitTuple(node) {
  const [type, payload] = node;
  if (type === 'scalar') return JSON.stringify(payload);
  if (type === 'array') return `[${payload.map(emitTuple).join(',')}]`;
  if (type === 'object') return `{${payload.map(([key, child]) => `${JSON.stringify(key)}:${emitTuple(child)}`).join(',')}}`;
  throw new Error(`Unknown canonical tuple node ${type}`);
}
function canonicalC(value) { return emitTuple(buildTuple(value)); }

class CanonicalizationQuorum {
  constructor(savior = null) {
    this.savior = savior;
    this.root = savior ? path.join(savior.root, 'canonicalization-quorum') : null;
  }

  async init() { if (this.root) await ensureDir(this.root); }

  fingerprint(value) {
    const outputs = [
      { implementation: 'recursive-object-normalizer', text: canonicalA(value) },
      { implementation: 'direct-stream-serializer', text: canonicalB(value) },
      { implementation: 'tuple-tree-emitter', text: canonicalC(value) }
    ].map(x => ({ ...x, sha256: hash(x.text), bytes: Buffer.byteLength(x.text) }));
    const unanimous = new Set(outputs.map(x=>x.sha256)).size === 1 && new Set(outputs.map(x=>x.text)).size === 1;
    return {
      format: 'JSONDB-CANONICAL-QUORUM-1', at: now(), unanimous,
      semanticSha256: unanimous ? outputs[0].sha256 : null,
      bytes: unanimous ? outputs[0].bytes : null,
      outputs: outputs.map(({text,...x})=>x),
      _texts: outputs.map(x=>({ implementation: x.implementation, text: x.text }))
    };
  }

  async verify(value, options = {}) {
    await this.init();
    const result = this.fingerprint(value);
    if (this.root) {
      const persisted = { ...result }; delete persisted._texts;
      await atomicJson(path.join(this.root, 'latest.json'), persisted);
    }
    if (!result.unanimous && this.savior && options.freezeOnDivergence !== false) {
      await this.savior.setMode('read-only', 'Canonicalization quorum diverged: semantic identity algorithm disagreement.');
    }
    return result;
  }
}

module.exports = {
  CanonicalizationQuorum,
  canonicalA, canonicalB, canonicalC,
  canonicalObject, buildTuple, emitTuple
};
