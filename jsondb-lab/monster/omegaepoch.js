'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, uuid, ensureDir, atomicJson } = require('./jsonfs');
const { StatePassportOffice } = require('./passport');
const { MerkleProofRegistry } = require('./merkleproof');
const { SurvivalCalculus } = require('./survivalcalculus');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

class OmegaEpochSealer {
  constructor(kernel) {
    this.k = kernel;
    this.root = path.join(kernel.savior.root, 'omega-epochs');
    this.epochs = path.join(this.root, 'epochs');
    this.proofs = new MerkleProofRegistry(kernel.engine, kernel.savior);
    this.calculus = new SurvivalCalculus(path.join(kernel.savior.root, 'survival-calculus'));
    this.passports = new StatePassportOffice({
      engine: kernel.engine,
      savior: kernel.savior,
      canonicalQuorum: kernel.canonicalQuorum,
      chronicle: kernel.chronicle,
      braid: kernel.braid,
      witnessCouncil: kernel.witnessCouncil,
      cryptoCouncil: kernel.cryptoCouncil,
      trinity: kernel.trinity,
      conservation: kernel.conservation,
      oracle: kernel.oracle,
      trustBudget: kernel.trustBudget,
      polyhash: kernel.polyhash,
      memory: kernel.memory
    });
  }

  async init() {
    await ensureDir(this.epochs);
    await this.proofs.init();
    await this.calculus.init();
    await this.passports.init();
  }

  async seal(label = 'omega-epoch', options = {}) {
    await this.init();
    const world = await this.k.world();
    const canonical = await this.k.canonicalQuorum.verify(world, { freezeOnDivergence: true });
    if (!canonical.unanimous) throw new Error('OMEGA epoch refused: canonicalization quorum diverged.');

    const fabric = await this.k.fabric.seal(`${label}:fabric`, {
      level: 'ULTIMATE', trinity: true, genome: true, challenge: true,
      verifyArchives: options.verifyArchives === true,
      enforceTrustBudget: true
    });

    const memory = await this.k.memory.snapshot(`${label}:memory`);
    const worldCommit = await this.k.worldTree.commitCurrent(`${label}:world-tree`, options.ref || 'main', { omegaEpoch: true });
    const merkleWorld = await this.proofs.buildWorld(`${label}:merkle`);
    const compatibility = await this.k.compatibility.capture(`${label}:compatibility`);
    const conservation = await this.k.conservation.scan({ freezeOnViolation: true });
    const syndrome = await this.k.syndrome.build({ checksPerNode: Number(options.syndromeChecksPerNode || 8) });
    const syndromeDiagnosis = await this.k.syndrome.diagnose(syndrome.generation);

    const temporal = await this.k.guardian.witnessRound(`${label}:crypto-root`);
    const crypto = await this.k.cryptoCouncil.attest(temporal.worldRoot, {
      label, semanticWorldSha256: canonical.semanticSha256,
      merkleWorldRoot: merkleWorld.worldRoot,
      worldTreeCommit: worldCommit.id
    });

    const passport = await this.passports.issue(`${label}:passport`, {
      verifyRecovery: options.verifyArchives !== false,
      freezeOnDivergence: true,
      freezeOnViolation: true
    });

    const calculus = await this.calculus.analyze(this.calculus.omegaTemplate(), {
      maxOrder: Number(options.maxCutOrder || 4),
      iterations: Number(options.monteCarloIterations || 10000),
      seed: canonical.semanticSha256,
      domains: options.domainFailureProbabilities || {
        'disk-a': .02, 'disk-b': .02, 'disk-c': .02, 'disk-d': .02,
        'cold-media': .01, 'software-node': .01, 'runtime-node': .02, 'runtime-python': .02,
        'metadata-media': .01
      }
    });

    let format = null;
    let fountain = null;
    let seed = null;
    if (options.deepMedia !== false) {
      format = await this.k.formatCapsule.archive(`${label}:format`);
      const buffer = Buffer.from(JSON.stringify(world));
      fountain = await this.k.fountain.archiveBuffer(`${label}:fountain`, buffer, {
        sourceChunks: Number(options.fountainSourceChunks || 0) || undefined,
        redundancy: Number(options.fountainRedundancy || 2.5)
      });
      seed = await this.k.civilizationSeed.create(`${label}:seed`);
    }

    const trust = this.k.trustBudget.evaluate(await this.k.oracle.assess({ verifyArchives: options.verifyArchives === true }));
    const id = `${Date.now()}-${uuid().slice(0,8)}`;
    const epoch = {
      format: 'JSONDB-OMEGA-EPOCH-1', id, label, sealedAt: now(),
      semanticWorldSha256: canonical.semanticSha256,
      merkleWorldRoot: merkleWorld.worldRoot,
      temporalWorldRoot: temporal.worldRoot,
      worldTreeCommit: worldCommit.id,
      memoryPalace: { id: memory.id, worldSha256: memory.worldSha256, chunkMerkleRoot: memory.chunkMerkleRoot },
      fabric: {
        braidSequence: fabric.braid?.sequence,
        braidEpochHash: fabric.braid?.epochHash,
        temporalEpoch: fabric.temporal?.epoch,
        signedWitnessRound: fabric.signed?.roundId,
        trinity: fabric.trinity?.id || null,
        genome: fabric.genome?.id || null,
        challenge: fabric.challenge || null
      },
      cryptographicCouncil: {
        id: crypto.id, valid: crypto.valid, familyQuorum: crypto.familyQuorum,
        ed25519: crypto.families?.ed25519,
        lamportSha256: crypto.families?.lamportSha256
      },
      statePassport: {
        id: passport.id, confidenceClass: passport.confidenceClass,
        passportHash: passport.passportHash,
        worldSemanticSha256: passport.worldSemanticSha256
      },
      compatibility: { id: compatibility.id, sourceMerkleRoot: compatibility.sourceMerkleRoot },
      conservation: { status: conservation.status, violations: conservation.violations, criticalViolations: conservation.criticalViolations },
      syndrome: { generation: syndrome.generation, status: syndromeDiagnosis.status, failedChecks: syndromeDiagnosis.failedChecks },
      survivalCalculus: {
        smallestCutOrder: calculus.cuts.smallestCutOrder,
        cutSets: calculus.cuts.minimalCutSets.length,
        estimatedSurvivalProbability: calculus.simulation.estimatedSurvivalProbability
      },
      trustBudget: {
        verdict: trust.verdict,
        independenceAdjustedConfidence: trust.independenceAdjustedConfidence,
        activeDomains: trust.activeDomains,
        healthyDomains: trust.healthyDomains
      },
      portableMedia: {
        formatPolyglot: format?.id || null,
        fountain: fountain?.generation || null,
        civilizationSeed: seed?.id || null
      },
      doctrine: 'An OMEGA epoch is a cross-system evidence bundle around one observed state. It records proofs and recovery material; it never grants automatic promotion authority.'
    };
    epoch.epochHash = digest(epoch);
    epoch.polyhash = await this.k.polyhash.envelope(epoch, { purpose: 'omega-epoch' });
    await atomicJson(path.join(this.epochs, `${id}.json`), epoch);
    await atomicJson(path.join(this.root, 'latest.json'), epoch);
    return epoch;
  }

  async verify(id = null, options = {}) {
    const readOnly = options.readOnly === true;
    if (!readOnly) await this.init();
    const epoch = id ? requireEpoch(await require('./jsonfs').readJson(path.join(this.epochs, `${id}.json`), null)) : requireEpoch(await require('./jsonfs').readJson(path.join(this.root, 'latest.json'), null));
    const copy = { ...epoch }; delete copy.epochHash; delete copy.polyhash;
    const computedEpochHash = digest(copy);
    const staticValid = computedEpochHash === epoch.epochHash;
    const polyhashTarget = { ...copy, epochHash: epoch.epochHash };
    const polyhash = epoch.polyhash ? await this.k.polyhash.verify(polyhashTarget, epoch.polyhash, { readOnly }) : null;
    const passport = await this.passports.verify(epoch.statePassport.id, { live: options.live === true, readOnly });
    const compatibility = await this.k.compatibility.verify(epoch.compatibility.id, { readOnly });
    let live = null;
    if (options.live === true) {
      const world = await this.k.world();
      const canonical = await this.k.canonicalQuorum.verify(world, { freezeOnDivergence: false });
      live = { semanticWorldSha256: canonical.semanticSha256, matchesEpoch: canonical.semanticSha256 === epoch.semanticWorldSha256 };
    }
    return {
      format: 'JSONDB-OMEGA-EPOCH-VERIFY-2', id: epoch.id,
      valid: staticValid && (!polyhash || polyhash.valid) && passport.valid && compatibility.valid && (!live || live.matchesEpoch),
      readOnly,
      staticValid, expectedEpochHash: epoch.epochHash, computedEpochHash,
      polyhash, passport, compatibility, live,
      confidenceClass: epoch.statePassport.confidenceClass,
      trustBudget: epoch.trustBudget
    };
  }
}

function requireEpoch(epoch) { if (!epoch) throw new Error('OMEGA epoch not found.'); return epoch; }

module.exports = { OmegaEpochSealer };
