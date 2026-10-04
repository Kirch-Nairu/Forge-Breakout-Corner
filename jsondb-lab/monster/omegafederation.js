'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

class OmegaFederation {
  constructor({ savior, epochSealer, timeWeave, temporalParity, historyCourt, worldTree, polyhash }) {
    Object.assign(this, { savior, epochSealer, timeWeave, temporalParity, historyCourt, worldTree, polyhash });
    this.root = path.join(savior.root, 'omega-federation');
    this.receipts = path.join(this.root, 'receipts');
  }

  async init() {
    await ensureDir(this.receipts);
    for (const system of [this.epochSealer, this.timeWeave, this.temporalParity, this.historyCourt]) {
      if (system && typeof system.init === 'function') await system.init();
    }
  }

  async seal(label = 'omega-federation', options = {}) {
    await this.init();
    const epoch = await this.epochSealer.seal(label, options.epoch || options);
    const weave = await this.timeWeave.append(epoch);
    let parity = null;
    try {
      parity = await this.temporalParity.seal({ window: Number(options.temporalWindow || 8) });
    } catch (error) {
      parity = { status: 'DEFERRED', reason: error.message };
    }

    const refName = options.federationRef || 'federation';
    let ref;
    try {
      const existing = await this.worldTree.ref(refName);
      if (!existing) ref = await this.worldTree.branch(refName, options.fromRef || 'main');
      else ref = existing;
    } catch {
      ref = null;
    }
    const lineageCommit = await this.worldTree.commitCurrent(`${label}:federation-lineage`, refName, {
      omegaEpochId: epoch.id,
      omegaEpochHash: epoch.epochHash,
      timeWeaveHash: weave.weaveHash,
      temporalParityWindow: parity.id || parity.window || null
    });

    let court = null;
    if (options.compareLineage) {
      court = await this.historyCourt.compare(refName, options.compareLineage, { previewMerge: options.previewMerge === true, preferenceMargin: options.preferenceMargin });
    }

    const previous = await readJson(path.join(this.root, 'latest.json'), null);
    const receipt = {
      format: 'JSONDB-OMEGA-FEDERATION-1',
      id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      label, sealedAt: now(),
      previousFederationHash: previous?.federationHash || null,
      omegaEpoch: { id: epoch.id, epochHash: epoch.epochHash, semanticWorldSha256: epoch.semanticWorldSha256 },
      timeWeave: { position: weave.position, weaveHash: weave.weaveHash, anchors: weave.anchors?.length || 0 },
      temporalParity: parity.id ? { id: parity.id, dataEpochs: parity.dataEpochs?.length || 0, parityShards: parity.parity?.length || 0 } : parity,
      worldTree: { ref: refName, commit: lineageCommit.id, worldSha256: lineageCommit.worldSha256 },
      historyCourt: court ? { id: court.id, caseHash: court.caseHash, verdict: court.verdict, preferred: court.preferred } : null,
      doctrine: 'Federation binds independent historical structures around one OMEGA epoch. It preserves branch ambiguity and never grants automatic promotion authority.'
    };
    receipt.federationHash = digest(receipt);
    if (this.polyhash) receipt.polyhash = await this.polyhash.envelope(receipt, { purpose: 'omega-federation' });
    await atomicJson(path.join(this.receipts, `${receipt.id}.json`), receipt);
    await atomicJson(path.join(this.root, 'latest.json'), receipt);
    return receipt;
  }

  async verify(id = null, options = {}) {
    await this.init();
    const receipt = id ? await readJson(path.join(this.receipts, `${id}.json`), null) : await readJson(path.join(this.root, 'latest.json'), null);
    if (!receipt) return { valid: false, status: 'ABSENT' };
    const copy = { ...receipt }; delete copy.federationHash; delete copy.polyhash;
    const computed = digest(copy);
    const epoch = await this.epochSealer.verify(receipt.omegaEpoch.id, { live: options.live === true }).catch(error => ({ valid: false, error: error.message }));
    const weave = await this.timeWeave.verifyNode(receipt.omegaEpoch.id).catch(error => ({ valid: false, error: error.message }));
    const parity = receipt.temporalParity?.id ? await this.temporalParity.inspect(receipt.temporalParity.id).catch(error => ({ damaged: Infinity, error: error.message })) : null;
    const court = receipt.historyCourt?.id ? await this.historyCourt.verify(receipt.historyCourt.id).catch(error => ({ valid: false, error: error.message })) : null;
    let polyhash = null;
    if (this.polyhash && receipt.polyhash) polyhash = await this.polyhash.verify({ ...copy, federationHash: receipt.federationHash }, receipt.polyhash);
    const parityHealthy = !parity || Number(parity.damaged || 0) <= 2;
    return {
      format: 'JSONDB-OMEGA-FEDERATION-VERIFY-1', id: receipt.id,
      valid: computed === receipt.federationHash && epoch.valid === true && weave.valid === true && parityHealthy && (!court || court.valid === true) && (!polyhash || polyhash.valid),
      staticValid: computed === receipt.federationHash,
      expectedFederationHash: receipt.federationHash, computedFederationHash: computed,
      epoch, weave, temporalParity: parity ? { damaged: parity.damaged, recoverable: Number(parity.damaged || 0) <= 2, error: parity.error } : null,
      historyCourt: court, polyhash
    };
  }

  async continuityProof(fromEpochId, toEpochId = null) {
    const weave = await this.timeWeave.proof(fromEpochId, toEpochId);
    const full = await this.timeWeave.verifyAll();
    return { weave, globalWeaveValid: full.valid, invalidNodes: full.invalid?.length || 0 };
  }
}

module.exports = { OmegaFederation };
