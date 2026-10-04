'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson, appendJsonl, readJsonl } = require('./jsonfs');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

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

  async contract(actor) {
    const registry = await this.contracts.init();
    return registry.contracts?.[actor] || null;
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
    const contract = await this.contract(actor);
    return { actor, action, detail, contract: contract ? { id: contract.id, kind: contract.kind } : null, ...this.evaluateContract(contract, action, detail) };
  }

  async decide(actor, action, detail = {}) {
    await this.init();
    const evaluation = await this.evaluate(actor, action, detail);
    const head = await readJson(this.head, { sequence: 0, decisionHash: null });
    const record = {
      format: 'JSONDB-AUTHORITY-FIREWALL-DECISION-1',
      sequence: Number(head.sequence || 0) + 1,
      at: now(),
      previousDecisionHash: head.decisionHash || null,
      actor, action, detail,
      allowed: evaluation.allowed,
      reason: evaluation.reason,
      contract: evaluation.contract,
      evidence: Object.fromEntries(Object.entries(evaluation).filter(([k]) => !['actor','action','detail','allowed','reason','contract'].includes(k))),
      doctrine: 'Recovery authority is deny-by-default. No recovery subsystem receives automatic canonical-promotion authority.'
    };
    record.decisionHash = digest(record);
    await appendJsonl(this.ledger, record);
    await atomicJson(this.head, { sequence: record.sequence, decisionHash: record.decisionHash, at: record.at, actor, action, allowed: record.allowed });
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

  async verifyLedger() {
    await this.init();
    const rows = await readJsonl(this.ledger);
    const failures = [];
    let previous = null;
    let sequence = 1;
    for (const row of rows) {
      if (row.__corrupt) { failures.push({ sequence, type: 'CORRUPT_JSONL' }); sequence++; continue; }
      const copy = { ...row }; delete copy.decisionHash;
      const actual = digest(copy);
      if (row.sequence !== sequence) failures.push({ sequence: row.sequence, type: 'SEQUENCE', expected: sequence });
      if (row.previousDecisionHash !== previous) failures.push({ sequence: row.sequence, type: 'PREVIOUS_HASH', expected: previous, actual: row.previousDecisionHash });
      if (actual !== row.decisionHash) failures.push({ sequence: row.sequence, type: 'DECISION_HASH', expected: row.decisionHash, actual });
      previous = row.decisionHash;
      sequence++;
    }
    const head = await readJson(this.head, null);
    if (head && head.decisionHash !== previous) failures.push({ type: 'HEAD_MISMATCH', expected: previous, actual: head.decisionHash });
    return { format: 'JSONDB-AUTHORITY-FIREWALL-VERIFY-1', valid: failures.length === 0, decisions: rows.length, headHash: previous, failures };
  }
}

module.exports = { AuthorityFirewall };
