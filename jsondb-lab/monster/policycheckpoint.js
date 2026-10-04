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
      format: 'JSONDB-POLICY-CHECKPOINT-4',
      id: `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`,
      label,
      at: now(),
      firewall: {
        decisions: firewall.decisions,
        headHash: firewall.headHash,
        fullyPolicyReplayable: firewall.fullyPolicyReplayable,
        policyReplayedDecisions: firewall.policyReplayedDecisions || 0,
        legacyUnboundDecisions: firewall.legacyUnboundDecisions || 0
      },
      contracts: { registryHash: contracts.registryHash, valid: contracts.valid, violations: contracts.violations?.length || 0 },
      federation: federation ? { id: federation.id, federationHash: federation.federationHash, omegaEpochId: federation.omegaEpoch?.id || null } : null,
      navigator: navigator ? { id: navigator.id, planHash: navigator.planHash, status: navigator.status, goal: navigator.goal || null } : null,
      lastSavior: lastSavior ? { id: lastSavior.id, archiveHash: lastSavior.archiveHash } : null,
      timeWeave: weave ? { epochId: weave.epochId, weaveHash: weave.weaveHash, position: weave.position } : null,
      doctrine: 'This checkpoint binds an exact Authority Firewall ledger prefix and the historical Recovery Contract registry to independent signature families. Future ledger damage does not retroactively invalidate a verified historical prefix.'
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
    const checkpointCount = Number(record.firewall?.decisions || 0);
    const [crypto, forward, prefix, liveFirewall, historicalContracts, currentContracts] = await Promise.all([
      this.k.cryptoCouncil.verify(record.cryptoCouncil?.id).catch(error => ({ valid: false, error: error.message })),
      this.k.forwardWitness.verifyAll().catch(error => ({ valid: false, error: error.message })),
      this.k.authorityFirewall.verifyPrefix(checkpointCount).catch(error => ({ valid: false, error: error.message })),
      this.k.authorityFirewall.verifyLedger().catch(error => ({ valid: false, error: error.message })),
      this.k.recoveryContracts.version(record.contracts?.registryHash || null).catch(() => null),
      this.k.recoveryContracts.init().catch(() => null)
    ]);
    const forwardRecord = forward.results?.find(x => x.sequence === record.forwardWitness?.sequence) || null;
    const forwardValid = Boolean(forward.valid && forwardRecord?.valid && forwardRecord.subjectHash === record.coreHash && forwardRecord.attestationHash === record.forwardWitness.attestationHash);
    const cryptoValid = Boolean(crypto.valid && crypto.worldRoot === record.coreHash && Number(crypto.familyQuorum || 0) >= 2);
    const historicalRegistryAvailable = Boolean(historicalContracts?.registryHash && historicalContracts.registryHash === record.contracts?.registryHash);
    const currentRegistryMatches = Boolean(currentContracts?.registryHash && currentContracts.registryHash === record.contracts?.registryHash);
    const prefixHeadMatches = Boolean(prefix.valid && prefix.decisionsChecked === checkpointCount && prefix.headHash === (record.firewall?.headHash || null));
    const historicalPrefixValid = Boolean(prefix.valid && prefixHeadMatches);

    return {
      format: 'JSONDB-POLICY-CHECKPOINT-VERIFY-4',
      id: record.id,
      valid: computedCheckpointHash === record.checkpointHash && computedCoreHash === record.coreHash && cryptoValid && forwardValid && historicalRegistryAvailable && historicalPrefixValid,
      staticValid: computedCheckpointHash === record.checkpointHash,
      coreValid: computedCoreHash === record.coreHash,
      cryptoCouncilValid: cryptoValid,
      forwardWitnessValid: forwardValid,
      historicalRegistryAvailable,
      currentRegistryMatches,
      policyDriftedSinceCheckpoint: historicalRegistryAvailable && !currentRegistryMatches,
      checkpointDecisionCount: checkpointCount,
      prefixHeadMatches,
      historicalPrefixValid,
      historicalPrefixFullyPolicyReplayable: prefix.fullyPolicyReplayable,
      historicalPrefixLegacyUnboundDecisions: prefix.legacyUnboundDecisions || 0,
      liveFirewallLedgerValid: liveFirewall.valid,
      liveFirewallFullyPolicyReplayable: liveFirewall.fullyPolicyReplayable,
      futureTailIncident: historicalPrefixValid && liveFirewall.valid === false,
      checkpointFirewallHead: record.firewall?.headHash || null,
      liveFirewallHead: liveFirewall.headHash || null,
      doctrine: 'Historical validity is based on the exact checkpointed Firewall prefix and historical constitution. Later-tail corruption is surfaced separately as a current incident.'
    };
  }
}

module.exports = { PolicyCheckpoint };
