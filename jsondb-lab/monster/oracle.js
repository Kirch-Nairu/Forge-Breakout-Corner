'use strict';

const path = require('path');
const { readJson, now } = require('./jsonfs');

class SurvivalOracle {
  constructor({ savior, guardian, truth, orthogonal, council, immune = null, chronicle = null, braid = null, trinity = null, genome = null }) {
    Object.assign(this, { savior, guardian, truth, orthogonal, council, immune, chronicle, braid, trinity, genome });
  }

  async attest(label = 'oracle') {
    const temporal = await this.guardian.witnessRound(label);
    const signed = await this.council.round(temporal.worldRoot, {
      temporalEpoch: temporal.epoch,
      temporalRoundHash: temporal.roundHash,
      saviorMode: (await this.savior.status()).mode
    });
    return { temporal, signed };
  }

  async assess(options = {}) {
    const canary = await this.savior.canary().catch(error => ({ ok: false, error: error.message }));
    const temporalChain = await this.guardian.verifyChain().catch(error => ({ healthy: false, error: error.message }));
    const truth = await this.truth.worldVerdict().catch(error => ({ status: 'UNKNOWN', confidence: 0, error: error.message }));
    const signed = await this.council.verifyRound().catch(error => ({ valid: false, error: error.message }));
    const immune = this.immune ? await this.immune.scan().catch(error => ({ status: 'ERROR', health: 0, error: error.message })) : { status: 'DISABLED', health: null };
    const chronicle = this.chronicle ? await this.chronicle.verify().catch(error => ({ valid: false, liveMatchesReplay: false, error: error.message })) : { valid: null, liveMatchesReplay: null, disabled: true };
    const braid = this.braid ? await this.braid.verify().catch(error => ({ valid: false, error: error.message })) : { valid: null, disabled: true };
    const braidQuorum = this.braid ? await this.braid.quorumHead().catch(error => ({ winner: null, error: error.message })) : { winner: null, disabled: true };
    const genome = this.genome ? await this.genome.verify().catch(error => ({ valid: false, error: error.message })) : { valid: null, disabled: true };

    const latestOrthogonal = await readJson(path.join(this.orthogonal.root, 'latest.json'), null);
    let orthogonal = { status: latestOrthogonal ? 'UNVERIFIED' : 'ABSENT' };
    if (options.verifyArchives && latestOrthogonal) orthogonal = await this.orthogonal.verify().catch(error => ({ status: 'ERROR', error: error.message }));

    let trinity = { status: this.trinity ? 'UNVERIFIED' : 'DISABLED' };
    if (this.trinity) {
      const latestTrinity = await readJson(path.join(this.trinity.root, 'latest.json'), null);
      if (!latestTrinity) trinity = { status: 'ABSENT' };
      else if (options.verifyArchives) trinity = await this.trinity.verify().catch(error => ({ status: 'ERROR', error: error.message }));
    }

    const evidence = [];
    let raw = 0;
    let possible = 0;
    const add = (channel, max, awarded, ok, details) => {
      raw += awarded; possible += max;
      evidence.push({ channel, possible: max, awarded, ok, details });
    };

    add('storage-canary', 8, canary.ok === true ? 8 : 0, canary.ok === true, canary);
    add('temporal-chain', 10, temporalChain.healthy === true ? 10 : 0, temporalChain.healthy === true, temporalChain);
    add('signed-witness-council', 12, signed.valid === true ? 12 : 0, signed.valid === true, { valid: signed.valid, validSignatures: signed.validSignatures, threshold: signed.threshold, worldRoot: signed.statement?.worldRoot });

    const truthPoints = truth.status === 'TRUSTED' ? 18 : truth.status === 'DEGRADED' ? 12 : truth.status === 'FROZEN' ? 4 : 0;
    add('truth-lattice', 18, truthPoints, truthPoints >= 12, { status: truth.status, confidence: truth.confidence });

    let immunePoints = 4;
    if (immune.status === 'HEALTHY') immunePoints = 10;
    else if (immune.status === 'SUSPICIOUS') immunePoints = 6;
    else if (['SICK','HOSTILE','ERROR'].includes(immune.status)) immunePoints = 0;
    add('semantic-immune-system', 10, immunePoints, immunePoints >= 6 || immune.status === 'UNTRAINED' || immune.status === 'DISABLED', { status: immune.status, health: immune.health });

    const chroniclePoints = chronicle.disabled ? 0 : chronicle.valid && chronicle.liveMatchesReplay ? 16 : chronicle.valid ? 8 : 0;
    add('semantic-chronicle', chronicle.disabled ? 0 : 16, chroniclePoints, chroniclePoints === 16 || chronicle.disabled, {
      valid: chronicle.valid, liveMatchesReplay: chronicle.liveMatchesReplay,
      replayRoot: chronicle.replayRoot, liveRoot: chronicle.liveRoot, failures: chronicle.failures?.length
    });

    const braidPoints = braid.disabled ? 0 : braid.valid && braidQuorum.winner ? 12 : braid.valid ? 6 : 0;
    add('cross-history-braid', braid.disabled ? 0 : 12, braidPoints, braidPoints === 12 || braid.disabled, {
      valid: braid.valid, epochs: braid.epochs, quorumHead: braidQuorum.winner,
      currentContradictions: braid.currentContradictions?.length || 0
    });

    const archivePoints = orthogonal.status === 'STRONG' ? 5 : (!options.verifyArchives && latestOrthogonal) ? 3 : orthogonal.status === 'DEGRADED' ? 2 : 0;
    add('orthogonal-archive', 5, archivePoints, archivePoints >= 3, { status: orthogonal.status, id: latestOrthogonal?.id });

    if (this.trinity) {
      const trinityPoints = trinity.status === 'TRUSTED' ? 6 : (!options.verifyArchives && trinity.status === 'UNVERIFIED') ? 3 : trinity.status === 'DEGRADED' ? 2 : 0;
      add('trinity-decoder-quorum', 6, trinityPoints, trinityPoints >= 3, { status: trinity.status, winner: trinity.winner });
    }

    if (this.genome) {
      add('survivor-genome', 3, genome.valid ? 3 : 0, genome.valid === true, { valid: genome.valid, id: genome.id, reason: genome.reason });
    }

    const contradictions = [];
    const latestTemporal = await readJson(this.guardian.latest, null);
    if (signed.statement?.worldRoot && latestTemporal?.worldRoot && signed.statement.worldRoot !== latestTemporal.worldRoot) {
      contradictions.push({ type: 'SIGNED_TEMPORAL_ROOT_CONTRADICTION', penalty: 35, signed: signed.statement.worldRoot, temporal: latestTemporal.worldRoot });
    }
    if (chronicle.valid && chronicle.liveMatchesReplay === false) contradictions.push({ type: 'LIVE_CHRONICLE_REPLAY_CONTRADICTION', penalty: 45, replayRoot: chronicle.replayRoot, liveRoot: chronicle.liveRoot });
    if (braid.valid === false) contradictions.push({ type: 'BRAID_CHAIN_INVALID', penalty: 30 });
    if (braid.currentContradictions?.length) contradictions.push({ type: 'BRAID_CURRENT_CONTRADICTIONS', penalty: Math.min(35, braid.currentContradictions.length * 12), count: braid.currentContradictions.length });
    if (this.braid && !braidQuorum.winner) contradictions.push({ type: 'BRAID_HEAD_HAS_NO_MAJORITY', penalty: 20 });
    if (trinity.status === 'LOST' || trinity.status === 'ERROR') contradictions.push({ type: 'TRINITY_RECOVERY_UNAVAILABLE', penalty: 12, status: trinity.status });
    if (immune.status === 'HOSTILE') contradictions.push({ type: 'SEMANTIC_IMMUNE_HOSTILE', penalty: 35 });

    const penalties = contradictions.reduce((sum, x) => sum + Number(x.penalty || 0), 0);
    const normalized = possible ? Math.round((raw / possible) * 100) : 0;
    const confidence = Math.max(0, Math.min(100, normalized - penalties));

    let verdict = 'UNKNOWN';
    const hardPanic = contradictions.some(x => ['SIGNED_TEMPORAL_ROOT_CONTRADICTION','LIVE_CHRONICLE_REPLAY_CONTRADICTION','BRAID_CHAIN_INVALID'].includes(x.type));
    if (hardPanic || !canary.ok || truth.status === 'UNKNOWN' || immune.status === 'HOSTILE') verdict = 'PANIC';
    else if (immune.status === 'SICK' || truth.status === 'FROZEN' || contradictions.length || confidence < 80) verdict = confidence >= 45 ? 'READ_ONLY' : 'PANIC';
    else if (confidence >= 88 && truth.status === 'TRUSTED' && signed.valid && temporalChain.healthy && chroniclePoints >= (chronicle.disabled ? 0 : 16) && braidPoints >= (braid.disabled ? 0 : 12)) verdict = 'SAFE';
    else if (confidence >= 60) verdict = 'READ_ONLY';
    else verdict = 'PANIC';

    return {
      format: 'JSONDB-SURVIVAL-ORACLE-3', at: now(), verdict, confidence,
      rawEvidenceScore: raw, possibleEvidenceScore: possible, normalizedBeforePenalties: normalized,
      doctrine: 'Independent evidence can increase confidence. Direct contradictions dominate unrelated positive evidence. Automatic action may only preserve or reduce authority.',
      evidence, contradictions,
      summary: {
        canary: canary.ok, temporalChain: temporalChain.healthy,
        witnessCouncil: signed.valid, truth: truth.status, truthConfidence: truth.confidence,
        immune: immune.status, immuneHealth: immune.health,
        chronicle: chronicle.valid, chronicleLiveMatchesReplay: chronicle.liveMatchesReplay,
        braid: braid.valid, braidQuorum: Boolean(braidQuorum.winner),
        orthogonal: orthogonal.status, trinity: trinity.status,
        genome: genome.valid
      }
    };
  }

  async enforce(options = {}) {
    const assessment = await this.assess(options);
    const current = await this.savior.status();
    let action = 'NONE';
    if (assessment.verdict === 'PANIC' && current.mode !== 'panic') {
      await this.savior.setMode('panic', `Oracle panic at confidence ${assessment.confidence}: ${assessment.contradictions.map(x => x.type).join(', ') || 'insufficient evidence'}`);
      action = 'ENTER_PANIC';
    } else if (assessment.verdict === 'READ_ONLY' && current.mode === 'read-write') {
      await this.savior.setMode('read-only', `Oracle degraded at confidence ${assessment.confidence}`);
      action = 'FREEZE_WRITES';
    } else if (assessment.verdict === 'SAFE' && current.mode !== 'read-write') {
      action = 'OPERATOR_REVIEW_REQUIRED_TO_REOPEN';
    }
    return { assessment, previousMode: current.mode, currentMode: (await this.savior.status()).mode, action };
  }
}

module.exports = { SurvivalOracle };
