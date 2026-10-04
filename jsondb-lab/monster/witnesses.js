'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, uuid, ensureDir, readJson, atomicJson } = require('./jsonfs');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function messageBytes(statement) { return Buffer.from(JSON.stringify(canonical(statement))); }

class WitnessCouncil {
  constructor(root, count = 7, threshold = 5) {
    this.root = root;
    this.keys = path.join(root, 'keys');
    this.rounds = path.join(root, 'rounds');
    this.councilFile = path.join(root, 'council.json');
    this.count = Math.max(3, Number(count || 7));
    this.threshold = Math.max(2, Math.min(this.count, Number(threshold || 5)));
  }

  async init() {
    await ensureDir(this.keys);
    await ensureDir(this.rounds);
    let council = await readJson(this.councilFile, null);
    if (!council) {
      const members = [];
      for (let i = 0; i < this.count; i++) {
        const id = `witness-${String(i + 1).padStart(2, '0')}`;
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const record = {
          format: 'JSONDB-WITNESS-KEY-1', id, createdAt: now(), revokedAt: null,
          publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
          privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' })
        };
        await atomicJson(path.join(this.keys, `${id}.json`), record);
        members.push({ id, publicKeyPem: record.publicKeyPem, createdAt: record.createdAt });
      }
      council = {
        format: 'JSONDB-WITNESS-COUNCIL-1', createdAt: now(), generation: 1,
        threshold: this.threshold, members,
        warning: 'Keys are local experimental witnesses, not hardware-backed independent trust domains.'
      };
      await atomicJson(this.councilFile, council);
    }
    return council;
  }

  async key(id) {
    const record = await readJson(path.join(this.keys, `${id}.json`), null);
    if (!record) throw new Error(`Witness not found: ${id}`);
    return record;
  }

  async sign(id, statement) {
    const key = await this.key(id);
    if (key.revokedAt) throw new Error(`Witness revoked: ${id}`);
    const signature = crypto.sign(null, messageBytes(statement), crypto.createPrivateKey(key.privateKeyPem));
    return { witness: id, signature: signature.toString('base64'), publicKeyFingerprint: crypto.createHash('sha256').update(key.publicKeyPem).digest('hex') };
  }

  verifySignature(statement, attestation, member) {
    try {
      return crypto.verify(null, messageBytes(statement), crypto.createPublicKey(member.publicKeyPem), Buffer.from(attestation.signature, 'base64'));
    } catch { return false; }
  }

  async round(worldRoot, metadata = {}) {
    const council = await this.init();
    const statement = {
      format: 'JSONDB-WORLD-ATTESTATION-1', roundId: uuid(), councilGeneration: council.generation,
      at: now(), worldRoot, metadata
    };
    const attestations = [];
    for (const member of council.members) attestations.push(await this.sign(member.id, statement));
    const record = { format: 'JSONDB-WITNESS-ROUND-1', statement, attestations };
    await atomicJson(path.join(this.rounds, `${statement.roundId}.json`), record);
    await atomicJson(path.join(this.root, 'latest-round.json'), record);
    return this.verifyRound(record);
  }

  async verifyRound(roundOrId = null, options = {}) {
    const readOnly = options.readOnly === true;
    const council = readOnly ? await readJson(this.councilFile, null) : await this.init();
    if (!council) return { valid: false, status: 'ABSENT', readOnly, reason: 'witness council not found', threshold: this.threshold };
    let round = roundOrId;
    if (!roundOrId) round = await readJson(path.join(this.root, 'latest-round.json'), null);
    else if (typeof roundOrId === 'string') round = await readJson(path.join(this.rounds, `${roundOrId}.json`), null);
    if (!round) return { valid: false, status: 'ABSENT', readOnly, reason: 'round not found', threshold: council.threshold };
    const results = [];
    const seen = new Set();
    for (const att of round.attestations || []) {
      const member = council.members.find(m => m.id === att.witness);
      const valid = Boolean(member && !member.revokedAt && !seen.has(att.witness) && this.verifySignature(round.statement, att, member));
      if (valid) seen.add(att.witness);
      results.push({ witness: att.witness, valid });
    }
    const validSignatures = results.filter(x => x.valid).length;
    return {
      format: 'JSONDB-WITNESS-VERIFY-2',
      valid: validSignatures >= council.threshold,
      status: validSignatures >= council.threshold ? 'THRESHOLD_VALID' : 'INSUFFICIENT_VALID_SIGNATURES',
      readOnly,
      threshold: council.threshold, memberCount: council.members.length,
      validSignatures, invalidSignatures: results.length - validSignatures,
      statement: round.statement, results
    };
  }

  async revoke(id, reason = 'operator revocation') {
    const key = await this.key(id);
    key.revokedAt = now(); key.revocationReason = reason;
    await atomicJson(path.join(this.keys, `${id}.json`), key);
    const council = await this.init();
    const member = council.members.find(m => m.id === id);
    if (member) { member.revokedAt = key.revokedAt; member.revocationReason = reason; }
    council.generation++;
    council.updatedAt = now();
    await atomicJson(this.councilFile, council);
    return { id, revokedAt: key.revokedAt, councilGeneration: council.generation };
  }
}

module.exports = { WitnessCouncil, canonical, messageBytes };
