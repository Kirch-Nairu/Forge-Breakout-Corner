'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, atomicJson } = require('./jsonfs');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

const DEFAULT_MUTATIONS = [
  'memoryPalace','trinity','quaternary','semanticFossil','semanticChronicle','fountainPackets',
  'spacetimeArk','temporalParity','shadowLaws','semanticHologram','dualCryptoCouncil',
  'forwardWitness','timeWeave','crossHistoryBraid','lastSaviorArchive','evidenceDiaspora'
];

class RecoveryPlanMutationLab {
  constructor(kernel) {
    this.k = kernel;
    this.root = path.join(kernel.savior.root, 'recovery-plan-mutations');
    this.records = path.join(this.root, 'records');
  }

  async init() { await ensureDir(this.records); }

  planUsesRemoved(plan, removed) {
    const set = new Set(removed);
    const hits = [];
    if (plan.source?.capability && set.has(plan.source.capability)) hits.push({ role: 'source', capability: plan.source.capability });
    for (const c of plan.corroborators || []) if (c.capability && set.has(c.capability)) hits.push({ role: 'corroborator', capability: c.capability, id: c.id });
    return hits;
  }

  terminalDenied(plan) {
    const terminal = [...(plan.firewall || [])].reverse().find(x => x.action === 'PROMOTE_CANONICAL');
    return Boolean(terminal && terminal.allowed === false);
  }

  async mutation(goal, removed, minimumCorroborators) {
    const plan = await this.k.recoveryNavigator.plan({ goal, remove: removed, minimumCorroborators });
    const verified = await this.k.recoveryNavigator.verify(plan.id);
    const removedUsage = this.planUsesRemoved(plan, removed);
    const terminalDenied = this.terminalDenied(plan);
    const rerouted = plan.status === 'PLAN_READY' && verified.valid && removedUsage.length === 0 && terminalDenied;
    const blockedSafe = plan.status === 'BLOCKED' && verified.valid && terminalDenied;
    let classification = 'UNSAFE';
    if (rerouted) classification = 'REROUTED';
    else if (blockedSafe) classification = 'BLOCKED_SAFE';
    return {
      removed,
      planId: plan.id,
      planHash: plan.planHash,
      status: plan.status,
      source: plan.source,
      corroborators: plan.corroborators,
      blockers: plan.blockers,
      verified: verified.valid,
      terminalPromotionDenied: terminalDenied,
      removedUsage,
      classification,
      safe: rerouted || blockedSafe
    };
  }

  pairs(values, limit) {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        out.push([values[i], values[j]]);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  async run(label = 'mutation-lab', options = {}) {
    await this.init();
    const goal = String(options.goal || 'world');
    const minimumCorroborators = Math.max(1, Number(options.minimumCorroborators || 2));
    const pairLimit = Math.max(0, Math.min(64, Number(options.pairLimit ?? 12)));
    const capabilities = await this.k.recoveryGeometry.capabilities();
    const candidates = (options.capabilities || DEFAULT_MUTATIONS).filter(name => capabilities[name]?.available === true);

    const baselinePlan = await this.k.recoveryNavigator.plan({ goal, minimumCorroborators });
    const baselineVerify = await this.k.recoveryNavigator.verify(baselinePlan.id);
    const baseline = {
      planId: baselinePlan.id,
      planHash: baselinePlan.planHash,
      status: baselinePlan.status,
      source: baselinePlan.source,
      verified: baselineVerify.valid,
      terminalPromotionDenied: this.terminalDenied(baselinePlan)
    };

    const singles = [];
    for (const capability of candidates) singles.push(await this.mutation(goal, [capability], minimumCorroborators));
    const pairRows = [];
    for (const pair of this.pairs(candidates, pairLimit)) pairRows.push(await this.mutation(goal, pair, minimumCorroborators));

    const all = [...singles, ...pairRows];
    const unsafe = all.filter(x => !x.safe);
    const policyCheckpoint = await this.k.policyCheckpoint.capture(`${label}:post-mutation`);
    const core = {
      format: 'JSONDB-RECOVERY-PLAN-MUTATION-1',
      id: `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`,
      label,
      at: now(),
      goal,
      minimumCorroborators,
      baseline,
      candidates,
      singles,
      pairs: pairRows,
      summary: {
        totalMutations: all.length,
        safe: all.filter(x => x.safe).length,
        rerouted: all.filter(x => x.classification === 'REROUTED').length,
        blockedSafe: all.filter(x => x.classification === 'BLOCKED_SAFE').length,
        unsafe: unsafe.length,
        unsafeRemovals: unsafe.map(x => x.removed)
      },
      policyCheckpoint: {
        id: policyCheckpoint.id,
        checkpointHash: policyCheckpoint.checkpointHash,
        firewallHead: policyCheckpoint.firewall?.headHash || null
      },
      doctrine: 'Removing evidence must produce either a verified reroute or a verified hard block. Silent downgrade is a test failure. Mutation testing plans only; it does not reconstruct or promote state.'
    };
    const coreHash = digest(core);
    const [cryptoAttestation, forwardAttestation] = await Promise.all([
      this.k.cryptoCouncil.attest(coreHash, { purpose: 'recovery-plan-mutation', mutationId: core.id, goal }),
      this.k.forwardWitness.attest(coreHash, { purpose: 'recovery-plan-mutation', mutationId: core.id, goal })
    ]);
    const record = {
      ...core,
      coreHash,
      cryptoCouncil: { id: cryptoAttestation.id, worldRoot: cryptoAttestation.worldRoot, familyQuorum: cryptoAttestation.familyQuorum },
      forwardWitness: { sequence: forwardAttestation.statement.sequence, subjectHash: forwardAttestation.statement.subjectHash, attestationHash: forwardAttestation.attestationHash }
    };
    record.mutationHash = digest(record);
    await atomicJson(path.join(this.records, `${record.id}.json`), record);
    await atomicJson(path.join(this.root, 'latest.json'), record);
    return record;
  }

  async verify(id = null, options = {}) {
    if (options.readOnly !== true) await this.init();
    const { readJson } = require('./jsonfs');
    const record = id ? await readJson(path.join(this.records, `${id}.json`), null) : await readJson(path.join(this.root, 'latest.json'), null);
    if (!record) return { valid: false, status: 'ABSENT', readOnly: options.readOnly === true };
    const copy = { ...record }; delete copy.mutationHash;
    const staticValid = digest(copy) === record.mutationHash;
    const coreCopy = { ...record }; delete coreCopy.coreHash; delete coreCopy.cryptoCouncil; delete coreCopy.forwardWitness; delete coreCopy.mutationHash;
    const coreValid = digest(coreCopy) === record.coreHash;
    const readOnly = options.readOnly === true;
    const [policy, crypto, forward] = await Promise.all([
      this.k.policyCheckpoint.verify(record.policyCheckpoint?.id || null, { readOnly }).catch(error => ({ valid: false, error: error.message })),
      this.k.cryptoCouncil.verify(record.cryptoCouncil?.id, { readOnly }).catch(error => ({ valid: false, error: error.message })),
      this.k.forwardWitness.verifyAll({ readOnly }).catch(error => ({ valid: false, error: error.message }))
    ]);
    const forwardRecord = forward.results?.find(x => x.sequence === record.forwardWitness?.sequence) || null;
    const forwardValid = Boolean(forward.valid && forwardRecord?.valid && forwardRecord.subjectHash === record.coreHash && forwardRecord.attestationHash === record.forwardWitness.attestationHash);
    const cryptoValid = Boolean(crypto.valid && crypto.worldRoot === record.coreHash && Number(crypto.familyQuorum || 0) >= 2);
    const noUnsafe = Number(record.summary?.unsafe || 0) === 0;
    return {
      format: 'JSONDB-RECOVERY-PLAN-MUTATION-VERIFY-3',
      id: record.id,
      valid: staticValid && coreValid && policy.valid && cryptoValid && forwardValid && noUnsafe,
      readOnly,
      staticValid,
      coreValid,
      policyCheckpointValid: policy.valid,
      cryptoCouncilValid: cryptoValid,
      forwardWitnessValid: forwardValid,
      noUnsafeMutations: noUnsafe,
      summary: record.summary,
      doctrine: 'Mutation artifact verification may recurse through policy and cryptographic evidence without creating trust material when read-only mode is requested.'
    };
  }
}

module.exports = { RecoveryPlanMutationLab, DEFAULT_MUTATIONS };
