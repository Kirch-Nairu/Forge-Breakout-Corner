'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

class LastSaviorArchive {
  constructor(kernel) {
    this.k = kernel;
    this.root = path.join(kernel.savior.root, 'last-savior-archives');
    this.receipts = path.join(this.root, 'receipts');
  }

  async init() { await ensureDir(this.receipts); }

  async evidenceSources({ federation, rosetta, quaternary, seed, shadowLaws, forwardWitness, spacetime, fossil }) {
    const rows = [];
    const add = (name, p) => { if (p) rows.push({ name, path: p }); };
    add('FEDERATION-RECEIPT.json', path.join(this.k.federation.receipts, `${federation.id}.json`));
    add('OMEGA-EPOCH.json', path.join(this.k.epochSealer.epochs, `${federation.omegaEpoch.id}.json`));
    add('TIME-WEAVE-NODE.json', path.join(this.k.timeWeave.nodes, `${federation.omegaEpoch.id}.json`));
    if (federation.temporalParity?.id) add('TEMPORAL-PARITY-WINDOW', path.join(this.k.temporalParity.windows, federation.temporalParity.id));
    if (federation.semanticHologram?.id) add('SEMANTIC-HOLOGRAM.json', path.join(this.k.hologram.records, `${federation.semanticHologram.id}.json`));
    if (federation.historyCourt?.id) add('HISTORY-COURT.json', path.join(this.k.historyCourt.cases, `${federation.historyCourt.id}.json`));
    if (shadowLaws?.id) add('SHADOW-LAWS.json', path.join(this.k.shadowLaws.records, `${shadowLaws.id}.json`));
    if (forwardWitness?.statement?.sequence) add('FORWARD-WITNESS.json', path.join(this.k.forwardWitness.records, `${String(forwardWitness.statement.sequence).padStart(10,'0')}.json`));
    if (spacetime?.id) add('SPACETIME-ARK', path.join(this.k.spacetime.generations, spacetime.id));
    if (fossil?.id) add('SEMANTIC-FOSSIL.json', fossil.format === 'JSONDB-SEMANTIC-FOSSIL-GENESIS-1' ? path.join(this.k.fossils.root, 'latest.json') : path.join(this.k.fossils.records, `${fossil.id}.json`));
    add('RECOVERY-CONTRACTS.json', this.k.recoveryContracts?.file);
    add('RECOVERY-CONTRACT-ANALYSIS.json', this.k.recoveryContracts ? path.join(this.k.recoveryContracts.root, 'latest-analysis.json') : null);
    add('ROSETTA-CAPSULE', rosetta.directory);
    add('QUATERNARY-COLD-STORAGE', path.join(this.k.quaternary.generations, quaternary.generation));
    add('CIVILIZATION-SEED', seed.directory);
    add('CRYPTOGRAPHIC-COUNCIL.json', path.join(this.k.cryptoCouncil.root, 'latest.json'));
    add('CROSS-HISTORY-BRAID.json', path.join(this.k.braid.root, 'latest.json'));
    return rows;
  }

  async create(label = 'last-savior', options = {}) {
    await this.init();
    const contractRegistry = await this.k.recoveryContracts.init();
    const contractAnalysis = await this.k.recoveryContracts.analyze();
    const federation = await this.k.federation.seal(`${label}:federation`, {
      temporalWindow: Number(options.temporalWindow || 8),
      federationRef: options.federationRef || 'federation',
      compareLineage: options.compareLineage || null,
      previewMerge: options.previewMerge === true,
      hologramWidth: Number(options.hologramWidth || 64),
      hologramProjections: Number(options.hologramProjections || 8),
      epoch: {
        deepMedia: options.deepMedia !== false,
        verifyArchives: options.verifyArchives === true,
        syndromeChecksPerNode: Number(options.syndromeChecksPerNode || 8),
        monteCarloIterations: Number(options.monteCarloIterations || 10000)
      }
    });

    const shadowLaws = await this.k.shadowLaws.capture(`${label}:shadow-laws`, { lawsPerCollection: Number(options.shadowLawsPerCollection || 12) });
    const rosetta = await this.k.rosetta.create(`${label}:rosetta`);
    const world = await this.k.world();
    const quaternary = await this.k.quaternary.archiveBuffer(`${label}:quaternary`, Buffer.from(JSON.stringify(world)), { oligoBytes: Number(options.oligoBytes || 512), groupSize: Number(options.oligoGroupSize || 8) });
    const seed = await this.k.civilizationSeed.create(`${label}:civilization-seed`);
    const fossil = await this.k.fossils.capture(`${label}:fossil`);

    let spacetime = null;
    let spacetimePlacement = null;
    try {
      spacetime = await this.k.spacetime.seal(`${label}:spacetime`, { epochs: Number(options.spacetimeEpochs || 8), dataColumns: Number(options.spacetimeColumns || 6) });
      if (options.scatter !== false) {
        try {
          const assessment = await this.k.constellation.assess();
          if ((assessment.registry?.media || []).length) spacetimePlacement = await this.k.spacetime.scatter(spacetime.id, { copiesPerCell: Number(options.spacetimeCopiesPerCell || 1) });
          else spacetimePlacement = { status:'DEFERRED', reason:'No registered media for Spacetime placement.' };
        } catch (error) { spacetimePlacement = { status:'DEFERRED', reason:error.message }; }
      }
    } catch (error) { spacetime = { status:'DEFERRED', reason:error.message }; }

    const archiveCore = {
      format: 'JSONDB-LAST-SAVIOR-ARCHIVE-7',
      id: `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
      label, createdAt: now(),
      world: { semanticSha256: federation.omegaEpoch.semanticWorldSha256, federationId: federation.id, omegaEpochId: federation.omegaEpoch.id, omegaEpochHash: federation.omegaEpoch.epochHash, worldTreeCommit: federation.worldTree.commit },
      recoveryFamilies: {
        civilizationSeed: seed.id,
        rosettaCapsule: rosetta.id,
        quaternaryGeneration: quaternary.generation,
        temporalParity: federation.temporalParity?.id || null,
        spacetimeArk: spacetime?.id || null,
        spacetimePlacement,
        semanticFossil: { id:fossil.id, format:fossil.format, from:fossil.from||null, to:fossil.to||{memoryId:fossil.toMemoryId,worldSha256:fossil.toWorldSha256} },
        memoryPalace: (await readJson(path.join(this.k.memory.root, 'latest.json'), null))?.id || null,
        trinity: (await readJson(path.join(this.k.trinity.root, 'latest.json'), null))?.id || null,
        fountain: (await readJson(path.join(this.k.fountain.root, 'latest.json'), null))?.generation || null
      },
      corroborationFamilies: {
        semanticHologram: federation.semanticHologram,
        shadowLaws: { id: shadowLaws.id, recordHash: shadowLaws.recordHash, attestationId: shadowLaws.attestation?.id || null },
        timeWeave: federation.timeWeave,
        cryptographicCouncil: (await readJson(path.join(this.k.cryptoCouncil.root, 'latest.json'), null))?.id || null,
        crossHistoryBraid: (await readJson(path.join(this.k.braid.root, 'latest.json'), null))?.epochHash || null,
        historyCourt: federation.historyCourt,
        recoveryContracts: {
          registryHash: contractRegistry.registryHash,
          analysisHash: digest(contractAnalysis),
          valid: contractAnalysis.valid,
          violations: contractAnalysis.violations?.length || 0,
          reconstructors: contractAnalysis.summary?.reconstructors || 0,
          nonReconstructiveCorroborators: contractAnalysis.summary?.nonReconstructiveCorroborators || 0,
          automaticPromoters: contractAnalysis.summary?.automaticPromoters || 0
        }
      },
      doctrine: [
        'Recovery data and validation evidence are intentionally separated.',
        'No single decoder family is sufficient promotion authority.',
        'Recovery Contracts travel with the archive so future operators can distinguish reconstructive, corroborative, transport, adjudication, and human-authority roles.',
        'Archive validity resolves the historical Recovery Contract registry by content hash; later policy evolution is drift, not retroactive archive corruption.',
        'Holograms and randomized Shadow Laws corroborate reconstructions without serving as their recovery source.',
        'Spacetime ARK adds a 2-D erasure product code across storage shards and historical epochs when enough history exists.',
        'Semantic Delta Fossils provide reversible row-aware transitions between fossil-specific Memory Palace endpoints.',
        'Forward Witness Ratchet gives historical attestations an evolving signing identity; old private keys are removed from active state but filesystem secure erasure is not guaranteed.',
        'Recovered data is restored into a sandbox first.',
        'Divergent defensible histories are preserved, not silently collapsed.',
        'Automation may freeze authority; only an explicit promotion ceremony may raise it.'
      ]
    };
    const coreHash = digest(archiveCore);
    const forwardWitness = await this.k.forwardWitness.attest(coreHash, { purpose: 'last-savior-core', archiveId: archiveCore.id, federationId: federation.id, omegaEpochId: federation.omegaEpoch.id });

    const bundle = await this.k.diaspora.createBundle(`${label}:evidence`, await this.evidenceSources({ federation, rosetta, quaternary, seed, shadowLaws, forwardWitness, spacetime, fossil }), {
      federationId: federation.id, omegaEpochId: federation.omegaEpoch.id, shadowLawId: shadowLaws.id,
      forwardWitnessSequence: forwardWitness.statement.sequence, forwardWitnessHash: forwardWitness.attestationHash,
      quaternaryGeneration: quaternary.generation, spacetimeGeneration: spacetime?.id || null, fossilId:fossil.id,
      recoveryContractRegistryHash: contractRegistry.registryHash, recoveryContractAnalysisHash: digest(contractAnalysis),
      rosettaId: rosetta.id, civilizationSeedId: seed.id
    });

    let diaspora = null;
    if (options.scatter !== false) {
      try {
        const assessment = await this.k.constellation.assess();
        if ((assessment.registry?.media || []).length) diaspora = await this.k.diaspora.scatter(bundle.id, { copies: options.copies });
        else diaspora = { status: 'DEFERRED', reason: 'No registered physical media. Evidence bundle exists locally.' };
      } catch (error) { diaspora = { status: 'DEFERRED', reason: error.message }; }
    }

    const receipt = { ...archiveCore, coreHash, forwardWitness: { sequence: forwardWitness.statement.sequence, subjectHash: forwardWitness.statement.subjectHash, signingKeyFingerprint: forwardWitness.statement.signingKeyFingerprint, nextKeyFingerprint: forwardWitness.statement.nextKeyFingerprint, attestationHash: forwardWitness.attestationHash }, evidenceBundle: { id: bundle.id, merkleRoot: bundle.manifest.merkleRoot, bundleHash: bundle.bundleHash }, physicalDiaspora: diaspora };
    receipt.archiveHash = digest(receipt);
    receipt.polyhash = await this.k.polyhash.envelope(receipt, { purpose: 'last-savior-archive' });
    await atomicJson(path.join(this.receipts, `${receipt.id}.json`), receipt);
    await atomicJson(path.join(this.root, 'latest.json'), receipt);
    return receipt;
  }

  async verify(id = null, options = {}) {
    await this.init();
    const receipt = id ? await readJson(path.join(this.receipts, `${id}.json`), null) : await readJson(path.join(this.root, 'latest.json'), null);
    if (!receipt) return { valid: false, status: 'ABSENT' };
    const copy = { ...receipt }; delete copy.archiveHash; delete copy.polyhash;
    const computed = digest(copy); const staticValid = computed === receipt.archiveHash;
    const coreCopy = { ...receipt }; delete coreCopy.coreHash; delete coreCopy.forwardWitness; delete coreCopy.evidenceBundle; delete coreCopy.physicalDiaspora; delete coreCopy.archiveHash; delete coreCopy.polyhash;
    const computedCoreHash = digest(coreCopy); const coreValid = computedCoreHash === receipt.coreHash;
    const archivedContracts = receipt.corroborationFamilies?.recoveryContracts || null;

    const [federation, rosetta, seed, quaternary, shadowRecord, forwardChain, spacetime, fossil, historicalContracts, currentContracts] = await Promise.all([
      this.k.federation.verify(receipt.world.federationId, { live: options.live === true }).catch(error => ({ valid: false, error: error.message })),
      this.k.rosetta.verify(receipt.recoveryFamilies.rosettaCapsule).catch(error => ({ valid: false, error: error.message })),
      this.k.civilizationSeed.verify(receipt.recoveryFamilies.civilizationSeed).catch(error => ({ valid: false, error: error.message })),
      this.k.quaternary.recover(receipt.recoveryFamilies.quaternaryGeneration).catch(error => ({ status: 'ERROR', error: error.message })),
      this.k.shadowLaws.verifyRecord(receipt.corroborationFamilies?.shadowLaws?.id || null).catch(error => ({ valid: false, error: error.message })),
      this.k.forwardWitness.verifyAll().catch(error => ({ valid: false, error: error.message })),
      receipt.recoveryFamilies?.spacetimeArk ? this.k.spacetime.recover(receipt.recoveryFamilies.spacetimeArk).catch(error => ({ status:'ERROR', error:error.message })) : Promise.resolve({status:'NOT_PRESENT'}),
      receipt.recoveryFamilies?.semanticFossil?.id ? this.k.fossils.verify(receipt.recoveryFamilies.semanticFossil.id).catch(error=>({valid:false,error:error.message})) : Promise.resolve({valid:true,status:'NOT_PRESENT'}),
      this.k.recoveryContracts.version(archivedContracts?.registryHash || null).catch(() => null),
      this.k.recoveryContracts.init().catch(error => ({ registryHash:null, error:error.message }))
    ]);
    if (quaternary?.buffer) delete quaternary.buffer;
    const shadowChallenge = options.live === true && shadowRecord.valid ? await this.k.shadowLaws.challenge(null, receipt.corroborationFamilies.shadowLaws.id).catch(error => ({ status: 'ERROR', confidence: 0, error: error.message })) : null;
    const forwardRecord = forwardChain.results?.find(x => x.sequence === receipt.forwardWitness?.sequence) || null;
    const forwardValid = Boolean(forwardChain.valid && forwardRecord?.valid && forwardRecord.subjectHash === receipt.coreHash && receipt.forwardWitness.subjectHash === receipt.coreHash && forwardRecord.attestationHash === receipt.forwardWitness.attestationHash);
    const diaspora = receipt.physicalDiaspora?.id ? await this.k.diaspora.verifyPlacement(receipt.physicalDiaspora.id).catch(error => ({ valid: false, error: error.message })) : { valid: true, status: 'NOT_SCATTERED' };
    const polyhash = await this.k.polyhash.verify({ ...copy, archiveHash: receipt.archiveHash }, receipt.polyhash).catch(error => ({ valid: false, error: error.message }));
    const spacetimeOkay = ['NOT_PRESENT','RECOVERED','PARTIAL'].includes(spacetime.status);

    const historicalRegistryCopy = historicalContracts ? { ...historicalContracts } : null;
    if (historicalRegistryCopy) delete historicalRegistryCopy.registryHash;
    const historicalRegistryHashValid = Boolean(historicalRegistryCopy && digest(historicalRegistryCopy) === archivedContracts?.registryHash && historicalContracts.registryHash === archivedContracts?.registryHash);
    const historicalContractsNoAutoPromoters = Boolean(historicalContracts && Object.values(historicalContracts.contracts || {}).every(c => c?.mayPromoteCanonical !== true));
    const contractsAtArchiveSafe = Boolean(
      archivedContracts?.valid &&
      Number(archivedContracts?.automaticPromoters || 0) === 0 &&
      Number(archivedContracts?.violations || 0) === 0 &&
      historicalRegistryHashValid &&
      historicalContractsNoAutoPromoters
    );
    const currentContractRegistryMatchesArchive = Boolean(archivedContracts?.registryHash && currentContracts?.registryHash === archivedContracts.registryHash);

    const independent = {
      federation: federation.valid === true,
      rosetta: rosetta.valid === true,
      civilizationSeed: seed.valid === true,
      quaternary: quaternary.status === 'RECOVERED',
      spacetime: spacetimeOkay,
      semanticFossil: fossil.valid === true,
      recoveryContractsAtArchive: contractsAtArchiveSafe,
      recoveryContractsCurrentMatch: options.live === true ? currentContractRegistryMatchesArchive : null,
      shadowLawRecord: shadowRecord.valid === true,
      shadowLawLive: shadowChallenge ? shadowChallenge.status === 'SATISFIED' : null,
      forwardWitness: forwardValid,
      diaspora: diaspora.valid === true || diaspora.status === 'NOT_SCATTERED',
      polyhash: polyhash.valid === true
    };
    const booleanChannels = Object.values(independent).filter(x => typeof x === 'boolean');
    const healthy = booleanChannels.filter(Boolean).length;
    const historicalValid = staticValid && coreValid && independent.federation && independent.rosetta && independent.civilizationSeed && independent.quaternary && independent.spacetime && independent.semanticFossil && independent.recoveryContractsAtArchive && independent.shadowLawRecord && independent.forwardWitness && independent.polyhash && (independent.shadowLawLive !== false);

    return {
      format: 'JSONDB-LAST-SAVIOR-VERIFY-7',
      id: receipt.id,
      valid: historicalValid,
      historicalValid,
      staticValid,
      coreValid,
      expectedCoreHash: receipt.coreHash,
      computedCoreHash,
      expectedArchiveHash: receipt.archiveHash,
      computedArchiveHash: computed,
      independentEvidence: independent,
      healthyChannels: healthy,
      totalBooleanChannels: booleanChannels.length,
      policyDriftedSinceArchive: Boolean(contractsAtArchiveSafe && !currentContractRegistryMatchesArchive),
      federation,
      rosetta,
      civilizationSeed: seed,
      quaternary,
      spacetime,
      semanticFossil: fossil,
      recoveryContracts: {
        archived: archivedContracts,
        historicalRegistryAvailable: Boolean(historicalContracts),
        historicalRegistryHashValid,
        historicalContractsNoAutoPromoters,
        currentRegistryHash: currentContracts?.registryHash || null,
        currentRegistryMatchesArchive: currentContractRegistryMatchesArchive
      },
      shadowLawRecord: shadowRecord,
      shadowChallenge,
      forwardWitness: { valid: forwardValid, chainValid: forwardChain.valid, record: forwardRecord },
      diaspora,
      polyhash,
      doctrine: 'Historical archive validity is resolved against the archived content-addressed Recovery Contract registry. Later policy drift is reported separately and does not retroactively invalidate the archive.'
    };
  }
}

module.exports = { LastSaviorArchive };
