'use strict';

const path = require('path');
const { now, readJson, atomicJson, ensureDir } = require('./jsonfs');

class SurvivalFabric {
  constructor({
    engine, savior, guardian, truth, council, immune, orthogonal, trinity,
    genome, fractal, metamorphic, chronicle, braid, oracle,
    trustBudget = null, challenge = null
  }) {
    Object.assign(this, {
      engine, savior, guardian, truth, council, immune, orthogonal, trinity,
      genome, fractal, metamorphic, chronicle, braid, oracle, trustBudget, challenge
    });
    this.root = path.join(savior.root, 'survival-fabric');
    this.receipts = path.join(this.root, 'receipts');
    this.latest = path.join(this.root, 'latest.json');
  }

  async init() {
    await ensureDir(this.receipts);
    const inits = [
      this.savior, this.guardian, this.council, this.immune, this.orthogonal,
      this.trinity, this.genome, this.fractal, this.chronicle, this.braid, this.challenge
    ].filter(x => x && typeof x.init === 'function');
    for (const system of inits) await system.init();
    return this.status({ deep: false });
  }

  async archiveReceipt(type, payload) {
    await ensureDir(this.receipts);
    const id = `${Date.now()}-${String(type).replace(/[^A-Za-z0-9_-]/g,'_')}`;
    const receipt = { format: 'JSONDB-SURVIVAL-RECEIPT-1', id, type, at: now(), payload };
    await atomicJson(path.join(this.receipts, `${id}.json`), receipt);
    await atomicJson(this.latest, receipt);
    return receipt;
  }

  async status(options = {}) {
    const deep = options.deep === true;
    const current = await this.savior.status();
    const [truth, chronicle, braid, witness, immune, genome, challengeCoverage] = await Promise.all([
      this.truth.worldVerdict().catch(error => ({ status: 'ERROR', confidence: 0, error: error.message })),
      this.chronicle.verify().catch(error => ({ valid: false, error: error.message })),
      this.braid.verify().catch(error => ({ valid: false, error: error.message })),
      this.council.verifyRound().catch(error => ({ valid: false, error: error.message })),
      this.immune.scan().catch(error => ({ status: 'ERROR', health: 0, error: error.message })),
      this.genome.verify().catch(error => ({ valid: false, error: error.message })),
      this.challenge ? this.challenge.coverage().catch(error => ({ rounds: 0, error: error.message })) : Promise.resolve(null)
    ]);
    let trinity = { status: 'UNVERIFIED' };
    const latestTrinity = await readJson(path.join(this.trinity.root, 'latest.json'), null);
    if (!latestTrinity) trinity = { status: 'ABSENT' };
    else if (deep) trinity = await this.trinity.verify().catch(error => ({ status: 'ERROR', error: error.message }));
    let oracle = null;
    if (this.oracle) oracle = await this.oracle.assess({ verifyArchives: deep }).catch(error => ({ verdict: 'PANIC', confidence: 0, error: error.message }));
    const trustBudget = this.trustBudget && oracle ? this.trustBudget.evaluate(oracle) : null;
    return {
      format: 'JSONDB-SURVIVAL-FABRIC-STATUS-2', at: now(), mode: current.mode,
      summary: {
        truth: truth.status, truthConfidence: truth.confidence,
        chronicle: chronicle.valid === true ? 'VALID' : 'INVALID',
        braid: braid.valid === true ? 'VALID' : 'INVALID',
        signedWitness: witness.valid === true ? 'VALID' : 'INVALID',
        immune: immune.status,
        genome: genome.valid === true ? 'VALID' : genome.reason === 'genome missing' ? 'ABSENT' : 'INVALID',
        trinity: trinity.status,
        oracle: oracle?.verdict || null,
        oracleConfidence: oracle?.confidence ?? null,
        independenceAdjustedTrust: trustBudget?.independenceAdjustedConfidence ?? null,
        trustDiversity: trustBudget?.verdict || null,
        challengeRounds: challengeCoverage?.rounds ?? null
      },
      truth, chronicle, braid, witness, immune, genome, trinity, oracle, trustBudget, challengeCoverage
    };
  }

  async seal(label = 'fabric-epoch', options = {}) {
    await this.savior.assertWritable();
    const mirror = await this.savior.captureMirrors();
    const temporal = await this.guardian.witnessRound(`${label}:temporal`);
    const signed = await this.council.round(temporal.worldRoot, {
      label, temporalEpoch: temporal.epoch, temporalRoundHash: temporal.roundHash,
      saviorMode: (await this.savior.status()).mode
    });
    const chronicle = await this.chronicle.verify();
    if (!chronicle.valid) {
      await this.savior.setMode('read-only', `Survival Fabric Chronicle invalid during seal ${label}`);
      throw Object.assign(new Error('Chronicle invalid during fabric seal; writes frozen.'), { status: 503 });
    }

    let trinity = null;
    let genome = null;
    if (options.trinity === true || options.level === 'ULTIMATE') trinity = await this.trinity.archive(label);
    if (options.genome === true || options.level === 'ULTIMATE') genome = await this.genome.create(label);

    const braid = await this.braid.weave(label, { verifyChronicle: true });
    if (braid.contradictions?.length) await this.savior.setMode('read-only', `Cross-history contradiction during seal ${label}`);

    let challenge = null;
    if (this.challenge && (options.challenge === true || options.level === 'ULTIMATE')) {
      challenge = await this.challenge.challenge({ perFile: options.challengePerFile || 4, freezeOnFailure: true });
    }

    const immune = await this.immune.scan().catch(error => ({ status: 'ERROR', health: 0, error: error.message }));
    const oracle = this.oracle ? await this.oracle.assess({ verifyArchives: options.verifyArchives === true }) : null;
    const trustBudget = this.trustBudget && oracle ? this.trustBudget.evaluate(oracle) : null;
    if (trustBudget && ['UNTRUSTED','INSUFFICIENT_DIVERSITY'].includes(trustBudget.verdict) && options.enforceTrustBudget === true) {
      await this.savior.setMode('read-only', `Failure-domain trust budget ${trustBudget.verdict} at ${trustBudget.independenceAdjustedConfidence}%`);
    }

    const result = {
      format: 'JSONDB-SURVIVAL-FABRIC-SEAL-2', at: now(), label,
      level: options.level || 'NORMAL',
      mirror: { files: mirror.files?.length || 0, capture: mirror.capture || mirror.id || null },
      temporal: { epoch: temporal.epoch, worldRoot: temporal.worldRoot, roundHash: temporal.roundHash },
      signed: { valid: signed.valid, signatures: signed.validSignatures, threshold: signed.threshold, roundId: signed.statement?.roundId },
      chronicle: { valid: chronicle.valid, replayRoot: chronicle.replayRoot, liveRoot: chronicle.liveRoot, appliedCommits: chronicle.appliedCommits },
      braid: { sequence: braid.sequence, epochHash: braid.epochHash, contradictions: braid.contradictions },
      immune: { status: immune.status, health: immune.health },
      challenge: challenge ? { id: challenge.id, healthy: challenge.healthy, disagreements: challenge.disagreements, unreadable: challenge.unreadable } : null,
      trinity, genome, oracle, trustBudget
    };
    await this.archiveReceipt('seal', result);
    return result;
  }

  async verifyQuery(query, options = {}) {
    const verification = await this.metamorphic.verify(query, { freezeOnMismatch: options.freezeOnMismatch !== false });
    const receipt = await this.archiveReceipt('metamorphic-query', {
      query, match: verification.match,
      optimizedHash: verification.optimizedHash, referenceHash: verification.referenceHash,
      optimizedTotal: verification.optimizedTotal, referenceTotal: verification.referenceTotal
    });
    return { ...verification, receipt: receipt.id };
  }

  async recoveryCase(options = {}) {
    const status = await this.status({ deep: true });
    const braidQuorum = await this.braid.quorumHead().catch(error => ({ winner: null, error: error.message }));
    const chronicle = status.chronicle;
    const trinity = status.trinity;
    const recommendations = [];
    const blockers = [];

    if (trinity.status === 'TRUSTED') recommendations.push({ priority: 1, action: 'RESTORE_TRINITY_SANDBOX', reason: 'At least two independent decoder families reconstructed the expected world hash.' });
    else if (trinity.status === 'DEGRADED') recommendations.push({ priority: 3, action: 'INSPECT_TRINITY_DEGRADED', reason: 'Only one decoder family reconstructed the expected world; explicit degraded recovery required.' });
    else blockers.push({ channel: 'trinity', reason: trinity.status || 'unavailable' });

    if (chronicle.valid && chronicle.liveMatchesReplay) recommendations.push({ priority: 2, action: 'USE_CHRONICLE_AS_SEMANTIC_WITNESS', reason: 'Independent semantic replay matches live state.' });
    else if (chronicle.valid) recommendations.push({ priority: 2, action: 'REPLAY_CHRONICLE_TO_SANDBOX', reason: 'Chronicle history is internally valid but live world diverges.' });
    else blockers.push({ channel: 'chronicle', reason: chronicle.failures || chronicle.error || 'invalid' });

    if (status.truth.status === 'TRUSTED') recommendations.push({ priority: 2, action: 'USE_PRESENT_MIRROR_QUORUM', reason: 'Truth Lattice rates current mirror world trusted.' });
    else if (['DEGRADED','FROZEN'].includes(status.truth.status)) recommendations.push({ priority: 4, action: 'DESCEND_TO_FRACTAL_QUORUM', reason: `Whole-file truth is ${status.truth.status}; reconstruct table/row/field evidence in sandboxes.` });
    else blockers.push({ channel: 'truth-lattice', reason: status.truth.status });

    if (braidQuorum.winner) recommendations.push({ priority: 2, action: 'TRUST_BRAID_LINEAGE', reason: `${braidQuorum.winner.votes}/${braidQuorum.total} replicated braid heads agree.` });
    else blockers.push({ channel: 'cross-history-braid', reason: 'No majority braid head across survival roots.' });

    if (status.genome.valid) recommendations.push({ priority: 5, action: 'PRESERVE_RECOVERY_GENOME', reason: 'Recovery source material verifies and can rebuild rescue tools.' });
    if (status.trustBudget?.verdict === 'DIVERSE_TRUST') recommendations.push({ priority: 2, action: 'PREFER_CROSS_DOMAIN_AGREEMENT', reason: 'Trust remains high after correlated evidence is discounted by failure domain.' });
    else if (status.trustBudget) blockers.push({ channel: 'failure-domain-trust-budget', reason: `${status.trustBudget.verdict} at ${status.trustBudget.independenceAdjustedConfidence}%` });

    if (this.challenge && options.challenge === true) {
      const scrub = await this.challenge.challenge({ perFile: options.challengePerFile || 8, freezeOnFailure: false });
      if (scrub.healthy) recommendations.push({ priority: 3, action: 'USE_RECENT_CHALLENGE_SCRUB_AS_LATENT_ROT_EVIDENCE', reason: `${scrub.totalChallenges} deterministic byte challenges agreed.` });
      else blockers.push({ channel: 'challenge-scrubber', reason: `${scrub.disagreements} disagreements, ${scrub.unreadable} unreadable responses` });
    }

    const fractal = [];
    if (options.fractalTables === true) {
      const catalog = await this.engine.catalog();
      for (const name of Object.keys(catalog.collections || {}).sort()) {
        fractal.push(await this.fractal.reconstruct(`current/${name}.json`).catch(error => ({ status: 'ERROR', collection: name, error: error.message })));
      }
    }

    recommendations.sort((a,b)=>a.priority-b.priority);
    const dossier = {
      format: 'JSONDB-SURVIVAL-RECOVERY-CASE-2', at: now(),
      currentMode: (await this.savior.status()).mode,
      doctrine: 'Recovery evidence may reconstruct into sandboxes automatically. Promotion to canonical state is never automatic.',
      recommendations, blockers, status, braidQuorum, fractal
    };
    const receipt = await this.archiveReceipt('recovery-case', dossier);
    return { ...dossier, receipt: receipt.id };
  }

  async emergencySeal(reason = 'emergency seal') {
    const before = await this.savior.status();
    if (before.mode === 'read-write') await this.savior.setMode('read-only', reason);
    const outputs = {};
    outputs.mirrors = await this.savior.captureMirrors().catch(error => ({ error: error.message }));
    outputs.temporal = await this.guardian.witnessRound('emergency-seal').catch(error => ({ error: error.message }));
    if (outputs.temporal?.worldRoot) outputs.signed = await this.council.round(outputs.temporal.worldRoot, { reason, emergency: true }).catch(error => ({ error: error.message }));
    outputs.challenge = this.challenge ? await this.challenge.challenge({ perFile: 16, freezeOnFailure: false }).catch(error => ({ error: error.message })) : null;
    outputs.trinity = await this.trinity.archive('emergency-seal').catch(error => ({ error: error.message }));
    outputs.genome = await this.genome.create('emergency-seal').catch(error => ({ error: error.message }));
    outputs.braid = await this.braid.weave('emergency-seal').catch(error => ({ error: error.message }));
    await this.savior.setMode('panic', reason);
    const result = { format: 'JSONDB-EMERGENCY-SEAL-2', at: now(), reason, previousMode: before.mode, currentMode: 'panic', outputs };
    await this.archiveReceipt('emergency-seal', result);
    return result;
  }
}

module.exports = { SurvivalFabric };
