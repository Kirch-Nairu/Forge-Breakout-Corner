'use strict';

const path = require('path');
const { ensureDir, readJson, atomicJson } = require('./jsonfs');

class RecoveryMutationAudit {
  constructor(kernel) {
    this.k = kernel;
    this.root = path.join(kernel.savior.root, 'recovery-mutation-audit');
  }

  async init() { await ensureDir(this.root); }

  planUsesRemoved(plan, removed) {
    const set = new Set(removed || []);
    const hits = [];
    if (plan.source?.capability && set.has(plan.source.capability)) hits.push({ role: 'source', capability: plan.source.capability });
    for (const c of plan.corroborators || []) {
      if (c.capability && set.has(c.capability)) hits.push({ role: 'corroborator', capability: c.capability, id: c.id });
    }
    return hits;
  }

  terminalDenied(plan) {
    const terminal = [...(plan.firewall || [])].reverse().find(x => x.action === 'PROMOTE_CANONICAL');
    return Boolean(terminal && terminal.allowed === false);
  }

  classify(plan, navigatorValid, removed) {
    const removedUsage = this.planUsesRemoved(plan, removed);
    const terminalPromotionDenied = this.terminalDenied(plan);
    if (plan.status === 'PLAN_READY' && navigatorValid && removedUsage.length === 0 && terminalPromotionDenied) {
      return { classification: 'REROUTED', safe: true, removedUsage, terminalPromotionDenied };
    }
    if (plan.status === 'BLOCKED' && navigatorValid && terminalPromotionDenied) {
      return { classification: 'BLOCKED_SAFE', safe: true, removedUsage, terminalPromotionDenied };
    }
    return { classification: 'UNSAFE', safe: false, removedUsage, terminalPromotionDenied };
  }

  async auditRow(row) {
    const plan = await readJson(path.join(this.k.recoveryNavigator.plans, `${row.planId}.json`), null);
    if (!plan) return { valid: false, planId: row.planId, reason: 'PLAN_MISSING' };
    if (row.planHash && plan.planHash !== row.planHash) {
      return { valid: false, planId: row.planId, reason: 'PLAN_HASH_REFERENCE_MISMATCH', expected: row.planHash, actual: plan.planHash };
    }
    const verified = await this.k.recoveryNavigator.verify(plan.id);
    const recomputed = this.classify(plan, verified.valid, row.removed || []);
    const matches = row.classification === recomputed.classification && Boolean(row.safe) === recomputed.safe && Boolean(row.terminalPromotionDenied) === recomputed.terminalPromotionDenied;
    return {
      valid: verified.valid && matches,
      planId: row.planId,
      navigatorValid: verified.valid,
      recordedClassification: row.classification,
      recomputedClassification: recomputed.classification,
      recordedSafe: Boolean(row.safe),
      recomputedSafe: recomputed.safe,
      removedUsage: recomputed.removedUsage,
      terminalPromotionDenied: recomputed.terminalPromotionDenied
    };
  }

  async verify(mutationId = null) {
    await this.init();
    const mutation = mutationId
      ? await readJson(path.join(this.k.planMutation.records, `${mutationId}.json`), null)
      : await readJson(path.join(this.k.planMutation.root, 'latest.json'), null);
    if (!mutation) return { valid: false, status: 'ABSENT' };

    const mutationBase = await this.k.planMutation.verify(mutation.id).catch(error => ({ valid: false, error: error.message }));
    const rows = [...(mutation.singles || []), ...(mutation.pairs || [])];
    const audits = [];
    for (const row of rows) audits.push(await this.auditRow(row));

    const baseline = await readJson(path.join(this.k.recoveryNavigator.plans, `${mutation.baseline?.planId}.json`), null);
    const baselineVerify = baseline ? await this.k.recoveryNavigator.verify(baseline.id) : { valid: false };
    const baselineValid = Boolean(
      baseline &&
      (!mutation.baseline?.planHash || baseline.planHash === mutation.baseline.planHash) &&
      baselineVerify.valid &&
      this.terminalDenied(baseline) === Boolean(mutation.baseline?.terminalPromotionDenied)
    );

    const replayValid = audits.every(x => x.valid);
    const recomputedUnsafe = audits.filter(x => !x.recomputedSafe).length;
    const summaryMatches = Number(mutation.summary?.unsafe || 0) === recomputedUnsafe && Number(mutation.summary?.totalMutations || 0) === audits.length;
    const result = {
      format: 'JSONDB-RECOVERY-MUTATION-AUDIT-1',
      mutationId: mutation.id,
      valid: mutationBase.valid === true && baselineValid && replayValid && summaryMatches && recomputedUnsafe === 0,
      mutationArtifactValid: mutationBase.valid === true,
      baselineValid,
      replayValid,
      summaryMatches,
      recomputedUnsafe,
      audits,
      doctrine: 'Recorded mutation classifications are not trusted. Every referenced Navigator plan is reopened and independently reclassified.'
    };
    await atomicJson(path.join(this.root, 'latest.json'), result);
    return result;
  }
}

module.exports = { RecoveryMutationAudit };
