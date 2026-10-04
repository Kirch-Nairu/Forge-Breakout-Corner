'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

class PolicyCheckpoint {
  constructor(kernel) {
    this.k = kernel;
    this.root = path.join(kernel.savior.root, 'policy-checkpoints');
    this.records = path.join(this.root, 'records');
  }

  async init() { await ensureDir(this.records); }

  async capture(label = 'policy-checkpoint') {
    await this.init();
    const [firewall, contracts, federation, navigator, lastSavior, weave] = await Promise.all([
      this.k.authorityFirewall.verifyLedger(),
      this.k.recoveryContracts.analyze(),
      readJson(path.join(this.k.federation.root, 'latest.json'), null),
      readJson(path.join(this.k.recoveryNavigator.root, 'latest.json'), null),
      readJson(path.join(this.k.lastSavior.root, 'latest.json'), null),
      readJson(path.join(this.k.timeWeave.root, 'latest.json'), null)
    ]);
    if (!firewall.valid) throw new Error('Policy Checkpoint refuses to attest an invalid Authority Firewall ledger.');
    if (!contracts.valid) throw new Error('Policy Checkpoint refuses to attest invalid Recovery Contracts.');

    const core = {
      format: 'JSONDB-POLICY-CHECKPOINT-1',
      id: `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`,
      label,
      at: now(),
      firewall: { decisions: firewall.decisions, headHash: firewall.headHash },
      contracts: { registryHash: contracts.registryHash, valid: contracts.valid, violations: contracts.violations?.length || 0 },
      federation: federation ? { id: federation.id, federationHash: federation.federationHash, omegaEpochId: federation.omegaEpoch?.id || null } : null,
      navigator: navigator ? { id: navigator.id, planHash: navigator.planHash, status: navigator.status, goal: navigator.goal || null } : null,
      lastSavior: lastSavior ? { id: lastSavior.id, archiveHash: lastSavior.archiveHash } : null,
      timeWeave: weave ? { epochId: weave.epochId, weaveHash: weave.weaveHash, position: weave.position } : null,
      doctrine: 'This checkpoint binds recovery-policy history to independent signature families and the forward-evolving witness chain. It grants no new authority.'
    };
    const coreHash = digest(core);
    const [cryptoAttestation, forwardAttestation] = await Promise.all([
      this.k.cryptoCouncil.attest(coreHash, { purpose: 'policy-checkpoint', checkpointId: core.id, firewallHead: firewall.headHash }),
      this.k.forwardWitness.attest(coreHash, { purpose: 'policy-checkpoint', checkpointId: core.id, firewallHead: firewall.headHash })
    ]);
    const record = {
      ...core,
      coreHash,
      cryptoCouncil: { id: cryptoAttestation.id, worldRoot: cryptoAttestation.worldRoot, familyQuorum: cryptoAttestation.familyQuorum },
      forwardWitness: { sequence: forwardAttestation.statement.sequence, subjectHash: forwardAttestation.statement.subjectHash, attestationHash: forwardAttestation.attestationHash, signingKeyFingerprint: forwardAttestation.statement.signingKeyFingerprint, nextKeyFingerprint: forwardAttestation.statement.nextKeyFingerprint }
    };
    record.checkpointHash = digest(record);
    await atomicJson(path.join(this.records, `${record.id}.json`), record);
    await atomicJson(path.join(this.root, 'latest.json'), record);
    return record;
  }

  async verify(id = null) {
    await this.init();
    const record = id ? await readJson(path.join(this.records, `${id}.json`), null) : await readJson(path.join(this.root, 'latest.json'), null);
    if (!record) return { valid: false, status: 'ABSENT' };
    const copy = { ...record }; delete copy.checkpointHash;
    const computedCheckpointHash = digest(copy);
    const coreCopy = { ...record };
    delete coreCopy.coreHash; delete coreCopy.cryptoCouncil; delete coreCopy.forwardWitness; delete coreCopy.checkpointHash;
    const computedCoreHash = digest(coreCopy);
    const [crypto, forward, firewall] = await Promise.all([
      this.k.cryptoCouncil.verify(record.cryptoCouncil?.id).catch(error => ({ valid: false, error: error.message })),
      this.k.forwardWitness.verifyAll().catch(error => ({ valid: false, error: error.message })),
      this.k.authorityFirewall.verifyLedger().catch(error => ({ valid: false, error: error.message }))
    ]);
    const forwardRecord = forward.results?.find(x => x.sequence === record.forwardWitness?.sequence) || null;
    const forwardValid = Boolean(forward.valid && forwardRecord?.valid && forwardRecord.subjectHash === record.coreHash && forwardRecord.attestationHash === record.forwardWitness.attestationHash);
    const cryptoValid = Boolean(crypto.valid && crypto.worldRoot === record.coreHash && Number(crypto.familyQuorum || 0) >= 2);
    const liveLedgerDescends = firewall.valid && Number(firewall.decisions || 0) >= Number(record.firewall?.decisions || 0);
    return {
      format: 'JSONDB-POLICY-CHECKPOINT-VERIFY-1',
      id: record.id,
      valid: computedCheckpointHash === record.checkpointHash && computedCoreHash === record.coreHash && cryptoValid && forwardValid && liveLedgerDescends,
      staticValid: computedCheckpointHash === record.checkpointHash,
      coreValid: computedCoreHash === record.coreHash,
      cryptoCouncilValid: cryptoValid,
      forwardWitnessValid: forwardValid,
      liveFirewallLedgerValid: firewall.valid,
      liveLedgerDescends,
      checkpointFirewallHead: record.firewall?.headHash || null,
      liveFirewallHead: firewall.headHash || null,
      caveat: 'A later valid firewall ledger may have additional decisions. This verifies the checkpointed prefix by count/head binding only through the stored checkpoint attestation; it does not imply later decisions existed at checkpoint time.'
    };
  }
}

module.exports = { PolicyCheckpoint };
