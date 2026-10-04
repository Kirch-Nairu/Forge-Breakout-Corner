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

  async verifyDecisionPolicy(row, options = {}) {
    if (!row.registryHash || !row.contractSnapshot || !row.contractHash) {
      return { valid: true, legacy: true, warning: 'Decision predates constitution binding and cannot be fully policy-replayed.' };
    }
    const registry = await this.contracts.version(row.registryHash, { hydrate: options.readOnly !== true && options.hydrateContracts !== false });
    if (!registry) return { valid: false, type: 'REGISTRY_VERSION_MISSING', registryHash: row.registryHash };
    const registryCopy = { ...registry }; delete registryCopy.registryHash;
    const computedRegistryHash = digest(registryCopy);
    if (computedRegistryHash !== row.registryHash || registry.registryHash !== row.registryHash) {
      return { valid: false, type: 'REGISTRY_CONTENT_HASH_MISMATCH', expected: row.registryHash, declared: registry.registryHash, computed: computedRegistryHash };
    }
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

  async verifyPrefix(count = null, options = {}) {
    if (options.readOnly !== true) await this.init();
    const allRows = await readJsonl(this.ledger);
    const requested = count == null ? allRows.length : Math.max(0, Number(count));
    if (!Number.isInteger(requested)) return { format: 'JSONDB-AUTHORITY-FIREWALL-PREFIX-VERIFY-2', valid: false, type: 'INVALID_PREFIX_COUNT', requested: count };
    if (requested > allRows.length) return { format: 'JSONDB-AUTHORITY-FIREWALL-PREFIX-VERIFY-2', valid: false, type: 'PREFIX_BEYOND_LEDGER', requested, available: allRows.length };
    const rows = allRows.slice(0, requested);
    const failures = [];
    const warnings = [];
    let previous = null;
    let replayed = 0;
    let legacy = 0;
    for (let i = 0; i < rows.length; i++) {
      const sequence = i + 1;
      const row = rows[i];
      if (row.__corrupt) { failures.push({ sequence, type: 'CORRUPT_JSONL' }); continue; }
      const copy = { ...row }; delete copy.decisionHash;
      const actual = digest(copy);
      if (row.sequence !== sequence) failures.push({ sequence: row.sequence, type: 'SEQUENCE', expected: sequence });
      if (row.previousDecisionHash !== previous) failures.push({ sequence: row.sequence, type: 'PREVIOUS_HASH', expected: previous, actual: row.previousDecisionHash });
      if (actual !== row.decisionHash) failures.push({ sequence: row.sequence, type: 'DECISION_HASH', expected: row.decisionHash, actual });
      const policy = await this.verifyDecisionPolicy(row, options);
      if (!policy.valid) failures.push({ sequence: row.sequence, ...policy });
      else if (policy.legacy) { legacy++; warnings.push({ sequence: row.sequence, type: 'LEGACY_UNBOUND_POLICY_DECISION', warning: policy.warning }); }
      else replayed++;
      previous = row.decisionHash;
    }
    return {
      format: 'JSONDB-AUTHORITY-FIREWALL-PREFIX-VERIFY-2',
      valid: failures.length === 0,
      fullyPolicyReplayable: failures.length === 0 && legacy === 0,
      readOnly: options.readOnly === true,
      decisionsChecked: rows.length,
      availableDecisions: allRows.length,
      policyReplayedDecisions: replayed,
      legacyUnboundDecisions: legacy,
      headHash: previous,
      failures,
      warnings
    };
  }

  async verifyReferences(references = [], options = {}) {
    if (options.readOnly !== true) await this.init();
    const refs = (references || []).filter(x => x && Number.isInteger(Number(x.sequence)) && x.decisionHash);
    const maxSequence = refs.reduce((m, x) => Math.max(m, Number(x.sequence)), 0);
    const prefix = await this.verifyPrefix(maxSequence, options);
    if (!prefix.valid) return { format: 'JSONDB-AUTHORITY-FIREWALL-REFERENCE-VERIFY-2', valid: false, prefix, references: [] };
    const ledger = await readJsonl(this.ledger);
    const results = refs.map(ref => {
      const sequence = Number(ref.sequence);
      const row = ledger[sequence - 1];
      return {
        sequence,
        expectedDecisionHash: ref.decisionHash,
        actualDecisionHash: row && !row.__corrupt ? row.decisionHash : null,
        actorMatches: !ref.actor || row?.actor === ref.actor,
        actionMatches: !ref.action || row?.action === ref.action,
        valid: Boolean(row && !row.__corrupt && row.decisionHash === ref.decisionHash && (!ref.actor || row.actor === ref.actor) && (!ref.action || row.action === ref.action))
      };
    });
    return {
      format: 'JSONDB-AUTHORITY-FIREWALL-REFERENCE-VERIFY-2',
      valid: prefix.valid && results.every(x => x.valid),
      readOnly: options.readOnly === true,
      prefix,
      references: results,
      maxSequence
    };
  }

  async verifyLedger(options = {}) {
    if (options.readOnly !== true) await this.init();
    const rows = await readJsonl(this.ledger);
    const head = await readJson(this.head, null);
    if (options.readOnly === true && rows.length === 0 && !head) {
      return {
        format: 'JSONDB-AUTHORITY-FIREWALL-VERIFY-4',
        valid: false,
        status: 'ABSENT',
        readOnly: true,
        fullyPolicyReplayable: false,
        decisions: 0,
        policyReplayedDecisions: 0,
        legacyUnboundDecisions: 0,
        headHash: null,
        failures: [],
        warnings: []
      };
    }
    const prefix = await this.verifyPrefix(rows.length, options);
    const failures = [...(prefix.failures || [])];
    if (!head && rows.length) failures.push({ type: 'HEAD_MISSING', expected: prefix.headHash, actual: null });
    if (head && head.decisionHash !== prefix.headHash) failures.push({ type: 'HEAD_MISMATCH', expected: prefix.headHash, actual: head.decisionHash });
    if (head && Number(head.sequence || 0) !== rows.length) failures.push({ type: 'HEAD_SEQUENCE_MISMATCH', expected: rows.length, actual: Number(head.sequence || 0) });
    return {
      format: 'JSONDB-AUTHORITY-FIREWALL-VERIFY-4',
      valid: failures.length === 0,
      status: 'PRESENT',
      readOnly: options.readOnly === true,
      fullyPolicyReplayable: failures.length === 0 && prefix.legacyUnboundDecisions === 0,
      decisions: rows.length,
      policyReplayedDecisions: prefix.policyReplayedDecisions,
      legacyUnboundDecisions: prefix.legacyUnboundDecisions,
      headHash: prefix.headHash,
      failures,
      warnings: prefix.warnings || []
    };
  }
}

module.exports = { AuthorityFirewall };
