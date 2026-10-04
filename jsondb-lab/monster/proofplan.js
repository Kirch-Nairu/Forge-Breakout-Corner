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

  async init() {
    await ensureDir(this.records);
  }

  async loadPlan(id = null) {
    return id
      ? readJson(path.join(this.k.recoveryNavigator.plans, `${id}.json`), null)
      : readJson(path.join(this.k.recoveryNavigator.root, 'latest.json'), null);
  }

  async verify(id = null) {
    await this.init();
    const dossier = id
      ? await readJson(path.join(this.records, `${id}.json`), null)
      : await readJson(path.join(this.root, 'latest.json'), null);
    if (!dossier) return { valid: false, status: 'ABSENT' };
    const copy = { ...dossier };
    delete copy.dossierHash;
    return {
      valid: digest(copy) === dossier.dossierHash,
      id: dossier.id,
      goal: dossier.navigator?.goal || null,
      source: dossier.source?.id || null
    };
  }
}

module.exports = { ProofCarryingRecoveryPlan };
