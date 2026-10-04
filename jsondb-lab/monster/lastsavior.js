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

  async evidenceSources({ federation, rosetta, quaternary, seed }) {
    const rows = [];
    const add = (name, p) => { if (p) rows.push({ name, path: p }); };
    add('FEDERATION-RECEIPT.json', path.join(this.k.federation.receipts, `${federation.id}.json`));
    add('OMEGA-EPOCH.json', path.join(this.k.epochSealer.epochs, `${federation.omegaEpoch.id}.json`));
    add('TIME-WEAVE-NODE.json', path.join(this.k.timeWeave.nodes, `${federation.omegaEpoch.id}.json`));
    if (federation.temporalParity?.id) add('TEMPORAL-PARITY-WINDOW', path.join(this.k.temporalParity.windows, federation.temporalParity.id));
    if (federation.semanticHologram?.id) add('SEMANTIC-HOLOGRAM.json', path.join(this.k.hologram.records, `${federation.semanticHologram.id}.json`));
    if (federation.historyCourt?.id) add('HISTORY-COURT.json', path.join(this.k.historyCourt.cases, `${federation.historyCourt.id}.json`));
    add('ROSETTA-CAPSULE', rosetta.directory);
    add('QUATERNARY-COLD-STORAGE', path.join(this.k.quaternary.generations, quaternary.generation));
    add('CIVILIZATION-SEED', seed.directory);
    add('CRYPTOGRAPHIC-COUNCIL.json', path.join(this.k.cryptoCouncil.root, 'latest.json'));
    add('CROSS-HISTORY-BRAID.json', path.join(this.k.braid.root, 'latest.json'));
    return rows;
  }

  async create(label = 'last-savior', options = {}) {
    await this.init();
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

    const rosetta = await this.k.rosetta.create(`${label}:rosetta`);
    const world = await this.k.world();
    const quaternary = await this.k.quaternary.archiveBuffer(`${label}:quaternary`, Buffer.from(JSON.stringify(world)), {
      oligoBytes: Number(options.oligoBytes || 512),
      groupSize: Number(options.oligoGroupSize || 8)
    });
    const seed = await this.k.civilizationSeed.create(`${label}:civilization-seed`);

    const bundle = await this.k.diaspora.createBundle(`${label}:evidence`, await this.evidenceSources({ federation, rosetta, quaternary, seed }), {
      federationId: federation.id,
      omegaEpochId: federation.omegaEpoch.id,
      quaternaryGeneration: quaternary.generation,
      rosettaId: rosetta.id,
      civilizationSeedId: seed.id
    });

    let diaspora = null;
    if (options.scatter !== false) {
      try {
        const assessment = await this.k.constellation.assess();
        if ((assessment.registry?.media || []).length) diaspora = await this.k.diaspora.scatter(bundle.id, { copies: options.copies });
        else diaspora = { status: 'DEFERRED', reason: 'No registered physical media. Evidence bundle exists locally.' };
      } catch (error) { diaspora = { status: 'DEFERRED', reason: error.message }; }
    }

    const receipt = {
      format: 'JSONDB-LAST-SAVIOR-ARCHIVE-1',
      id: `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
      label, createdAt: now(),
      world: {
        semanticSha256: federation.omegaEpoch.semanticWorldSha256,
        federationId: federation.id,
        omegaEpochId: federation.omegaEpoch.id,
        omegaEpochHash: federation.omegaEpoch.epochHash,
        worldTreeCommit: federation.worldTree.commit
      },
      recoveryFamilies: {
        civilizationSeed: seed.id,
        rosettaCapsule: rosetta.id,
        quaternaryGeneration: quaternary.generation,
        temporalParity: federation.temporalParity?.id || null,
        memoryPalace: (await readJson(path.join(this.k.memory.root, 'latest.json'), null))?.id || null,
        trinity: (await readJson(path.join(this.k.trinity.root, 'latest.json'), null))?.id || null,
        fountain: (await readJson(path.join(this.k.fountain.root, 'latest.json'), null))?.generation || null
      },
      corroborationFamilies: {
        semanticHologram: federation.semanticHologram,
        timeWeave: federation.timeWeave,
        cryptographicCouncil: (await readJson(path.join(this.k.cryptoCouncil.root, 'latest.json'), null))?.id || null,
        crossHistoryBraid: (await readJson(path.join(this.k.braid.root, 'latest.json'), null))?.epochHash || null,
        historyCourt: federation.historyCourt
      },
      evidenceBundle: { id: bundle.id, merkleRoot: bundle.manifest.merkleRoot, bundleHash: bundle.bundleHash },
      physicalDiaspora: diaspora,
      doctrine: [
        'Recovery data and validation evidence are intentionally separated.',
        'No single decoder family is sufficient promotion authority.',
        'Recovered data is restored into a sandbox first.',
        'Divergent defensible histories are preserved, not silently collapsed.',
        'Automation may freeze authority; only an explicit promotion ceremony may raise it.'
      ]
    };
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
    const computed = digest(copy);
    const staticValid = computed === receipt.archiveHash;
    const [federation, rosetta, seed, quaternary] = await Promise.all([
      this.k.federation.verify(receipt.world.federationId, { live: options.live === true }).catch(error => ({ valid: false, error: error.message })),
      this.k.rosetta.verify(receipt.recoveryFamilies.rosettaCapsule).catch(error => ({ valid: false, error: error.message })),
      this.k.civilizationSeed.verify(receipt.recoveryFamilies.civilizationSeed).catch(error => ({ valid: false, error: error.message })),
      this.k.quaternary.recover(receipt.recoveryFamilies.quaternaryGeneration).catch(error => ({ status: 'ERROR', error: error.message }))
    ]);
    if (quaternary?.buffer) delete quaternary.buffer;
    const diaspora = receipt.physicalDiaspora?.id ? await this.k.diaspora.verifyPlacement(receipt.physicalDiaspora.id).catch(error => ({ valid: false, error: error.message })) : { valid: true, status: 'NOT_SCATTERED' };
    const polyhash = await this.k.polyhash.verify({ ...copy, archiveHash: receipt.archiveHash }, receipt.polyhash).catch(error => ({ valid: false, error: error.message }));
    const independent = {
      federation: federation.valid === true,
      rosetta: rosetta.valid === true,
      civilizationSeed: seed.valid === true,
      quaternary: quaternary.status === 'RECOVERED',
      diaspora: diaspora.valid === true || diaspora.status === 'NOT_SCATTERED',
      polyhash: polyhash.valid === true
    };
    const healthy = Object.values(independent).filter(Boolean).length;
    return {
      format: 'JSONDB-LAST-SAVIOR-VERIFY-1', id: receipt.id,
      valid: staticValid && independent.federation && independent.rosetta && independent.civilizationSeed && independent.quaternary && independent.polyhash,
      staticValid, expectedArchiveHash: receipt.archiveHash, computedArchiveHash: computed,
      independentEvidence: independent,
      healthyChannels: healthy, totalChannels: Object.keys(independent).length,
      federation, rosetta, civilizationSeed: seed, quaternary, diaspora, polyhash,
      doctrine: 'A green result means independent artifacts remain internally consistent. It is not automatic authorization to replace canonical state.'
    };
  }
}

module.exports = { LastSaviorArchive };
