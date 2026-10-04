'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, atomicJson } = require('./jsonfs');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

const CAPABILITY_MAP = {
  'memory-palace': 'memoryPalace',
  'trinity-ark': 'trinity',
  'quaternary-cold-codec': 'quaternary',
  'fountain-ark': 'fountainPackets',
  'temporal-parity': 'temporalParity',
  'spacetime-ark': 'spacetimeArk',
  'semantic-delta-fossils': 'semanticFossil',
  'semantic-chronicle': 'semanticChronicle',
  'semantic-hologram': 'semanticHologram',
  'shadow-laws': 'shadowLaws',
  'time-weave': 'timeWeave',
  'cross-history-braid': 'crossHistoryBraid',
  'crypto-council': 'dualCryptoCouncil',
  'forward-witness': 'forwardWitness',
  'rosetta-capsule': 'rosettaSpec',
  'civilization-seed': 'lastSaviorArchive',
  'evidence-diaspora': 'evidenceDiaspora',
  'last-savior': 'lastSaviorArchive'
};

const RECONSTRUCTION_PRIORITY = {
  'memory-palace': 100,
  'trinity-ark': 96,
  'quaternary-cold-codec': 90,
  'spacetime-ark': 86,
  'semantic-delta-fossils': 82,
  'temporal-parity': 76,
  'semantic-chronicle': 72,
  'fountain-ark': 68,
  'civilization-seed': 40
};

const CORROBORATION_PRIORITY = {
  'shadow-laws': 100,
  'semantic-hologram': 96,
  'crypto-council': 92,
  'forward-witness': 88,
  'time-weave': 84,
  'cross-history-braid': 80,
  'last-savior': 76,
  'evidence-diaspora': 50,
  'rosetta-capsule': 30
};

const RECOVERY_HINTS = {
  'memory-palace': 'Restore the selected Memory Palace manifest into a new sandbox JSON world.',
  'trinity-ark': 'Use Trinity only when decoder quorum reconstructs the expected world hash; restore into a sandbox.',
  'quaternary-cold-codec': 'Decode quaternary A/C/G/T oligos, repair eligible parity groups, and write the recovered world to a sandbox.',
  'spacetime-ark': 'Peel row/column erasures across the space-time grid and recover historical epoch artifacts to a sandbox.',
  'semantic-delta-fossils': 'Choose a surviving fossil endpoint and apply the reversible forward or inverse semantic patch into a sandbox.',
  'temporal-parity': 'Reconstruct the damaged historical OMEGA epoch into the temporal-parity recovery sandbox.',
  'semantic-chronicle': 'Replay the independent semantic Chronicle from genesis into an isolated candidate world.',
  'fountain-ark': 'Collect surviving self-describing droplets and peel equations until the original world bytes reappear.',
  'civilization-seed': 'Extract recovery tooling and referenced evidence from the Civilization Seed; use it as bootstrap material, not sole truth.'
};

class RecoveryNavigator {
  constructor(kernel) {
    this.k = kernel;
    this.root = path.join(kernel.savior.root, 'recovery-navigator');
    this.plans = path.join(this.root, 'plans');
  }

  async init() { await ensureDir(this.plans); }

  availableContract(contract, capabilities) {
    const capability = CAPABILITY_MAP[contract.id];
    if (!capability) return false;
    return capabilities[capability]?.available === true;
  }

  correlated(a, b) {
    const A = new Set(a.dependencies || []);
    const B = new Set(b.dependencies || []);
    const shared = [...A].filter(x => B.has(x));
    return { correlated: shared.length > 0, sharedDependencies: shared };
  }

  rankReconstructors(contracts, capabilities) {
    return contracts
      .filter(c => (c.reconstructs || []).length && this.availableContract(c, capabilities))
      .map(c => ({
        contract: c,
        capability: CAPABILITY_MAP[c.id],
        score: RECONSTRUCTION_PRIORITY[c.id] || 20,
        target: c.reconstructs
      }))
      .sort((a, b) => b.score - a.score || a.contract.id.localeCompare(b.contract.id));
  }

  rankCorroborators(contracts, capabilities, source) {
    const rows = [];
    for (const c of contracts) {
      if (!(c.corroborates || []).length || (c.reconstructs || []).length) continue;
      if (!this.availableContract(c, capabilities)) continue;
      const corr = this.correlated(source.contract, c);
      rows.push({
        contract: c,
        capability: CAPABILITY_MAP[c.id],
        score: (CORROBORATION_PRIORITY[c.id] || 20) - (corr.correlated ? 35 : 0),
        correlatedWithSource: corr.correlated,
        sharedDependencies: corr.sharedDependencies
      });
    }
    rows.sort((a, b) => b.score - a.score || Number(a.correlatedWithSource) - Number(b.correlatedWithSource) || a.contract.id.localeCompare(b.contract.id));
    return rows;
  }

  selectCorroborators(ranked, minimum = 2) {
    const independent = ranked.filter(x => !x.correlatedWithSource);
    if (independent.length >= minimum) return independent.slice(0, Math.max(minimum, 3));
    return [...independent, ...ranked.filter(x => x.correlatedWithSource)].slice(0, Math.max(minimum, 3));
  }

  async plan(options = {}) {
    await this.init();
    const remove = Array.isArray(options.remove)
      ? options.remove
      : String(options.remove || '').split(',').map(x => x.trim()).filter(Boolean);
    const [registry, contractAnalysis, geometry] = await Promise.all([
      this.k.recoveryContracts.init(),
      this.k.recoveryContracts.analyze(),
      this.k.recoveryGeometry.analyze({ remove })
    ]);

    const contracts = Object.values(registry.contracts || {});
    const reconstructors = this.rankReconstructors(contracts, geometry.capabilities || {});
    const blockers = [];
    if (!contractAnalysis.valid) blockers.push({ type: 'RECOVERY_CONTRACT_VIOLATION', violations: contractAnalysis.violations });
    if (!reconstructors.length) blockers.push({ type: 'NO_RECONSTRUCTIVE_PATH', removed: remove, failedScenarios: geometry.summary?.failed || [] });

    const source = reconstructors[0] || null;
    const rankedCorroborators = source ? this.rankCorroborators(contracts, geometry.capabilities || {}, source) : [];
    const corroborators = source ? this.selectCorroborators(rankedCorroborators, Number(options.minimumCorroborators || 2)) : [];
    const independentCorroborators = corroborators.filter(x => !x.correlatedWithSource);
    if (source && independentCorroborators.length < Number(options.minimumCorroborators || 2)) {
      blockers.push({
        type: 'INSUFFICIENT_INDEPENDENT_CORROBORATION',
        required: Number(options.minimumCorroborators || 2),
        availableIndependent: independentCorroborators.length,
        selected: corroborators.map(x => ({ id: x.contract.id, correlated: x.correlatedWithSource, sharedDependencies: x.sharedDependencies }))
      });
    }

    const steps = [];
    steps.push({
      phase: 0,
      name: 'PRESERVE_EVIDENCE',
      authority: 'automatic-safe',
      action: 'Clone or copy all surviving evidence before any repair attempt; never mutate the sole surviving copy.'
    });
    if (source) {
      steps.push({
        phase: 1,
        name: 'RECONSTRUCT_SANDBOX',
        authority: 'sandbox-only',
        source: source.contract.id,
        capability: source.capability,
        reconstructs: source.target,
        action: RECOVERY_HINTS[source.contract.id] || `Use ${source.contract.id} to reconstruct only into an isolated sandbox.`,
        forbidden: source.contract.forbidden
      });
      steps.push({
        phase: 2,
        name: 'CANONICALIZE_CANDIDATE',
        authority: 'read-only-evidence',
        action: 'Run independent canonicalization quorum over the sandbox and record its semantic world hash. Divergence blocks promotion.'
      });
      steps.push({
        phase: 3,
        name: 'INDEPENDENT_CORROBORATION',
        authority: 'read-only-evidence',
        channels: corroborators.map(x => ({
          id: x.contract.id,
          capability: x.capability,
          corroborates: x.contract.corroborates,
          correlatedWithSource: x.correlatedWithSource,
          sharedDependencies: x.sharedDependencies
        })),
        action: 'Challenge the reconstructed sandbox with non-reconstructive evidence. Preserve every contradiction.'
      });
      steps.push({
        phase: 4,
        name: 'RECOVERY_JURY',
        authority: 'machine-nomination-only',
        action: 'Submit the persistent sandbox file to Recovery Jury. Only EXACT or STRONGLY_CORROBORATED is eligible for a promotion warrant.'
      });
      steps.push({
        phase: 5,
        name: 'JURY_PROMOTION_GATE',
        authority: 'opens-human-ceremony-only',
        action: 'If Jury eligibility is sufficient, open the existing threshold promotion proposal. The gate does not approve or execute anything.'
      });
      steps.push({
        phase: 6,
        name: 'HUMAN_THRESHOLD_CEREMONY',
        authority: 'human-3-of-5-intent',
        action: 'Collect the required independent operator signatures. Even an authorized proposal remains separate from canonical-state execution.'
      });
      steps.push({
        phase: 7,
        name: 'MANUAL_PROMOTION_BOUNDARY',
        authority: 'operator-only-outside-navigator',
        action: 'Navigator stops here. No automatic canonical promotion method exists in this plan.'
      });
    }

    const status = blockers.length ? 'BLOCKED' : 'PLAN_READY';
    const plan = {
      format: 'JSONDB-RECOVERY-NAVIGATOR-1',
      id: `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`,
      at: now(),
      status,
      requestedCounterfactualRemovals: remove,
      geometry: {
        coverage: geometry.summary?.coverage,
        survived: geometry.summary?.survived,
        total: geometry.summary?.total,
        failedScenarios: geometry.summary?.failed || []
      },
      source: source ? { id: source.contract.id, capability: source.capability, score: source.score, reconstructs: source.target } : null,
      alternateReconstructors: reconstructors.slice(1, 8).map(x => ({ id: x.contract.id, capability: x.capability, score: x.score, reconstructs: x.target })),
      corroborators: corroborators.map(x => ({ id: x.contract.id, capability: x.capability, score: x.score, correlatedWithSource: x.correlatedWithSource, sharedDependencies: x.sharedDependencies })),
      blockers,
      steps,
      authority: {
        executesRecovery: false,
        writesCanonicalState: false,
        mayOpenPromotionCeremony: false,
        automaticCanonicalPromotion: false,
        maximumMachineAuthority: 'nominate a sandbox for Recovery Jury after evidence collection'
      },
      doctrine: 'One system reconstructs; different systems corroborate; machines may nominate; humans authorize; this Navigator never promotes.'
    };
    plan.planHash = digest(plan);
    await atomicJson(path.join(this.plans, `${plan.id}.json`), plan);
    await atomicJson(path.join(this.root, 'latest.json'), plan);
    return plan;
  }

  async verify(id = null) {
    await this.init();
    const { readJson } = require('./jsonfs');
    const plan = id ? await readJson(path.join(this.plans, `${id}.json`), null) : await readJson(path.join(this.root, 'latest.json'), null);
    if (!plan) return { valid: false, status: 'ABSENT' };
    const copy = { ...plan }; delete copy.planHash;
    const computed = digest(copy);
    const authoritySafe = plan.authority?.writesCanonicalState === false && plan.authority?.automaticCanonicalPromotion === false;
    return {
      valid: computed === plan.planHash && authoritySafe,
      id: plan.id,
      status: plan.status,
      expectedPlanHash: plan.planHash,
      computedPlanHash: computed,
      authoritySafe,
      blockers: plan.blockers || []
    };
  }
}

module.exports = { RecoveryNavigator, CAPABILITY_MAP };
