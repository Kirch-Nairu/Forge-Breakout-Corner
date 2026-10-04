'use strict';

const crypto = require('crypto');
const path = require('path');
const fsp = require('fs/promises');
const { now, uuid, ensureDir, readJson, atomicJson, hashFile } = require('./jsonfs');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function bytes(value) { return Buffer.from(JSON.stringify(canonical(value))); }
function digest(value) { return crypto.createHash('sha256').update(bytes(value)).digest('hex'); }

class PromotionCeremony {
  constructor(savior, options = {}) {
    this.savior = savior;
    this.root = path.join(savior.root, 'promotion-ceremony');
    this.keys = path.join(this.root, 'operator-keys');
    this.proposals = path.join(this.root, 'proposals');
    this.certificates = path.join(this.root, 'certificates');
    this.operatorCount = Math.max(3, Number(options.operatorCount || 5));
    this.threshold = Math.max(2, Math.min(this.operatorCount, Number(options.threshold || 3)));
  }

  async init() {
    await ensureDir(this.keys);
    await ensureDir(this.proposals);
    await ensureDir(this.certificates);
    let registry = await readJson(path.join(this.root, 'operators.json'), null);
    if (!registry) {
      const operators = [];
      for (let i = 0; i < this.operatorCount; i++) {
        const id = `recovery-operator-${String(i + 1).padStart(2,'0')}`;
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const key = {
          format: 'JSONDB-RECOVERY-OPERATOR-KEY-1', id, createdAt: now(), revokedAt: null,
          publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
          privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' })
        };
        await atomicJson(path.join(this.keys, `${id}.json`), key);
        operators.push({ id, publicKeyPem: key.publicKeyPem, createdAt: key.createdAt, revokedAt: null });
      }
      registry = {
        format: 'JSONDB-PROMOTION-OPERATORS-1', createdAt: now(), generation: 1,
        threshold: this.threshold, operators,
        doctrine: 'Promotion authority is separate from database write authority. Keys should be moved to separate media if real failure-domain independence is desired.'
      };
      await atomicJson(path.join(this.root, 'operators.json'), registry);
    }
    return registry;
  }

  async proposal(id) { return readJson(path.join(this.proposals, `${id}.json`), null); }

  async propose({ sandboxFile, evidence = {}, expiresMinutes = 60, target = 'canonical-world' }) {
    await this.init();
    if (!sandboxFile) throw new Error('Promotion proposal requires sandboxFile.');
    const file = path.resolve(sandboxFile);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('Promotion sandbox must be a file.');
    const sandboxSha256 = await hashFile(file);
    const id = `${Date.now()}-${uuid().slice(0,8)}`;
    const createdMs = Date.now();
    const statement = {
      format: 'JSONDB-PROMOTION-INTENT-1', id,
      createdAt: new Date(createdMs).toISOString(),
      expiresAt: new Date(createdMs + Math.max(1, Number(expiresMinutes || 60)) * 60_000).toISOString(),
      target,
      sandboxFile: file,
      sandboxSha256,
      sandboxBytes: stat.size,
      evidence,
      nonce: uuid(),
      doctrine: 'Approval certifies intent for this exact sandbox hash only. It does not execute promotion.'
    };
    const proposal = {
      format: 'JSONDB-PROMOTION-PROPOSAL-1', id, statement,
      statementHash: digest(statement), approvals: [], state: 'AWAITING_APPROVALS'
    };
    await atomicJson(path.join(this.proposals, `${id}.json`), proposal);
    await atomicJson(path.join(this.root, 'latest-proposal.json'), proposal);
    return proposal;
  }

  async operatorKey(operatorId) {
    const key = await readJson(path.join(this.keys, `${operatorId}.json`), null);
    if (!key) throw new Error(`Recovery operator not found: ${operatorId}`);
    return key;
  }

  async approve(proposalId, operatorId) {
    const registry = await this.init();
    const proposal = await this.proposal(proposalId);
    if (!proposal) throw new Error(`Promotion proposal not found: ${proposalId}`);
    if (Date.now() > Date.parse(proposal.statement.expiresAt)) throw new Error('Promotion proposal expired.');
    if (proposal.approvals.some(x => x.operatorId === operatorId)) throw new Error(`${operatorId} already approved this proposal.`);
    const member = registry.operators.find(x => x.id === operatorId && !x.revokedAt);
    if (!member) throw new Error(`Operator is missing or revoked: ${operatorId}`);
    const key = await this.operatorKey(operatorId);
    if (key.revokedAt) throw new Error(`Operator key revoked: ${operatorId}`);
    const signature = crypto.sign(null, bytes(proposal.statement), crypto.createPrivateKey(key.privateKeyPem)).toString('base64');
    proposal.approvals.push({ operatorId, signedAt: now(), signature });
    proposal.state = proposal.approvals.length >= registry.threshold ? 'THRESHOLD_REACHED_PENDING_VERIFICATION' : 'AWAITING_APPROVALS';
    await atomicJson(path.join(this.proposals, `${proposalId}.json`), proposal);
    return this.verify(proposalId);
  }

  async verify(proposalId) {
    const registry = await this.init();
    const proposal = await this.proposal(proposalId);
    if (!proposal) return { valid: false, reason: 'proposal missing' };
    const statementHash = digest(proposal.statement);
    const hashValid = statementHash === proposal.statementHash;
    const unexpired = Date.now() <= Date.parse(proposal.statement.expiresAt);
    let sandboxStillMatches = false;
    let actualSandboxHash = null;
    try {
      actualSandboxHash = await hashFile(proposal.statement.sandboxFile);
      sandboxStillMatches = actualSandboxHash === proposal.statement.sandboxSha256;
    } catch {}
    const seen = new Set();
    const approvals = [];
    for (const approval of proposal.approvals || []) {
      const member = registry.operators.find(x => x.id === approval.operatorId && !x.revokedAt);
      let valid = false;
      if (member && !seen.has(approval.operatorId)) {
        try {
          valid = crypto.verify(null, bytes(proposal.statement), crypto.createPublicKey(member.publicKeyPem), Buffer.from(approval.signature, 'base64'));
        } catch {}
      }
      if (valid) seen.add(approval.operatorId);
      approvals.push({ operatorId: approval.operatorId, signedAt: approval.signedAt, valid });
    }
    const validApprovals = approvals.filter(x => x.valid).length;
    const thresholdReached = validApprovals >= registry.threshold;
    const authorized = Boolean(hashValid && unexpired && sandboxStillMatches && thresholdReached);
    return {
      format: 'JSONDB-PROMOTION-VERIFY-1', proposalId,
      authorized, status: authorized ? 'AUTHORIZED_MANUAL_PROMOTION' : 'NOT_AUTHORIZED',
      threshold: registry.threshold, validApprovals, approvals,
      statementHashValid: hashValid, unexpired, sandboxStillMatches,
      expectedSandboxHash: proposal.statement.sandboxSha256,
      actualSandboxHash,
      doctrine: 'Even an authorized certificate does not mutate canonical state. Promotion remains an explicit separate operator act.'
    };
  }

  async certificate(proposalId) {
    const verification = await this.verify(proposalId);
    if (!verification.authorized) throw new Error('Promotion proposal is not authorized.');
    const proposal = await this.proposal(proposalId);
    const certificate = {
      format: 'JSONDB-PROMOTION-CERTIFICATE-1', certificateId: uuid(), issuedAt: now(),
      proposalId, statement: proposal.statement, statementHash: proposal.statementHash,
      approvals: proposal.approvals,
      verification,
      executable: false,
      doctrine: 'This certificate is evidence of multi-operator approval. JSONDB deliberately contains no automatic canonical-promotion method.'
    };
    certificate.certificateHash = digest(certificate);
    await atomicJson(path.join(this.certificates, `${certificate.certificateId}.json`), certificate);
    await atomicJson(path.join(this.root, 'latest-certificate.json'), certificate);
    return certificate;
  }

  async publicBundle() {
    const registry = await this.init();
    return {
      format: 'JSONDB-PROMOTION-PUBLIC-BUNDLE-1', generation: registry.generation,
      threshold: registry.threshold,
      operators: registry.operators.map(x => ({ id: x.id, publicKeyPem: x.publicKeyPem, createdAt: x.createdAt, revokedAt: x.revokedAt || null }))
    };
  }
}

module.exports = { PromotionCeremony, canonical, digest };
