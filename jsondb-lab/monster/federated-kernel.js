'use strict';

const path = require('path');
const { OmegaKernel } = require('./omega-kernel');
const { OmegaEpochSealer } = require('./omegaepoch');
const { HistoryCourt } = require('./historycourt');
const { TemporalParityArchive } = require('./temporalparity');
const { TimeWeave } = require('./timeweave');
const { OmegaFederation } = require('./omegafederation');
const { readJson } = require('./jsonfs');

class FederatedOmegaKernel extends OmegaKernel {
  constructor(root, options = {}) {
    super(root, options);
    this.epochSealer = new OmegaEpochSealer(this);
    this.historyCourt = new HistoryCourt({
      savior: this.savior,
      worldTree: this.worldTree,
      chronicle: this.chronicle,
      braid: this.braid,
      cryptoCouncil: this.cryptoCouncil,
      memory: this.memory,
      polyhash: this.polyhash
    });
    this.temporalParity = new TemporalParityArchive({ savior: this.savior, omegaEpochRoot: this.epochSealer.root });
    this.timeWeave = new TimeWeave({ savior: this.savior, omegaEpochRoot: this.epochSealer.root, polyhash: this.polyhash });
    this.federation = new OmegaFederation({
      savior: this.savior,
      epochSealer: this.epochSealer,
      timeWeave: this.timeWeave,
      temporalParity: this.temporalParity,
      historyCourt: this.historyCourt,
      worldTree: this.worldTree,
      polyhash: this.polyhash
    });
    this.federatedInitialized = false;
  }

  async init(options = {}) {
    await super.init(options);
    if (this.federatedInitialized) return this;
    for (const system of [this.epochSealer, this.historyCourt, this.temporalParity, this.timeWeave, this.federation]) {
      if (system && typeof system.init === 'function') await system.init();
    }
    this.federatedInitialized = true;
    return this;
  }

  async status(options = {}) {
    await this.init();
    const base = await super.status(options);
    const [weave, federation, latestEpoch, latestParity, latestCourt] = await Promise.all([
      this.timeWeave.verifyAll().catch(error => ({ valid: false, error: error.message })),
      this.federation.verify(null, { live: false }).catch(error => ({ valid: false, status: 'ABSENT', error: error.message })),
      readJson(path.join(this.epochSealer.root, 'latest.json'), null),
      readJson(path.join(this.temporalParity.root, 'latest.json'), null),
      readJson(path.join(this.historyCourt.root, 'latest.json'), null)
    ]);
    return {
      ...base,
      format: 'JSONDB-FEDERATED-OMEGA-KERNEL-STATUS-1',
      historicalSurvival: {
        latestOmegaEpoch: latestEpoch ? { id: latestEpoch.id, epochHash: latestEpoch.epochHash, semanticWorldSha256: latestEpoch.semanticWorldSha256 } : null,
        timeWeave: { valid: weave.valid, nodes: weave.nodes, invalidNodes: weave.invalid?.length || 0 },
        temporalParity: latestParity,
        federation: { valid: federation.valid, id: federation.id, staticValid: federation.staticValid, error: federation.error },
        latestHistoryCourt: latestCourt ? { id: latestCourt.id, verdict: latestCourt.verdict, caseHash: latestCourt.caseHash } : null
      }
    };
  }
}

module.exports = { FederatedOmegaKernel };
