'use strict';

const crypto = require('crypto');
const path = require('path');
const { now, uuid, ensureDir, readJson, atomicJson } = require('./jsonfs');

function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest(); }
function hex(buffer) { return Buffer.from(buffer).toString('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function messageDigest(statement) { return sha(Buffer.from(JSON.stringify(canonical(statement)))); }
function bits(buffer) {
  const out = [];
  for (const byte of buffer) for (let i = 7; i >= 0; i--) out.push((byte >> i) & 1);
  return out;
}

function generateLamportKey(id) {
  const privatePairs = [];
  const publicPairs = [];
  for (let i = 0; i < 256; i++) {
    const zero = crypto.randomBytes(32);
    const one = crypto.randomBytes(32);
    privatePairs.push([zero.toString('base64'), one.toString('base64')]);
    publicPairs.push([hex(sha(zero)), hex(sha(one))]);
  }
  const publicRoot = hex(sha(Buffer.from(JSON.stringify(publicPairs))));
  return {
    privateKey: {
      format: 'JSONDB-LAMPORT-PRIVATE-1', id, createdAt: now(), spentAt: null,
      warning: 'ONE-TIME KEY. Reusing a Lamport key leaks secret material.',
      pairs: privatePairs
    },
    publicKey: {
      format: 'JSONDB-LAMPORT-PUBLIC-1', id, createdAt: now(), publicRoot,
      pairs: publicPairs
    }
  };
}

function signLamport(privateKey, statement) {
  if (privateKey.spentAt) throw new Error(`Lamport key ${privateKey.id} is already spent.`);
  const digest = messageDigest(statement);
  const signature = bits(digest).map((bit, i) => privateKey.pairs[i][bit]);
  return {
    format: 'JSONDB-LAMPORT-SIGNATURE-1', keyId: privateKey.id,
    digest: hex(digest), signature
  };
}

function verifyLamport(publicKey, statement, attestation) {
  if (!publicKey || !attestation || publicKey.id !== attestation.keyId) return false;
  const digest = messageDigest(statement);
  if (hex(digest) !== attestation.digest) return false;
  const digestBits = bits(digest);
  if (!Array.isArray(attestation.signature) || attestation.signature.length !== 256) return false;
  for (let i = 0; i < 256; i++) {
    let revealed;
    try { revealed = Buffer.from(attestation.signature[i], 'base64'); }
    catch { return false; }
    const expected = publicKey.pairs?.[i]?.[digestBits[i]];
    if (!expected || hex(sha(revealed)) !== expected) return false;
  }
  return true;
}

class HashWitnessCouncil {
  constructor(root, options = {}) {
    this.root = root;
    this.keys = path.join(root, 'keys');
    this.rounds = path.join(root, 'rounds');
    this.registry = path.join(root, 'registry.json');
    this.members = Math.max(3, Number(options.members || 5));
    this.threshold = Math.max(2, Math.min(this.members, Number(options.threshold || 3)));
    this.reservePerMember = Math.max(2, Math.min(64, Number(options.reservePerMember || 8)));
  }

  async init() {
    await ensureDir(this.keys);
    await ensureDir(this.rounds);
    let registry = await readJson(this.registry, null);
    if (!registry) {
      registry = {
        format: 'JSONDB-HASH-WITNESS-COUNCIL-1', createdAt: now(), generation: 1,
        members: [], threshold: this.threshold,
        doctrine: 'Lamport signatures are one-time hash-based signatures. This is an educational local implementation, not a certified post-quantum product.'
      };
      for (let i = 0; i < this.members; i++) registry.members.push({ id: `hash-witness-${String(i + 1).padStart(2,'0')}`, nextOrdinal: 1, publicKeys: [] });
      await atomicJson(this.registry, registry);
      await this.replenishAll(this.reservePerMember);
      registry = await readJson(this.registry, registry);
    }
    return registry;
  }

  async generateForMember(memberId, count = 1) {
    const registry = await readJson(this.registry, null);
    if (!registry) throw new Error('Hash witness registry is not initialized.');
    const member = registry.members.find(x => x.id === memberId);
    if (!member) throw new Error(`Unknown hash witness member ${memberId}`);
    for (let n = 0; n < count; n++) {
      const ordinal = Number(member.nextOrdinal || 1)++;
      const keyId = `${member.id}-ots-${String(ordinal).padStart(6,'0')}`;
      const pair = generateLamportKey(keyId);
      await atomicJson(path.join(this.keys, `${keyId}.private.json`), pair.privateKey);
      await atomicJson(path.join(this.keys, `${keyId}.public.json`), pair.publicKey);
      member.publicKeys.push({ keyId, publicRoot: pair.publicKey.publicRoot, createdAt: pair.publicKey.createdAt, spentAt: null });
    }
    registry.updatedAt = now();
    await atomicJson(this.registry, registry);
    return member;
  }

  async replenishAll(target = this.reservePerMember) {
    let registry = await readJson(this.registry, null);
    if (!registry) return;
    for (const member of registry.members) {
      const available = (member.publicKeys || []).filter(x => !x.spentAt).length;
      if (available < target) await this.generateForMember(member.id, target - available);
      registry = await readJson(this.registry, registry);
    }
  }

  async nextKey(member) {
    const candidate = (member.publicKeys || []).find(x => !x.spentAt);
    if (!candidate) {
      await this.generateForMember(member.id, this.reservePerMember);
      const registry = await readJson(this.registry, null);
      member = registry.members.find(x => x.id === member.id);
      return (member.publicKeys || []).find(x => !x.spentAt);
    }
    return candidate;
  }

  async signMember(memberId, statement) {
    let registry = await this.init();
    let member = registry.members.find(x => x.id === memberId);
    const slot = await this.nextKey(member);
    const privateFile = path.join(this.keys, `${slot.keyId}.private.json`);
    const privateKey = await readJson(privateFile, null);
    if (!privateKey) throw new Error(`Missing Lamport private key ${slot.keyId}`);
    const signature = signLamport(privateKey, statement);
    privateKey.spentAt = now();
    await atomicJson(privateFile, privateKey);

    registry = await readJson(this.registry, registry);
    member = registry.members.find(x => x.id === memberId);
    const registrySlot = member.publicKeys.find(x => x.keyId === slot.keyId);
    registrySlot.spentAt = privateKey.spentAt;
    await atomicJson(this.registry, registry);
    return { memberId, keyId: slot.keyId, publicRoot: slot.publicRoot, signature };
  }

  async publicKey(keyId) { return readJson(path.join(this.keys, `${keyId}.public.json`), null); }

  async round(worldRoot, metadata = {}) {
    let registry = await this.init();
    const statement = {
      format: 'JSONDB-HASH-WORLD-ATTESTATION-1', roundId: uuid(), at: now(),
      councilGeneration: registry.generation, worldRoot, metadata
    };
    const attestations = [];
    for (const member of registry.members) attestations.push(await this.signMember(member.id, statement));
    const record = { format: 'JSONDB-HASH-WITNESS-ROUND-1', statement, threshold: registry.threshold, attestations };
    await atomicJson(path.join(this.rounds, `${statement.roundId}.json`), record);
    await atomicJson(path.join(this.root, 'latest-round.json'), record);
    await this.replenishAll(this.reservePerMember);
    return this.verifyRound(record);
  }

  async verifyRound(roundOrId = null) {
    const registry = await this.init();
    let round = roundOrId;
    if (!roundOrId) round = await readJson(path.join(this.root, 'latest-round.json'), null);
    else if (typeof roundOrId === 'string') round = await readJson(path.join(this.rounds, `${roundOrId}.json`), null);
    if (!round) return { valid: false, reason: 'round not found', threshold: registry.threshold };
    const seenMembers = new Set();
    const results = [];
    for (const att of round.attestations || []) {
      const publicKey = await this.publicKey(att.keyId);
      const valid = Boolean(publicKey && !seenMembers.has(att.memberId) && verifyLamport(publicKey, round.statement, att.signature));
      if (valid) seenMembers.add(att.memberId);
      results.push({ memberId: att.memberId, keyId: att.keyId, publicRoot: att.publicRoot, valid });
    }
    const validSignatures = results.filter(x => x.valid).length;
    const threshold = Number(round.threshold || registry.threshold);
    return {
      format: 'JSONDB-HASH-WITNESS-VERIFY-1', valid: validSignatures >= threshold,
      validSignatures, threshold, memberCount: registry.members.length,
      statement: round.statement, results,
      warning: 'Hash-based one-time signatures reduce signature-family monoculture. Local keys are still not independent hardware trust domains.'
    };
  }

  async publicBundle() {
    const registry = await this.init();
    const keys = [];
    for (const member of registry.members) for (const slot of member.publicKeys || []) {
      const publicKey = await this.publicKey(slot.keyId);
      if (publicKey) keys.push(publicKey);
    }
    return {
      format: 'JSONDB-HASH-WITNESS-PUBLIC-BUNDLE-1', at: now(),
      threshold: registry.threshold,
      members: registry.members.map(x => ({ id: x.id, publicKeys: x.publicKeys })),
      publicKeys: keys
    };
  }
}

module.exports = {
  HashWitnessCouncil, generateLamportKey, signLamport, verifyLamport,
  messageDigest, bits
};
