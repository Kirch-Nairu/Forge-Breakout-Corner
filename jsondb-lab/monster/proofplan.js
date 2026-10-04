'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

class ProofCarryingRecoveryPlan {
  constructor(kernel) {
    this.k = kernel;
    this.root = path.join(kernel.savior.root, 'proof-carrying-recovery-plans');
    this.records = path.join(this.root, 'records');
  }

  async init() { await ensureDir(this.records); }

  async loadPlan(id = null) {
    return id
      ? readJson(path.join(this.k.recoveryNavigator.plans, `${id}.json`), null)
      : readJson(path.join(this.k.recoveryNavigator.root, 'latest.json'), null);
  }

  async create(label = 'proof-plan', options = {}) {
    await this.init();
    const plan = await this.loadPlan(options.planId || null);
    if (!plan) throw new Error('Proof plan requires an existing Recovery Navigator plan.');
    const planCheck = await this.k.recoveryNavigator.verify(plan.id);
    if (!planCheck.valid) throw new Error('Recovery Navigator plan failed verification.');
    if (plan.status !== 'PLAN_READY' && options.allowBlocked !== true) throw new Error(`Recovery Navigator plan is ${plan.status}.`);

    const registry = await this.k.recoveryContracts.version(plan.contractRegistryHash);
    if (!registry || registry.registryHash !== plan.contractRegistryHash) throw new Error('Historical Recovery Contract registry for the Navigator plan is unavailable.');
    const policy = await this.k.policyCheckpoint.capture(`${label}:policy`);
    const sourceContract = plan.source?.id ? registry.contracts?.[plan.source.id] || null : null;
    const corroboratorContracts = (plan.corroborators || []).map(x => ({ plan: x, contract: registry.contracts?.[x.id] || null }));
    const terminal = [...(plan.firewall || [])].reverse().find(x => x.action === 'PROMOTE_CANONICAL') || null;
    if (!terminal || terminal.allowed !== false) throw new Error('Proof plan requires an explicit Firewall denial of automatic canonical promotion.');

    const core = {
      format: 'JSONDB-PROOF-CARRYING-RECOVERY-PLAN-2',
      id: `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
      label,
      createdAt: now(),
      navigator: {
        id: plan.id,
        planHash: plan.planHash,
        goal: plan.goal,
        status: plan.status,
        source: plan.source,
        corroborators: plan.corroborators,
        blockers: plan.blockers || [],
        steps: plan.steps || []
      },
      contracts: {
        registryHash: registry.registryHash,
        source: sourceContract,
        corroborators: corroboratorContracts
      },
      authority: {
        firewallDecisions: plan.firewall || [],
        terminalPromotionDenial: terminal,
        policyCheckpoint: {
          id: policy.id,
          checkpointHash: policy.checkpointHash,
          firewallHead: policy.firewall?.headHash || null
        }
      },
      doctrine: [
        'This dossier carries historical evidence references and authority decisions; it is not canonical-state authority.',
        'The exact Recovery Contract registry used by the Navigator plan is preserved by content hash.',
        'Reconstructive and corroborative roles remain separate.',
        'Automatic canonical promotion was denied when this dossier was sealed.',
        'Human threshold approval remains outside this dossier.'
      ]
    };
    const coreHash = digest(core);
    const [cryptoAttestation, forwardAttestation] = await Promise.all([
      this.k.cryptoCouncil.attest(coreHash, { purpose: 'proof-carrying-recovery-plan', dossierId: core.id, navigatorPlanId: plan.id }),
      this.k.forwardWitness.attest(coreHash, { purpose: 'proof-carrying-recovery-plan', dossierId: core.id, navigatorPlanId: plan.id })
    ]);

    const dossier = {
      ...core,
      coreHash,
      cryptoCouncil: { id: cryptoAttestation.id, worldRoot: cryptoAttestation.worldRoot, familyQuorum: cryptoAttestation.familyQuorum },
      forwardWitness: { sequence: forwardAttestation.statement.sequence, subjectHash: forwardAttestation.statement.subjectHash, attestationHash: forwardAttestation.attestationHash }
    };
    dossier.dossierHash = digest(dossier);
    await atomicJson(path.join(this.records, `${dossier.id}.json`), dossier);
    await atomicJson(path.join(this.root, 'latest.json'), dossier);
    return dossier;
  }

  async verify(id = null) {
    await this.init();
    const dossier = id
      ? await readJson(path.join(this.records, `${id}.json`), null)
      : await readJson(path.join(this.root, 'latest.json'), null);
    if (!dossier) return { valid: false, status: 'ABSENT' };

    const copy = { ...dossier };
    delete copy.dossierHash;
    const staticValid = digest(copy) === dossier.dossierHash;

    const coreCopy = { ...dossier };
    delete coreCopy.coreHash;
    delete coreCopy.cryptoCouncil;
    delete coreCopy.forwardWitness;
    delete coreCopy.dossierHash;
    const coreValid = digest(coreCopy) === dossier.coreHash;

    const [plan, policy, crypto, forward, historicalRegistry, currentRegistry] = await Promise.all([
      this.k.recoveryNavigator.verify(dossier.navigator?.id || null).catch(error => ({ valid: false, error: error.message })),
      this.k.policyCheckpoint.verify(dossier.authority?.policyCheckpoint?.id || null).catch(error => ({ valid: false, error: error.message })),
      this.k.cryptoCouncil.verify(dossier.cryptoCouncil?.id).catch(error => ({ valid: false, error: error.message })),
      this.k.forwardWitness.verifyAll().catch(error => ({ valid: false, error: error.message })),
      this.k.recoveryContracts.version(dossier.contracts?.registryHash || null).catch(() => null),
      this.k.recoveryContracts.init().catch(() => null)
    ]);
    const forwardRecord = forward.results?.find(x => x.sequence === dossier.forwardWitness?.sequence) || null;
    const forwardValid = Boolean(forward.valid && forwardRecord?.valid && forwardRecord.subjectHash === dossier.coreHash && forwardRecord.attestationHash === dossier.forwardWitness.attestationHash);
    const cryptoValid = Boolean(crypto.valid && crypto.worldRoot === dossier.coreHash && Number(crypto.familyQuorum || 0) >= 2);
    const terminal = dossier.authority?.terminalPromotionDenial;
    const terminalDenied = Boolean(terminal && terminal.allowed === false);
    const historicalRegistryAvailable = Boolean(historicalRegistry?.registryHash && historicalRegistry.registryHash === dossier.contracts?.registryHash);
    const currentRegistryMatches = Boolean(currentRegistry?.registryHash && currentRegistry.registryHash === dossier.contracts?.registryHash);

    return {
      format: 'JSONDB-PROOF-CARRYING-RECOVERY-PLAN-VERIFY-2',
      id: dossier.id,
      valid: staticValid && coreValid && plan.valid && policy.valid && cryptoValid && forwardValid && terminalDenied && historicalRegistryAvailable,
      staticValid,
      coreValid,
      navigatorValid: plan.valid,
      policyCheckpointValid: policy.valid,
      cryptoCouncilValid: cryptoValid,
      forwardWitnessValid: forwardValid,
      terminalPromotionDenied: terminalDenied,
      historicalRegistryAvailable,
      currentRegistryMatches,
      policyDriftedSinceDossier: historicalRegistryAvailable && !currentRegistryMatches,
      goal: dossier.navigator?.goal,
      source: dossier.navigator?.source?.id || null
    };
  }
}

module.exports = { ProofCarryingRecoveryPlan };
