'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson, appendJsonl, readJsonl } = require('./jsonfs');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

class AuthorityFirewall {
  constructor({ savior, contracts }) {
    this.savior = savior;
    this.contracts = contracts;
    this.root = path.join(savior.root, 'authority-firewall');
    this.ledger = path.join(this.root, 'decisions.jsonl');
    this.head = path.join(this.root, 'head.json');
  }

  async init() {
    await ensureDir(this.root);
    if (!(await readJson(this.head, null))) await atomicJson(this.head, { sequence: 0, decisionHash: null, createdAt: now() });
  }

  evaluateContract(contract, action, detail = {}) {
    if (!contract) return { allowed: false, reason: 'UNKNOWN_ACTOR_CONTRACT' };
    if (contract.mayPromoteCanonical === true) return { allowed: false, reason: 'CONTRACT_ITSELF_VIOLATES_GLOBAL_NO_AUTO_PROMOTION' };
    const reconstructs = contract.reconstructs || [];
    const corroborates = contract.corroborates || [];
    const autoRepair = contract.mayAutoRepair || [];

    if (action === 'PRESERVE_EVIDENCE') return { allowed: true, reason: 'PRESERVATION_IS_ALWAYS_WITHIN_RECOVERY_AUTHORITY' };
    if (action === 'RECONSTRUCT_SANDBOX') return reconstructs.length
      ? { allowed: true, reason: 'CONTRACT_DECLARES_RECONSTRUCTIVE_TARGETS', targets: reconstructs }
      : { allowed: false, reason: 'CONTRACT_HAS_NO_RECONSTRUCTIVE_AUTHORITY' };
    if (action === 'CORROBORATE') return corroborates.length
      ? { allowed: true, reason: 'CONTRACT_DECLARES_CORROBORATIVE_OUTPUTS', outputs: corroborates }
      : { allowed: false, reason: 'CONTRACT_HAS_NO_CORROBORATIVE_AUTHORITY' };
    if (action === 'AUTO_REPAIR') {
      const requested = String(detail.repair || detail.target || '');
      const allowed = autoRepair.includes('*') || autoRepair.includes(requested);
      return allowed
        ? { allowed: true, reason: 'REPAIR_EXPLICITLY_DECLARED', repair: requested }
        : { allowed: false, reason: 'REPAIR_NOT_DECLARED_BY_CONTRACT', repair: requested, declared: autoRepair };
    }
    if (action === 'NOMINATE_CANDIDATE' || action === 'OPEN_PROMOTION_CEREMONY') return contract.mayNominate === true
      ? { allowed: true, reason: 'CONTRACT_MAY_NOMINATE' }
      : { allowed: false, reason: 'CONTRACT_MAY_NOT_NOMINATE' };
    if (action === 'AUTHORIZE_INTENT') return contract.mayAuthorize === true
      ? { allowed: true, reason: 'CONTRACT_MAY_AUTHORIZE_HUMAN_INTENT' }
      : { allowed: false, reason: 'CONTRACT_MAY_NOT_AUTHORIZE' };
    if (action === 'TRANSPORT_EVIDENCE') return contract.kind === 'transport'
      ? { allowed: true, reason: 'TRANSPORT_CONTRACT' }
      : { allowed: false, reason: 'ACTOR_IS_NOT_TRANSPORT_CLASS' };
    if (action === 'INTERPRET_RECOVERY_FORMAT') return ['interpretation','bootstrap'].includes(contract.kind)
      ? { allowed: true, reason: 'INTERPRETATION_OR_BOOTSTRAP_CONTRACT' }
      : { allowed: false, reason: 'ACTOR_IS_NOT_INTERPRETATION_CLASS' };
    if (action === 'PROMOTE_CANONICAL' || action === 'WRITE_CANONICAL_RECOVERY' || action === 'SILENTLY_RAISE_AUTHORITY') {
      return { allowed: false, reason: 'GLOBAL_RECOVERY_CONSTITUTION_FORBIDS_AUTOMATIC_CANONICAL_PROMOTION' };
    }
    return { allowed: false, reason: 'UNKNOWN_OR_UNDECLARED_ACTION' };
  }

  async evaluate(actor, action, detail = {}) {
    const registry = await this.contracts.init();
    const contract = registry.contracts?.[actor] || null;
    const snapshot = clone(contract);
    return {
      actor,
      action,
      detail,
      registryHash: registry.registryHash,
      contract: snapshot ? { id: snapshot.id, kind: snapshot.kind } : null,
      contractSnapshot: snapshot,
      contractHash: snapshot ? digest(snapshot) : null,
      ...this.evaluateContract(snapshot, action, detail)
    };
  }

  async decide(actor, action, detail = {}) {
    await this.init();
    const evaluation = await this.evaluate(actor, action, detail);
    const head = await readJson(this.head, { sequence: 0, decisionHash: null });
    const record = {
      format: 'JSONDB-AUTHORITY-FIREWALL-DECISION-2',
      sequence: Number(head.sequence || 0) + 1,
      at: now(),
      previousDecisionHash: head.decisionHash || null,
      actor,
      action,
      detail,
      registryHash: evaluation.registryHash,
      contract: evaluation.contract,
      contractHash: evaluation.contractHash,
      contractSnapshot: evaluation.contractSnapshot,
      allowed: evaluation.allowed,
      reason: evaluation.reason,
      evidence: Object.fromEntries(Object.entries(evaluation).filter(([k]) => !['actor','action','detail','registryHash','allowed','reason','contract','contractSnapshot','contractHash'].includes(k))),
      doctrine: 'Recovery authority is deny-by-default. Each decision carries the exact content-addressed Recovery Contract version used to reach it. No recovery subsystem receives automatic canonical-promotion authority.'
    };
    record.decisionHash = digest(record);
    await appendJsonl(this.ledger, record);
    await atomicJson(this.head, { sequence: record.sequence, decisionHash: record.decisionHash, at: record.at, actor, action, allowed: record.allowed, registryHash: record.registryHash });
    return record;
  }

  async assert(actor, action, detail = {}) {
    const decision = await this.decide(actor, action, detail);
    if (!decision.allowed) {
      const error = new Error(`Authority Firewall denied ${actor} -> ${action}: ${decision.reason}`);
      error.status = 403;
      error.authorityDecision = decision;
      throw error;
    }
    return decision;
  }

  async verifyDecisionPolicy(row) {
    if (!row.registryHash || !row.contractSnapshot || !row.contractHash) {
      return { valid: true, legacy: true, warning: 'Decision predates constitution binding and cannot be fully policy-replayed.' };
    }
    const registry = await this.contracts.version(row.registryHash);
    if (!registry) return { valid: false, type: 'REGISTRY_VERSION_MISSING', registryHash: row.registryHash };
    if (registry.registryHash !== row.registryHash) return { valid: false, type: 'REGISTRY_HASH_MISMATCH', expected: row.registryHash, actual: registry.registryHash };
    const historicalContract = registry.contracts?.[row.actor] || null;
    if (!historicalContract) return { valid: false, type: 'HISTORICAL_CONTRACT_MISSING', actor: row.actor, registryHash: row.registryHash };
    const historicalHash = digest(historicalContract);
    const snapshotHash = digest(row.contractSnapshot);
    if (historicalHash !== row.contractHash || snapshotHash !== row.contractHash) {
      return { valid: false, type: 'CONTRACT_SNAPSHOT_MISMATCH', expected: row.contractHash, historicalHash, snapshotHash };
    }
    const replay = this.evaluateContract(row.contractSnapshot, row.action, row.detail || {});
    if (replay.allowed !== row.allowed || replay.reason !== row.reason) {
      return { valid: false, type: 'POLICY_REPLAY_MISMATCH', recorded: { allowed: row.allowed, reason: row.reason }, replay: { allowed: replay.allowed, reason: replay.reason } };
    }
    return { valid: true, legacy: false, registryHash: row.registryHash, contractHash: row.contractHash };
  }

  async verifyLedger() {
    await this.init();
    const rows = await readJsonl(this.ledger);
    const failures = [];
    const warnings = [];
    let previous = null;
    let sequence = 1;
    let replayed = 0;
    let legacy = 0;
    for (const row of rows) {
      if (row.__corrupt) { failures.push({ sequence, type: 'CORRUPT_JSONL' }); sequence++; continue; }
      const copy = { ...row }; delete copy.decisionHash;
      const actual = digest(copy);
      if (row.sequence !== sequence) failures.push({ sequence: row.sequence, type: 'SEQUENCE', expected: sequence });
      if (row.previousDecisionHash !== previous) failures.push({ sequence: row.sequence, type: 'PREVIOUS_HASH', expected: previous, actual: row.previousDecisionHash });
      if (actual !== row.decisionHash) failures.push({ sequence: row.sequence, type: 'DECISION_HASH', expected: row.decisionHash, actual });
      const policy = await this.verifyDecisionPolicy(row);
      if (!policy.valid) failures.push({ sequence: row.sequence, ...policy });
      else if (policy.legacy) { legacy++; warnings.push({ sequence: row.sequence, type: 'LEGACY_UNBOUND_POLICY_DECISION', warning: policy.warning }); }
      else replayed++;
      previous = row.decisionHash;
      sequence++;
    }
    const head = await readJson(this.head, null);
    if (head && head.decisionHash !== previous) failures.push({ type: 'HEAD_MISMATCH', expected: previous, actual: head.decisionHash });
    return {
      format: 'JSONDB-AUTHORITY-FIREWALL-VERIFY-2',
      valid: failures.length === 0,
      fullyPolicyReplayable: failures.length === 0 && legacy === 0,
      decisions: rows.length,
      policyReplayedDecisions: replayed,
      legacyUnboundDecisions: legacy,
      headHash: previous,
      failures,
      warnings
    };
  }
}

module.exports = { AuthorityFirewall };
