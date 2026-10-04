'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, atomicJson, readJson } = require('./jsonfs');

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
  'semantic-delta-fossils': 88,
  'semantic-chronicle': 84,
  'fountain-ark': 80,
  'spacetime-ark': 78,
  'temporal-parity': 74,
  'civilization-seed': 50
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
  'fountain-ark': 'Collect surviving self-describing droplets and peel equations until original world bytes reappear.',
  'civilization-seed': 'Recover bootstrap tooling and public trust material. This is tooling recovery, not database-state recovery.'
};

const GOAL_ALIASES = {
  world: 'world', database: 'world', state: 'world',
  'historical-epoch': 'historical-epoch', epoch: 'historical-epoch', history: 'historical-epoch',
  tooling: 'tooling', tools: 'tooling', bootstrap: 'tooling',
  any: 'any'
};

class RecoveryNavigator {
  constructor(kernel) {
    this.k = kernel;
    this.root = path.join(kernel.savior.root, 'recovery-navigator');
    this.plans = path.join(this.root, 'plans');
  }

  async init() { await ensureDir(this.plans); }

  normalizeGoal(value) {
    const key = String(value || 'world').trim().toLowerCase();
    return GOAL_ALIASES[key] || 'world';
  }

  availableContract(contract, capabilities) {
    const capability = CAPABILITY_MAP[contract.id];
    return Boolean(capability && capabilities[capability]?.available === true);
  }

  targetMatchesGoal(target, goal) {
    const t = String(target || '').toLowerCase();
    if (goal === 'any') return true;
    if (goal === 'world') return t === 'world' || t.includes('world-bytes') || t.includes('semantic-world') || t.includes('ancestor-world') || t.includes('descendant-world');
    if (goal === 'historical-epoch') return t.includes('epoch');
    if (goal === 'tooling') return t.includes('tool') || t.includes('bootstrap') || t.includes('recovery-tool-source');
    return false;
  }

  correlated(a, b) {
    const A = new Set(a.dependencies || []), B = new Set(b.dependencies || []);
    const shared = [...A].filter(x => B.has(x));
    return { correlated: shared.length > 0, sharedDependencies: shared };
  }

  rankReconstructors(contracts, capabilities, goal) {
    return contracts
      .filter(c => (c.reconstructs || []).some(target => this.targetMatchesGoal(target, goal)) && this.availableContract(c, capabilities))
      .map(c => ({ contract: c, capability: CAPABILITY_MAP[c.id], score: RECONSTRUCTION_PRIORITY[c.id] || 20, target: (c.reconstructs || []).filter(target => this.targetMatchesGoal(target, goal)) }))
      .sort((a, b) => b.score - a.score || a.contract.id.localeCompare(b.contract.id));
  }

  rankCorroborators(contracts, capabilities, source) {
    const rows = [];
    for (const c of contracts) {
      if (!(c.corroborates || []).length || (c.reconstructs || []).length || !this.availableContract(c, capabilities)) continue;
      const corr = this.correlated(source.contract, c);
      rows.push({ contract: c, capability: CAPABILITY_MAP[c.id], score: (CORROBORATION_PRIORITY[c.id] || 20) - (corr.correlated ? 35 : 0), correlatedWithSource: corr.correlated, sharedDependencies: corr.sharedDependencies });
    }
    return rows.sort((a, b) => b.score - a.score || Number(a.correlatedWithSource) - Number(b.correlatedWithSource) || a.contract.id.localeCompare(b.contract.id));
  }

  selectCorroborators(ranked, minimum = 2) {
    const independent = ranked.filter(x => !x.correlatedWithSource);
    return independent.length >= minimum ? independent.slice(0, Math.max(minimum, 3)) : [...independent, ...ranked.filter(x => x.correlatedWithSource)].slice(0, Math.max(minimum, 3));
  }

  async firewallDecision(actor, action, detail = {}) {
    if (!this.k.authorityFirewall) return { actor, action, allowed: true, reason: 'FIREWALL_NOT_CONFIGURED', decisionHash: null, sequence: null };
    return this.k.authorityFirewall.decide(actor, action, detail);
  }

  decisionView(x) {
    return x ? { sequence: x.sequence || null, decisionHash: x.decisionHash || null, actor: x.actor, action: x.action, allowed: x.allowed, reason: x.reason, registryHash: x.registryHash || null, contractHash: x.contractHash || null } : null;
  }

  async plan(options = {}) {
    await this.init();
    const goal = this.normalizeGoal(options.goal);
    const remove = Array.isArray(options.remove) ? options.remove : String(options.remove || '').split(',').map(x => x.trim()).filter(Boolean);
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
    const rankedCorroborators = source ? this.rankCorroborators(contracts, geometry.capabilities || {}, source) : [];
    const corroborators = source ? this.selectCorroborators(rankedCorroborators, minimumCorroborators) : [];
    const independentCorroborators = corroborators.filter(x => !x.correlatedWithSource);
    if (source && independentCorroborators.length < minimumCorroborators) blockers.push({ type: 'INSUFFICIENT_INDEPENDENT_CORROBORATION', required: minimumCorroborators, availableIndependent: independentCorroborators.length });

    const firewall = [];
    firewall.push(await this.firewallDecision('recovery-navigator', 'PRESERVE_EVIDENCE', { goal, remove }));
    if (source) {
      const d = await this.firewallDecision(source.contract.id, 'RECONSTRUCT_SANDBOX', { goal, targets: source.target });
      firewall.push(d);
      if (!d.allowed) blockers.push({ type: 'FIREWALL_DENIED_RECONSTRUCTOR', actor: source.contract.id, reason: d.reason, decisionHash: d.decisionHash });
      for (const c of corroborators) {
        const cd = await this.firewallDecision(c.contract.id, 'CORROBORATE', { goal, source: source.contract.id });
        firewall.push(cd);
        if (!cd.allowed) blockers.push({ type: 'FIREWALL_DENIED_CORROBORATOR', actor: c.contract.id, reason: cd.reason, decisionHash: cd.decisionHash });
      }
      for (const [actor, action, label] of [['recovery-jury','NOMINATE_CANDIDATE','jury'],['jury-promotion-gate','OPEN_PROMOTION_CEREMONY','gate'],['promotion-ceremony','AUTHORIZE_INTENT','human-authority']]) {
        const d2 = await this.firewallDecision(actor, action, { goal });
        firewall.push(d2);
        if (!d2.allowed) blockers.push({ type: 'FIREWALL_DENIED_REQUIRED_PHASE', phase: label, actor, reason: d2.reason, decisionHash: d2.decisionHash });
      }
    }

    const terminalDenial = await this.firewallDecision('recovery-navigator', 'PROMOTE_CANONICAL', { goal, purpose: 'prove-plan-stops-at-authority-boundary' });
    firewall.push(terminalDenial);
    if (terminalDenial.allowed) blockers.push({ type: 'CRITICAL_FIREWALL_FAILURE_AUTOMATIC_PROMOTION_ALLOWED', decisionHash: terminalDenial.decisionHash });

    const findDecision = (actor, action) => firewall.find(x => x.actor === actor && x.action === action);
    const steps = [{ phase: 0, name: 'PRESERVE_EVIDENCE', authority: 'automatic-safe', action: 'Clone or copy all surviving evidence before any repair attempt; never mutate the sole surviving copy.', firewallDecision: this.decisionView(findDecision('recovery-navigator','PRESERVE_EVIDENCE')) }];
    if (source) {
      steps.push({ phase: 1, name: 'RECONSTRUCT_SANDBOX', authority: 'sandbox-only', source: source.contract.id, capability: source.capability, reconstructs: source.target, action: RECOVERY_HINTS[source.contract.id] || `Use ${source.contract.id} to reconstruct only into an isolated sandbox.`, forbidden: source.contract.forbidden, firewallDecision: this.decisionView(findDecision(source.contract.id,'RECONSTRUCT_SANDBOX')) });
      steps.push({ phase: 2, name: 'CANONICALIZE_CANDIDATE', authority: 'read-only-evidence', action: 'Run independent canonicalization quorum over the sandbox and record its semantic world hash. Divergence blocks promotion.' });
      steps.push({ phase: 3, name: 'INDEPENDENT_CORROBORATION', authority: 'read-only-evidence', channels: corroborators.map(x => ({ id: x.contract.id, capability: x.capability, corroborates: x.contract.corroborates, correlatedWithSource: x.correlatedWithSource, sharedDependencies: x.sharedDependencies, firewallDecision: this.decisionView(findDecision(x.contract.id,'CORROBORATE')) })), action: 'Challenge the reconstructed sandbox with non-reconstructive evidence. Preserve every contradiction.' });
      steps.push({ phase: 4, name: 'RECOVERY_JURY', authority: 'machine-nomination-only', action: 'Submit the persistent sandbox file to Recovery Jury. Only EXACT or STRONGLY_CORROBORATED is eligible for a promotion warrant.', firewallDecision: this.decisionView(findDecision('recovery-jury','NOMINATE_CANDIDATE')) });
      steps.push({ phase: 5, name: 'JURY_PROMOTION_GATE', authority: 'opens-human-ceremony-only', action: 'If Jury eligibility is sufficient, open the existing threshold promotion proposal. The gate does not approve or execute anything.', firewallDecision: this.decisionView(findDecision('jury-promotion-gate','OPEN_PROMOTION_CEREMONY')) });
      steps.push({ phase: 6, name: 'HUMAN_THRESHOLD_CEREMONY', authority: 'human-3-of-5-intent', action: 'Collect the required independent operator signatures. Even an authorized proposal remains separate from canonical-state execution.', firewallDecision: this.decisionView(findDecision('promotion-ceremony','AUTHORIZE_INTENT')) });
      steps.push({ phase: 7, name: 'MANUAL_PROMOTION_BOUNDARY', authority: 'operator-only-outside-navigator', action: 'Navigator stops here. Automatic canonical promotion is explicitly denied by Authority Firewall.', firewallDenial: this.decisionView(terminalDenial) });
    }

    const plan = {
      format: 'JSONDB-RECOVERY-NAVIGATOR-4',
      id: `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`,
      at: now(), goal,
      status: blockers.length ? 'BLOCKED' : 'PLAN_READY',
      requestedCounterfactualRemovals: remove,
      geometry: { coverage: geometry.summary?.coverage, survived: geometry.summary?.survived, total: geometry.summary?.total, failedScenarios: geometry.summary?.failed || [] },
      contractRegistryHash: registry.registryHash,
      source: source ? { id: source.contract.id, capability: source.capability, score: source.score, reconstructs: source.target } : null,
      alternateReconstructors: reconstructors.slice(1, 8).map(x => ({ id: x.contract.id, capability: x.capability, score: x.score, reconstructs: x.target })),
      corroborators: corroborators.map(x => ({ id: x.contract.id, capability: x.capability, score: x.score, correlatedWithSource: x.correlatedWithSource, sharedDependencies: x.sharedDependencies })),
      firewall: firewall.map(x => this.decisionView(x)),
      blockers, steps,
      authority: { executesRecovery: false, writesCanonicalState: false, mayOpenPromotionCeremony: false, automaticCanonicalPromotion: false, maximumMachineAuthority: 'nominate a persistent sandbox for Recovery Jury after independently corroborated reconstruction' },
      doctrine: 'Goal semantics prevent tooling recovery from masquerading as world recovery. One system reconstructs; different systems corroborate; Authority Firewall attests every authority class; machines may nominate; humans authorize; Navigator never promotes.'
    };
    plan.planHash = digest(plan);
    await atomicJson(path.join(this.plans, `${plan.id}.json`), plan);
    await atomicJson(path.join(this.root, 'latest.json'), plan);
    return plan;
  }

  async verify(id = null) {
    await this.init();
    const plan = id ? await readJson(path.join(this.plans, `${id}.json`), null) : await readJson(path.join(this.root, 'latest.json'), null);
    if (!plan) return { valid: false, status: 'ABSENT' };
    const copy = { ...plan }; delete copy.planHash;
    const computed = digest(copy);
    const authoritySafe = plan.authority?.writesCanonicalState === false && plan.authority?.automaticCanonicalPromotion === false;
    const terminal = [...(plan.firewall || [])].reverse().find(x => x.action === 'PROMOTE_CANONICAL');
    const terminalPromotionDenied = Boolean(terminal && terminal.allowed === false);
    const [historicalContracts, currentContracts, firewallReferences, liveFirewall] = await Promise.all([
      this.k.recoveryContracts.version(plan.contractRegistryHash).catch(() => null),
      this.k.recoveryContracts.init().catch(() => null),
      this.k.authorityFirewall ? this.k.authorityFirewall.verifyReferences(plan.firewall || []).catch(error => ({ valid: false, error: error.message })) : Promise.resolve({ valid: true }),
      this.k.authorityFirewall ? this.k.authorityFirewall.verifyLedger().catch(error => ({ valid: false, error: error.message })) : Promise.resolve({ valid: true })
    ]);
    const historicalRegistryAvailable = Boolean(historicalContracts?.registryHash && historicalContracts.registryHash === plan.contractRegistryHash);
    const currentRegistryMatches = Boolean(currentContracts?.registryHash && currentContracts.registryHash === plan.contractRegistryHash);
    return {
      valid: computed === plan.planHash && authoritySafe && terminalPromotionDenied && historicalRegistryAvailable && firewallReferences.valid === true,
      id: plan.id,
      goal: plan.goal,
      status: plan.status,
      expectedPlanHash: plan.planHash,
      computedPlanHash: computed,
      authoritySafe,
      terminalPromotionDenied,
      historicalRegistryAvailable,
      currentRegistryMatches,
      policyDriftedSincePlan: historicalRegistryAvailable && !currentRegistryMatches,
      firewallReferencesValid: firewallReferences.valid,
      firewallPrefixValid: firewallReferences.prefix?.valid,
      liveFirewallLedgerValid: liveFirewall.valid,
      futureTailIncident: firewallReferences.valid === true && liveFirewall.valid === false,
      blockers: plan.blockers || []
    };
  }
}

module.exports = { RecoveryNavigator, CAPABILITY_MAP };
