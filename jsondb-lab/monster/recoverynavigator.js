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
  'rosetta-capsule': 30,
  'recovery-contracts': 25,
  'recovery-geometry': 20
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

  targetMatchesGoal(contract, goal) {
    const targets = (contract.reconstructs || []).map(String);
    if (goal === 'any') return targets.length > 0;
    if (goal === 'world') return targets.some(x => /world/i.test(x));
    if (goal === 'historical-epoch') return targets.some(x => /epoch/i.test(x));
    if (goal === 'tooling') return targets.some(x => /(tool|source|bootstrap)/i.test(x));
    return targets.some(x => x === goal || x.includes(goal));
  }

  correlated(a, b) {
    const A = new Set(a.dependencies || []);
    const B = new Set(b.dependencies || []);
    const shared = [...A].filter(x => B.has(x));
    return { correlated: shared.length > 0, sharedDependencies: shared };
  }

  rankReconstructors(contracts, capabilities, goal) {
    return contracts
      .filter(c => (c.reconstructs || []).length && this.targetMatchesGoal(c, goal) && this.availableContract(c, capabilities))
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

  decisionView(record) {
    if (!record) return null;
    return { sequence: record.sequence, decisionHash: record.decisionHash, actor: record.actor, action: record.action, allowed: record.allowed, reason: record.reason };
  }

  async plan(options = {}) {
    await this.init();
    const goal = String(options.goal || 'world');
    const remove = Array.isArray(options.remove)
      ? options.remove
      : String(options.remove || '').split(',').map(x => x.trim()).filter(Boolean);
    const minimumCorroborators = Math.max(1, Number(options.minimumCorroborators || 2));
    const [registry, contractAnalysis, geometry] = await Promise.all([
      this.k.recoveryContracts.init(),
      this.k.recoveryContracts.analyze(),
      this.k.recoveryGeometry.analyze({ remove })
    ]);

    const contracts = Object.values(registry.contracts || {});
    const reconstructors = this.rankReconstructors(contracts, geometry.capabilities || {}, goal);
    const blockers = [];
    if (!contractAnalysis.valid) blockers.push({ type: 'RECOVERY_CONTRACT_VIOLATION', violations: contractAnalysis.violations });
    if (!reconstructors.length) blockers.push({ type: 'NO_RECONSTRUCTIVE_PATH_FOR_GOAL', goal, removed: remove, failedScenarios: geometry.summary?.failed || [] });

    const source = reconstructors[0] || null;
    let sourceDecision = null;
    if (source) {
      sourceDecision = await this.k.authorityFirewall.decide(source.contract.id, 'RECONSTRUCT_SANDBOX', { goal, reconstructs: source.target });
      if (!sourceDecision.allowed) blockers.push({ type: 'FIREWALL_DENIED_RECONSTRUCTOR', actor: source.contract.id, reason: sourceDecision.reason });
    }

    const rankedCorroborators = source ? this.rankCorroborators(contracts, geometry.capabilities || {}, source) : [];
    const initiallySelected = source ? this.selectCorroborators(rankedCorroborators, minimumCorroborators) : [];
    const corroborators = [];
    const corroboratorDecisions = [];
    for (const candidate of initiallySelected) {
      const decision = await this.k.authorityFirewall.decide(candidate.contract.id, 'CORROBORATE', { goal, source: source?.contract.id, outputs: candidate.contract.corroborates });
      corroboratorDecisions.push(decision);
      if (decision.allowed) corroborators.push(candidate);
      else blockers.push({ type: 'FIREWALL_DENIED_CORROBORATOR', actor: candidate.contract.id, reason: decision.reason });
    }

    const independentCorroborators = corroborators.filter(x => !x.correlatedWithSource);
    if (source && independentCorroborators.length < minimumCorroborators) {
      blockers.push({
        type: 'INSUFFICIENT_INDEPENDENT_CORROBORATION',
        required: minimumCorroborators,
        availableIndependent: independentCorroborators.length,
        selected: corroborators.map(x => ({ id: x.contract.id, correlated: x.correlatedWithSource, sharedDependencies: x.sharedDependencies }))
      });
    }

    const preserveDecision = await this.k.authorityFirewall.decide('recovery-navigator', 'PRESERVE_EVIDENCE', { goal });
    const juryDecision = await this.k.authorityFirewall.decide('recovery-jury', 'NOMINATE_CANDIDATE', { goal });
    const gateDecision = await this.k.authorityFirewall.decide('jury-promotion-gate', 'OPEN_PROMOTION_CEREMONY', { goal });
    const humanDecision = await this.k.authorityFirewall.decide('promotion-ceremony', 'AUTHORIZE_INTENT', { goal });
    const forbiddenPromotionDecision = await this.k.authorityFirewall.decide('recovery-navigator', 'PROMOTE_CANONICAL', { goal, expected: 'DENY' });
    for (const [name, decision] of [['preserve',preserveDecision],['jury',juryDecision],['gate',gateDecision],['human-authority',humanDecision]]) {
      if (!decision.allowed) blockers.push({ type: 'FIREWALL_DENIED_REQUIRED_PHASE', phase: name, reason: decision.reason });
    }
    if (forbiddenPromotionDecision.allowed) blockers.push({ type: 'FIREWALL_FAILED_CLOSED', action: 'PROMOTE_CANONICAL' });

    const steps = [];
    steps.push({
      phase: 0,
      name: 'PRESERVE_EVIDENCE',
      authority: 'automatic-safe',
      firewallDecision: this.decisionView(preserveDecision),
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
        firewallDecision: this.decisionView(sourceDecision),
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
        channels: corroborators.map((x, i) => ({
          id: x.contract.id,
          capability: x.capability,
          corroborates: x.contract.corroborates,
          correlatedWithSource: x.correlatedWithSource,
          sharedDependencies: x.sharedDependencies,
          firewallDecision: this.decisionView(corroboratorDecisions.find(d => d.actor === x.contract.id))
        })),
        action: 'Challenge the reconstructed sandbox with non-reconstructive evidence. Preserve every contradiction.'
      });
      steps.push({
        phase: 4,
        name: 'RECOVERY_JURY',
        authority: 'machine-nomination-only',
        firewallDecision: this.decisionView(juryDecision),
        action: 'Submit the persistent sandbox file to Recovery Jury. Only EXACT or STRONGLY_CORROBORATED is eligible for a promotion warrant.'
      });
      steps.push({
        phase: 5,
        name: 'JURY_PROMOTION_GATE',
        authority: 'opens-human-ceremony-only',
        firewallDecision: this.decisionView(gateDecision),
        action: 'If Jury eligibility is sufficient, open the existing threshold promotion proposal. The gate does not approve or execute anything.'
      });
      steps.push({
        phase: 6,
        name: 'HUMAN_THRESHOLD_CEREMONY',
        authority: 'human-3-of-5-intent',
        firewallDecision: this.decisionView(humanDecision),
        action: 'Collect the required independent operator signatures. Even an authorized proposal remains separate from canonical-state execution.'
      });
      steps.push({
        phase: 7,
        name: 'MANUAL_PROMOTION_BOUNDARY',
        authority: 'operator-only-outside-navigator',
        firewallDecision: this.decisionView(forbiddenPromotionDecision),
        action: 'Navigator deliberately requested PROMOTE_CANONICAL from Authority Firewall and expects DENY. No automatic canonical promotion method exists in this plan.'
      });
    }

    const status = blockers.length ? 'BLOCKED' : 'PLAN_READY';
    const plan = {
      format: 'JSONDB-RECOVERY-NAVIGATOR-2',
      id: `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`,
      at: now(),
      status,
      goal,
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
      firewall: {
        ledgerHeadAfterPlanning: (await this.k.authorityFirewall.verifyLedger()).headHash,
        preserve: this.decisionView(preserveDecision),
        reconstruct: this.decisionView(sourceDecision),
        corroborators: corroboratorDecisions.map(x => this.decisionView(x)),
        jury: this.decisionView(juryDecision),
        gate: this.decisionView(gateDecision),
        humanAuthority: this.decisionView(humanDecision),
        forbiddenPromotionProbe: this.decisionView(forbiddenPromotionDecision)
      },
      authority: {
        executesRecovery: false,
        writesCanonicalState: false,
        mayOpenPromotionCeremony: false,
        automaticCanonicalPromotion: false,
        maximumMachineAuthority: 'nominate a sandbox for Recovery Jury after evidence collection'
      },
      doctrine: 'One system reconstructs; different systems corroborate; Authority Firewall constrains each phase; machines may nominate; humans authorize; this Navigator never promotes.'
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
    const forbiddenProbeClosed = plan.firewall?.forbiddenPromotionProbe?.allowed === false;
    const firewallLedger = await this.k.authorityFirewall.verifyLedger().catch(error => ({ valid: false, error: error.message }));
    return {
      valid: computed === plan.planHash && authoritySafe && forbiddenProbeClosed && firewallLedger.valid === true,
      id: plan.id,
      status: plan.status,
      goal: plan.goal,
      expectedPlanHash: plan.planHash,
      computedPlanHash: computed,
      authoritySafe,
      forbiddenProbeClosed,
      firewallLedger,
      blockers: plan.blockers || []
    };
  }
}

module.exports = { RecoveryNavigator, CAPABILITY_MAP };
