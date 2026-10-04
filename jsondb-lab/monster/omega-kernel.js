'use strict';

const path = require('path');

const { MonsterEngine } = require('./engine');
const { SaviorSystem } = require('./savior');
const { TemporalQuorumGuardian } = require('./guardian');
const { OrthogonalArk } = require('./orthogonal');
const { SemanticChronicle } = require('./chronicle');
const { TruthLattice } = require('./truth');
const { WitnessCouncil } = require('./witnesses');
const { JsonImmuneSystem } = require('./immune');
const { TrinityArk } = require('./trinity');
const { SurvivorGenome } = require('./genome');
const { FractalQuorum } = require('./fractal');
const { MetamorphicVerifier } = require('./metamorphic');
const { CrossHistoryBraid } = require('./braid');
const { SurvivalOracle } = require('./oracle');
const { SurvivalFabric } = require('./fabric');
const { FailureDomainTrustBudget } = require('./trustbudget');
const { ChallengeScrubber } = require('./challenge');
const { MemoryPalace } = require('./memorypalace');
const { NVersionMutationGuard } = require('./nversion');
const { RepairConstitution } = require('./repairpolicy');
const { ProtectedCommitCoordinator } = require('./protected');
const { BootSentinel } = require('./bootsentinel');
const { SovereignClock } = require('./clockguard');
const { RuntimeGuard } = require('./runtimeguard');
const { DurabilityRealityCheck } = require('./durability');
const { HashPolyglot } = require('./polyhash');
const { FormatPolyglotCapsule } = require('./formatpolyglot');
const { FountainArk } = require('./fountain');
const { CivilizationSeed } = require('./seed');
const { WorldTree } = require('./worldtree');
const { HashWitnessCouncil } = require('./hashwitness');
const { CryptographicCouncil } = require('./cryptocouncil');
const { PromotionCeremony } = require('./promotion');
const { SyndromeMesh } = require('./syndromemesh');
const { SelfPreservationReflex } = require('./reflex');
const { FailureDomainRegistry } = require('./failuredomains');
const { MediaConstellation } = require('./constellation');
const { CompatibilityTimeCapsule } = require('./compatibility');
const { ConservationLawEngine } = require('./conservation');
const { AirGapCourier } = require('./courier');
const { CanonicalizationQuorum } = require('./canonicalquorum');
const { ThresholdKeyShardVault } = require('./keyshards');
const { now, readJson } = require('./jsonfs');

class OmegaKernel {
  constructor(root, options = {}) {
    this.root = root;
    this.options = options;

    this.engine = new MonsterEngine(root);
    this.savior = new SaviorSystem(this.engine, { cells: options.mirrorCells || 5 });
    this.guardian = new TemporalQuorumGuardian(this.savior);
    this.orthogonal = new OrthogonalArk(this.engine, this.savior);
    this.chronicle = new SemanticChronicle(this.engine, path.join(this.savior.root, 'semantic-chronicle'));
    this.truth = new TruthLattice(this.savior, this.guardian, this.orthogonal);
    this.witnessCouncil = new WitnessCouncil(path.join(this.savior.root, 'witness-council'), options.witnessMembers || 7, options.witnessThreshold || 5);
    this.immune = new JsonImmuneSystem(this.engine, path.join(this.savior.root, 'immune'));
    this.trinity = new TrinityArk(this.engine, this.savior);
    this.genome = new SurvivorGenome({ engine: this.engine, savior: this.savior, orthogonal: this.orthogonal, council: this.witnessCouncil });
    this.fractal = new FractalQuorum(this.savior);
    this.metamorphic = new MetamorphicVerifier(this.engine, this.savior);
    this.braid = new CrossHistoryBraid({ savior: this.savior, guardian: this.guardian, chronicle: this.chronicle, council: this.witnessCouncil, truth: this.truth, immune: this.immune, orthogonal: this.orthogonal, trinity: this.trinity });
    this.trustBudget = new FailureDomainTrustBudget();
    this.challenge = new ChallengeScrubber({ savior: this.savior, braid: this.braid });
    this.memory = new MemoryPalace(this.engine, this.savior, { vaults: options.memoryVaults || 3 });
    this.nversion = new NVersionMutationGuard(this.engine, this.savior);
    this.repair = new RepairConstitution(this.engine, this.savior);
    this.oracle = new SurvivalOracle({ savior: this.savior, guardian: this.guardian, truth: this.truth, orthogonal: this.orthogonal, council: this.witnessCouncil, immune: this.immune, chronicle: this.chronicle, braid: this.braid, trinity: this.trinity, genome: this.genome });
    this.fabric = new SurvivalFabric({ engine: this.engine, savior: this.savior, guardian: this.guardian, truth: this.truth, council: this.witnessCouncil, immune: this.immune, orthogonal: this.orthogonal, trinity: this.trinity, genome: this.genome, fractal: this.fractal, metamorphic: this.metamorphic, chronicle: this.chronicle, braid: this.braid, oracle: this.oracle, trustBudget: this.trustBudget, challenge: this.challenge });
    this.protectedCommit = new ProtectedCommitCoordinator({ engine: this.engine, savior: this.savior, chronicle: this.chronicle, guardian: this.guardian, council: this.witnessCouncil, orthogonal: this.orthogonal, braid: this.braid, fabric: this.fabric, nversion: this.nversion, memoryPalace: this.memory });

    this.bootSentinel = new BootSentinel(this.savior, { staleMs: options.bootLeaseStaleMs || 30_000 });
    this.clock = new SovereignClock(this.savior, { rollbackToleranceMs: options.clockRollbackToleranceMs || 2_000 });
    this.runtime = new RuntimeGuard({ savior: this.savior, bootSentinel: this.bootSentinel, clock: this.clock, heartbeatMs: options.heartbeatMs || 10_000 });
    this.durability = new DurabilityRealityCheck(this.savior);
    this.polyhash = new HashPolyglot(path.join(this.savior.root, 'hash-polyglot'));
    this.formatCapsule = new FormatPolyglotCapsule(this.engine, this.savior);
    this.fountain = new FountainArk(path.join(this.savior.root, 'fountain-ark'));
    this.civilizationSeed = new CivilizationSeed({ engine: this.engine, savior: this.savior, genome: this.genome, council: this.witnessCouncil, braid: this.braid, repair: this.repair, polyhash: this.polyhash, trinity: this.trinity, orthogonal: this.orthogonal, memoryPalace: this.memory, fountain: this.fountain, formatPolyglot: this.formatCapsule });

    this.worldTree = new WorldTree({ memoryPalace: this.memory, savior: this.savior });
    this.hashWitnessCouncil = new HashWitnessCouncil(path.join(this.savior.root, 'hash-witness-council'), { members: options.hashWitnessMembers || 5, threshold: options.hashWitnessThreshold || 3, reservePerMember: options.lamportReserve || 8 });
    this.cryptoCouncil = new CryptographicCouncil({ savior: this.savior, ed25519Council: this.witnessCouncil, hashWitnessCouncil: this.hashWitnessCouncil });
    this.promotion = new PromotionCeremony(this.savior, { operatorCount: options.promotionOperators || 5, threshold: options.promotionThreshold || 3 });
    this.syndrome = new SyndromeMesh({ savior: this.savior, braid: this.braid });
    this.mediaRegistry = new FailureDomainRegistry(path.join(this.savior.root, 'media-constellation', 'registry'));
    this.constellation = new MediaConstellation({ savior: this.savior, civilizationSeed: this.civilizationSeed, fountain: this.fountain, registry: this.mediaRegistry });
    this.compatibility = new CompatibilityTimeCapsule(this.engine, this.savior);
    this.conservation = new ConservationLawEngine(this.engine, this.savior);
    this.courier = new AirGapCourier({ savior: this.savior, chronicle: this.chronicle, braid: this.braid, witnessCouncil: this.witnessCouncil, worldTree: this.worldTree, polyhash: this.polyhash });
    this.canonicalQuorum = new CanonicalizationQuorum(this.savior);
    this.keyShards = new ThresholdKeyShardVault(path.join(this.savior.root, 'threshold-key-shards'));
    this.reflex = new SelfPreservationReflex({ savior: this.savior, oracle: this.oracle, trustBudget: this.trustBudget, fabric: this.fabric, challenge: this.challenge, memory: this.memory, trinity: this.trinity, formatCapsule: this.formatCapsule, civilizationSeed: this.civilizationSeed, runtime: this.runtime, clock: this.clock, durability: this.durability });

    this.initialized = false;
  }

  async init(options = {}) {
    if (this.initialized) return this;
    await this.engine.init();
    const systems = [
      this.fabric, this.memory, this.repair, this.polyhash, this.formatCapsule,
      this.fountain, this.civilizationSeed, this.worldTree, this.hashWitnessCouncil,
      this.cryptoCouncil, this.promotion, this.syndrome, this.constellation,
      this.compatibility, this.conservation, this.courier, this.canonicalQuorum,
      this.keyShards, this.reflex
    ];
    for (const system of systems) if (system && typeof system.init === 'function') await system.init();
    if (options.runtime === true) await this.beginRuntime(options.runtimeMetadata || {});
    this.initialized = true;
    return this;
  }

  async beginRuntime(metadata = {}) {
    const result = await this.runtime.begin({ kernel: 'JSONDB-OMEGA', ...metadata });
    this.runtime.startHeartbeat();
    return result;
  }

  async stopRuntime(reason = 'OMEGA kernel shutdown') { return this.runtime.shutdown(reason); }

  async world() {
    const catalog = await this.engine.catalog();
    const meta = await this.engine.meta();
    const tables = {};
    for (const name of Object.keys(catalog.collections || {}).sort()) tables[name] = await this.engine.loadCurrent(name);
    return { format: 'JSONDB-OMEGA-WORLD-1', catalog, meta, tables };
  }

  async status(options = {}) {
    await this.init();
    const deep = options.deep === true;
    const [fabric, runtime, reflex, conservation, syndrome, crypto, media, compatibility, canonical] = await Promise.all([
      this.fabric.status({ deep }).catch(error => ({ error: error.message })),
      this.runtime.status().catch(error => ({ error: error.message })),
      this.reflex.sense({ verifyArchives: deep }).catch(error => ({ error: error.message })),
      this.conservation.scan({ freezeOnViolation: false }).catch(error => ({ status: 'UNAVAILABLE', error: error.message })),
      this.syndrome.diagnose().catch(error => ({ status: 'UNAVAILABLE', error: error.message })),
      this.cryptoCouncil.verify().catch(error => ({ valid: false, status: 'UNAVAILABLE', error: error.message })),
      this.constellation.assess().catch(error => ({ error: error.message })),
      this.compatibility.verify().catch(error => ({ valid: false, status: 'ABSENT', error: error.message })),
      this.canonicalQuorum.verify(await this.world(), { freezeOnDivergence: false }).catch(error => ({ unanimous: false, error: error.message }))
    ]);
    return {
      format: 'JSONDB-OMEGA-KERNEL-STATUS-1', at: now(),
      savior: await this.savior.status(),
      engine: await this.engine.status(),
      fabric: fabric.summary || fabric,
      runtime,
      reflex: { level: reflex.level, reasons: reflex.reasons },
      conservation: { status: conservation.status, violations: conservation.violations, criticalViolations: conservation.criticalViolations },
      syndrome: { status: syndrome.status, failedChecks: syndrome.failedChecks, suspects: syndrome.suspects?.slice(0,10) },
      cryptographicCouncil: { valid: crypto.valid, status: crypto.status, familyQuorum: crypto.familyQuorum },
      physicalMedia: media.comparison ? { roots: media.comparison.roots, distinctDeviceKeys: media.comparison.distinctDeviceKeys, collisions: media.comparison.collisions } : media,
      compatibility: { valid: compatibility.valid, status: compatibility.status, id: compatibility.id },
      canonicalizationQuorum: { unanimous: canonical.unanimous, semanticSha256: canonical.semanticSha256 },
      latest: {
        memory: await readJson(path.join(this.memory.root, 'latest.json'), null),
        seed: await readJson(path.join(this.civilizationSeed.root, 'latest.json'), null),
        fountain: await readJson(path.join(this.fountain.root, 'latest.json'), null),
        format: await readJson(path.join(this.formatCapsule.root, 'latest.json'), null),
        worldTreeMain: await this.worldTree.ref('main').catch(()=>null)
      }
    };
  }
}

module.exports = { OmegaKernel };
