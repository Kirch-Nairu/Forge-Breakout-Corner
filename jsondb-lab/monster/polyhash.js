'use strict';

const crypto = require('crypto');
const path = require('path');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

const PREFERRED = ['sha256','sha512','sha3-256','blake2b512'];

function availableAlgorithms() {
  const available = new Set(crypto.getHashes().map(x => x.toLowerCase()));
  return PREFERRED.filter(x => available.has(x));
}
function digestBuffer(buffer, algorithm) { return crypto.createHash(algorithm).update(buffer).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function bytesOf(value) { return Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(canonical(value))); }

class HashPolyglot {
  constructor(root) {
    this.root = root;
    this.policyFile = path.join(root, 'hash-policy.json');
  }

  async init() {
    await ensureDir(this.root);
    let policy = await readJson(this.policyFile, null);
    if (!policy) {
      const algorithms = availableAlgorithms();
      policy = {
        format: 'JSONDB-HASH-POLICY-1', createdAt: now(), generation: 1,
        preferred: PREFERRED,
        active: algorithms,
        minimumIndependentDigests: Math.min(3, algorithms.length),
        doctrine: 'Identity is hash-agile. No single digest algorithm is allowed to be the only survival evidence when multiple algorithms are available.',
        warning: 'Multiple classical hashes provide algorithm diversity; this is not a claim of post-quantum cryptographic security.'
      };
      await atomicJson(this.policyFile, policy);
    }
    return policy;
  }

  async envelope(value, metadata = {}) {
    const policy = await this.init();
    const buffer = bytesOf(value);
    const digests = {};
    for (const algorithm of policy.active || []) {
      try { digests[algorithm] = digestBuffer(buffer, algorithm); }
      catch { digests[algorithm] = null; }
    }
    return {
      format: 'JSONDB-HASH-POLYGLOT-1', at: now(), bytes: buffer.length,
      policyGeneration: policy.generation, minimumIndependentDigests: policy.minimumIndependentDigests,
      digests, metadata
    };
  }

  async verify(value, envelope) {
    const policy = await this.init();
    const buffer = bytesOf(value);
    const results = [];
    let valid = 0;
    let checked = 0;
    for (const [algorithm, expected] of Object.entries(envelope?.digests || {})) {
      if (!expected) { results.push({ algorithm, available: false, valid: null, reason: 'digest absent from envelope' }); continue; }
      if (!crypto.getHashes().map(x=>x.toLowerCase()).includes(algorithm.toLowerCase())) {
        results.push({ algorithm, available: false, valid: null, reason: 'algorithm unavailable in runtime' });
        continue;
      }
      const actual = digestBuffer(buffer, algorithm);
      const ok = actual === expected;
      checked++; if (ok) valid++;
      results.push({ algorithm, available: true, valid: ok, expected, actual });
    }
    const required = Math.min(Number(envelope?.minimumIndependentDigests || policy.minimumIndependentDigests || 1), checked || 1);
    const contradictions = results.filter(x => x.available && x.valid === false);
    return {
      format: 'JSONDB-HASH-POLYGLOT-VERIFY-1', at: now(),
      valid: checked >= required && valid >= required && contradictions.length === 0,
      checked, validDigests: valid, required, contradictions: contradictions.length,
      bytes: buffer.length, results,
      interpretation: contradictions.length ? 'BYTE_IDENTITY_CONTRADICTION' : checked < required ? 'INSUFFICIENT_HASH_DIVERSITY' : valid >= required ? 'DIVERSE_HASH_AGREEMENT' : 'UNTRUSTED'
    };
  }

  async rotatePolicy(active, minimumIndependentDigests = null, reason = 'operator hash agility update') {
    const current = await this.init();
    const available = new Set(availableAlgorithms());
    const requested = [...new Set((active || []).map(x => String(x).toLowerCase()))];
    if (!requested.length) throw new Error('Hash policy requires at least one active algorithm.');
    const unsupported = requested.filter(x => !available.has(x));
    if (unsupported.length) throw new Error(`Runtime does not support requested hash algorithms: ${unsupported.join(', ')}`);
    const next = {
      ...current,
      generation: Number(current.generation || 0) + 1,
      updatedAt: now(), reason,
      active: requested,
      minimumIndependentDigests: Math.max(1, Math.min(requested.length, Number(minimumIndependentDigests || Math.min(3, requested.length))))
    };
    await atomicJson(this.policyFile, next);
    return next;
  }
}

module.exports = { HashPolyglot, availableAlgorithms, digestBuffer, canonical, bytesOf, PREFERRED };
