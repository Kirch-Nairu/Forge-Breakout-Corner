'use strict';

const path = require('path');
const { OmegaKernel } = require('./omega-kernel');
const { OmegaEpochSealer } = require('./omegaepoch');
const { HistoryCourt } = require('./historycourt');
const { TemporalParityArchive } = require('./temporalparity');
const { TimeWeave } = require('./timeweave');
const { OmegaFederation } = require('./omegafederation');
const { SemanticHologram } = require('./hologram');
const { EvidenceDiaspora } = require('./evidencediaspora');
const { QuaternaryColdCodec } = require('./quaternary');
const { RosettaCapsule } = require('./rosetta');
const { ShadowLawEngine } = require('./shadowlaws');
const { ForwardWitnessRatchet } = require('./forwardwitness');
const { SpacetimeArk } = require('./spacetimeark');
const { SemanticDeltaFossils } = require('./fossils');
const { RecoveryGeometry } = require('./recoverygeometry');
const { RecoveryContractRegistry } = require('./recoverycontracts');
const { AuthorityFirewall } = require('./authorityfirewall');
const { RecoveryNavigator } = require('./recoverynavigator');
const { PolicyCheckpoint } = require('./policycheckpoint');
const { LastSaviorArchive } = require('./lastsavior');
const { RecoveryJury } = require('./recoveryjury');
const { JuryPromotionGate } = require('./jurygate');
const { readJson } = require('./jsonfs');

class FederatedOmegaKernel extends OmegaKernel {
  constructor(root, options = {}) {
    super(root, options);
    this.epochSealer = new OmegaEpochSealer(this);
    this.historyCourt = new HistoryCourt({ savior: this.savior, worldTree: this.worldTree, chronicle: this.chronicle, braid: this.braid, cryptoCouncil: this.cryptoCouncil, memory: this.memory, polyhash: this.polyhash });
    this.temporalParity = new TemporalParityArchive({ savior: this.savior, omegaEpochRoot: this.epochSealer.root });
    this.timeWeave = new TimeWeave({ savior: this.savior, omegaEpochRoot: this.epochSealer.root, polyhash: this.polyhash });
    this.hologram = new SemanticHologram({ engine: this.engine, savior: this.savior });
    this.diaspora = new EvidenceDiaspora({ savior: this.savior, constellation: this.constellation, polyhash: this.polyhash });
    this.quaternary = new QuaternaryColdCodec({ savior: this.savior });
    this.rosetta = new RosettaCapsule({ savior: this.savior, polyhash: this.polyhash });
    this.shadowLaws = new ShadowLawEngine({ engine: this.engine, savior: this.savior, cryptoCouncil: this.cryptoCouncil });
    this.forwardWitness = new ForwardWitnessRatchet(this.savior);
    this.spacetime = new SpacetimeArk({ savior: this.savior, omegaEpochRoot: this.epochSealer.root, constellation: this.constellation });
    this.fossils = new SemanticDeltaFossils({ savior: this.savior, memory: this.memory });
    this.federation = new OmegaFederation({ savior: this.savior, epochSealer: this.epochSealer, timeWeave: this.timeWeave, temporalParity: this.temporalParity, historyCourt: this.historyCourt, worldTree: this.worldTree, polyhash: this.polyhash, hologram: this.hologram });
    this.recoveryContracts = new RecoveryContractRegistry(this.savior);
    this.authorityFirewall = new AuthorityFirewall({ savior: this.savior, contracts: this.recoveryContracts });
    this.lastSavior = new LastSaviorArchive(this);
    this.recoveryJury = new RecoveryJury(this);
    this.juryGate = new JuryPromotionGate({ savior: this.savior, jury: this.recoveryJury, promotion: this.promotion, firewall: this.authorityFirewall });
    this.recoveryGeometry = new RecoveryGeometry(this);
    this.recoveryNavigator = new RecoveryNavigator(this);
    this.policyCheckpoint = new PolicyCheckpoint(this);
    this.federatedInitialized = false;
  }

  async init(options = {}) {
    await super.init(options);
    if (this.federatedInitialized) return this;
    for (const system of [this.epochSealer, this.historyCourt, this.temporalParity, this.timeWeave, this.hologram, this.diaspora, this.quaternary, this.rosetta, this.shadowLaws, this.forwardWitness, this.spacetime, this.fossils, this.federation, this.recoveryContracts, this.authorityFirewall, this.lastSavior, this.recoveryJury, this.juryGate, this.recoveryGeometry, this.recoveryNavigator, this.policyCheckpoint]) {
      if (system && typeof system.init === 'function') await system.init();
    }
    this.federatedInitialized = true;
    return this;
  }

  async archiveWorldQuaternary(label = 'federated-world', options = {}) { const world = await this.world(); return this.quaternary.archiveBuffer(label, Buffer.from(JSON.stringify(world)), options); }

  async status(options = {}) {
    await this.init();
    const base = await super.status(options);
    const [weave, federation, latestEpoch, latestParity, latestCourt, latestHologram, latestDiaspora, latestQuaternary, latestRosetta, latestShadowLaws, forwardWitness, latestSpacetime, latestSpacetimePlacement, latestFossil, latestGeometry, latestContractAnalysis, firewallLedger, latestNavigator, latestPolicyCheckpoint, policyCheckpointVerify, latestLastSavior, latestJury, latestWarrant] = await Promise.all([
      this.timeWeave.verifyAll().catch(error => ({ valid: false, error: error.message })),
      this.federation.verify(null, { live: false }).catch(error => ({ valid: false, status: 'ABSENT', error: error.message })),
      readJson(path.join(this.epochSealer.root, 'latest.json'), null),
      readJson(path.join(this.temporalParity.root, 'latest.json'), null),
      readJson(path.join(this.historyCourt.root, 'latest.json'), null),
      readJson(path.join(this.hologram.root, 'latest.json'), null),
      readJson(path.join(this.diaspora.root, 'latest-placement.json'), null),
      readJson(path.join(this.quaternary.root, 'latest.json'), null),
      readJson(path.join(this.rosetta.root, 'latest.json'), null),
      readJson(path.join(this.shadowLaws.root, 'latest.json'), null),
      this.forwardWitness.verifyAll().catch(error => ({ valid: false, error: error.message })),
      readJson(path.join(this.spacetime.root, 'latest.json'), null),
      readJson(path.join(this.spacetime.root, 'latest-placement.json'), null),
      readJson(path.join(this.fossils.root, 'latest.json'), null),
      readJson(path.join(this.recoveryGeometry.root, 'latest.json'), null),
      readJson(path.join(this.recoveryContracts.root, 'latest-analysis.json'), null),
      this.authorityFirewall.verifyLedger().catch(error => ({ valid: false, error: error.message })),
      readJson(path.join(this.recoveryNavigator.root, 'latest.json'), null),
      readJson(path.join(this.policyCheckpoint.root, 'latest.json'), null),
      this.policyCheckpoint.verify().catch(error => ({ valid: false, status: 'ABSENT', error: error.message })),
      readJson(path.join(this.lastSavior.root, 'latest.json'), null),
      readJson(path.join(this.recoveryJury.root, 'latest.json'), null),
      readJson(path.join(this.juryGate.root, 'latest.json'), null)
    ]);
    return {
      ...base,
      format: 'JSONDB-FEDERATED-OMEGA-KERNEL-STATUS-14',
      historicalSurvival: {
        latestOmegaEpoch: latestEpoch ? { id: latestEpoch.id, epochHash: latestEpoch.epochHash, semanticWorldSha256: latestEpoch.semanticWorldSha256 } : null,
        timeWeave: { valid: weave.valid, nodes: weave.nodes, invalidNodes: weave.invalid?.length || 0 },
        temporalParity: latestParity,
        spacetimeArk: latestSpacetime,
        spacetimePlacement: latestSpacetimePlacement ? { id: latestSpacetimePlacement.id, distinctDeviceKeys: latestSpacetimePlacement.distinctDeviceKeys, placements: latestSpacetimePlacement.placements?.length || 0 } : null,
        semanticDeltaFossil: latestFossil ? { id: latestFossil.id, format: latestFossil.format, changeCount: latestFossil.changeCount ?? latestFossil.changes, from: latestFossil.from || null, to: latestFossil.to || { memoryId: latestFossil.toMemoryId } } : null,
        recoveryGeometry: latestGeometry ? latestGeometry.summary : null,
        recoveryContracts: latestContractAnalysis ? { valid: latestContractAnalysis.valid, registryHash: latestContractAnalysis.registryHash, violations: latestContractAnalysis.violations?.length || 0, contracts: latestContractAnalysis.summary?.contracts } : null,
        authorityFirewall: { valid: firewallLedger.valid, decisions: firewallLedger.decisions, headHash: firewallLedger.headHash, failures: firewallLedger.failures?.length || 0 },
        recoveryNavigator: latestNavigator ? { id: latestNavigator.id, status: latestNavigator.status, goal: latestNavigator.goal, source: latestNavigator.source?.id || null, blockers: latestNavigator.blockers?.length || 0 } : null,
        policyCheckpoint: latestPolicyCheckpoint ? { id: latestPolicyCheckpoint.id, checkpointHash: latestPolicyCheckpoint.checkpointHash, firewallHead: latestPolicyCheckpoint.firewall?.headHash || null, valid: policyCheckpointVerify.valid } : null,
        federation: { valid: federation.valid, id: federation.id, staticValid: federation.staticValid, error: federation.error },
        latestHistoryCourt: latestCourt ? { id: latestCourt.id, verdict: latestCourt.verdict, caseHash: latestCourt.caseHash } : null,
        semanticHologram: latestHologram ? { id: latestHologram.id, hologramHash: latestHologram.hologramHash, capturedAt: latestHologram.capturedAt } : null,
        shadowLaws: latestShadowLaws ? { id: latestShadowLaws.id, recordHash: latestShadowLaws.recordHash, createdAt: latestShadowLaws.createdAt } : null,
        forwardWitness: { valid: forwardWitness.valid, records: forwardWitness.records, headHash: forwardWitness.headHash, caveat: forwardWitness.caveat },
        evidenceDiaspora: latestDiaspora ? { id: latestDiaspora.id, validCopies: latestDiaspora.validCopies, distinctDeviceKeys: latestDiaspora.distinctDeviceKeys, apparentIndependenceRatio: latestDiaspora.apparentIndependenceRatio } : null,
        quaternaryColdCodec: latestQuaternary,
        rosettaCapsule: latestRosetta,
        lastSaviorArchive: latestLastSavior ? { id: latestLastSavior.id, archiveHash: latestLastSavior.archiveHash, createdAt: latestLastSavior.createdAt } : null,
        recoveryJury: latestJury ? { id: latestJury.id, verdict: latestJury.verdict, confidence: latestJury.confidence, juryHash: latestJury.juryHash } : null,
        juryPromotionGate: latestWarrant ? { id: latestWarrant.id, proposalId: latestWarrant.proposal?.id, juryId: latestWarrant.jury?.id } : null
      }
    };
  }
}

module.exports = { FederatedOmegaKernel };
