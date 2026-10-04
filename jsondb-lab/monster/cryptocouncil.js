'use strict';

const path = require('path');
const { now, ensureDir, atomicJson, readJson } = require('./jsonfs');

class CryptographicCouncil {
  constructor({ savior, ed25519Council, hashWitnessCouncil }) {
    this.savior = savior;
    this.ed = ed25519Council;
    this.hash = hashWitnessCouncil;
    this.root = path.join(savior.root, 'cryptographic-council');
    this.rounds = path.join(this.root, 'rounds');
  }

  async init() {
    await ensureDir(this.rounds);
    await this.ed.init();
    await this.hash.init();
  }

  async attest(worldRoot, metadata = {}) {
    await this.init();
    const [ed, hash] = await Promise.all([
      this.ed.round(worldRoot, { ...metadata, family: 'ed25519' }),
      this.hash.round(worldRoot, { ...metadata, family: 'lamport-sha256' })
    ]);
    const round = {
      format: 'JSONDB-CRYPTOGRAPHIC-COUNCIL-1', at: now(), worldRoot, metadata,
      families: {
        ed25519: { valid: ed.valid, roundId: ed.statement?.roundId, validSignatures: ed.validSignatures, threshold: ed.threshold },
        lamportSha256: { valid: hash.valid, roundId: hash.statement?.roundId, validSignatures: hash.validSignatures, threshold: hash.threshold }
      },
      familyQuorum: Number(ed.valid) + Number(hash.valid),
      requiredFamilies: 2,
      doctrine: 'World-root attestation is strongest when two signature families with different cryptographic structure agree. Lamport keys are one-time and local experimental keys.'
    };
    round.valid = round.familyQuorum >= round.requiredFamilies;
    const id = `${Date.now()}-${String(ed.statement?.roundId || hash.statement?.roundId || 'round')}`;
    round.id = id;
    await atomicJson(path.join(this.rounds, `${id}.json`), round);
    await atomicJson(path.join(this.root, 'latest.json'), round);
    return round;
  }

  async verify(id = null, options = {}) {
    const readOnly = options.readOnly === true;
    if (!readOnly) await this.init();
    const record = id ? await readJson(path.join(this.rounds, `${id}.json`), null) : await readJson(path.join(this.root, 'latest.json'), null);
    if (!record) return { valid: false, status: 'ABSENT', readOnly };
    const [ed, hash] = await Promise.all([
      this.ed.verifyRound(record.families?.ed25519?.roundId || null, { readOnly }),
      this.hash.verifyRound(record.families?.lamportSha256?.roundId || null, { readOnly })
    ]);
    const roots = [ed.statement?.worldRoot, hash.statement?.worldRoot].filter(Boolean);
    const sameRoot = roots.length === 2 && roots[0] === roots[1] && roots[0] === record.worldRoot;
    const familyQuorum = Number(ed.valid) + Number(hash.valid);
    return {
      format: 'JSONDB-CRYPTOGRAPHIC-COUNCIL-VERIFY-2',
      valid: familyQuorum >= 2 && sameRoot,
      readOnly,
      worldRoot: record.worldRoot, sameRoot, familyQuorum, requiredFamilies: 2,
      ed25519: { valid: ed.valid, status: ed.status, validSignatures: ed.validSignatures, threshold: ed.threshold, worldRoot: ed.statement?.worldRoot },
      lamportSha256: { valid: hash.valid, status: hash.status, validSignatures: hash.validSignatures, threshold: hash.threshold, worldRoot: hash.statement?.worldRoot },
      status: familyQuorum >= 2 && sameRoot ? 'DUAL_FAMILY_TRUST' : familyQuorum >= 1 ? 'SINGLE_FAMILY_ONLY' : 'UNTRUSTED'
    };
  }

  async publicBundle() {
    await this.init();
    const ed = await this.ed.init();
    const hash = await this.hash.publicBundle();
    return {
      format: 'JSONDB-CRYPTOGRAPHIC-COUNCIL-PUBLIC-1', at: now(),
      ed25519: { generation: ed.generation, threshold: ed.threshold, members: ed.members.map(m => ({ id: m.id, publicKeyPem: m.publicKeyPem, revokedAt: m.revokedAt || null })) },
      lamportSha256: hash,
      warning: 'Public material only. No private signing material is included.'
    };
  }
}

module.exports = { CryptographicCouncil };
