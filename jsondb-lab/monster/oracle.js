'use strict';

const path = require('path');
const { readJson, now } = require('./jsonfs');

class SurvivalOracle {
  constructor({ savior, guardian, truth, orthogonal, council, immune = null }) {
    this.savior = savior;
    this.guardian = guardian;
    this.truth = truth;
    this.orthogonal = orthogonal;
    this.council = council;
    this.immune = immune;
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
    const latestOrthogonal = await readJson(path.join(this.orthogonal.root, 'latest.json'), null);
    let orthogonal = { status: latestOrthogonal ? 'UNVERIFIED' : 'ABSENT' };
    if (options.verifyArchives && latestOrthogonal) orthogonal = await this.orthogonal.verify().catch(error => ({ status: 'ERROR', error: error.message }));

    const evidence = [];
    let score = 0;
    const add = (channel, possible, awarded, ok, details) => {
      score += awarded;
      evidence.push({ channel, possible, awarded, ok, details });
    };
    add('storage-canary', 10, canary.ok === true ? 10 : 0, canary.ok === true, canary);
    add('temporal-chain', 15, temporalChain.healthy === true ? 15 : 0, temporalChain.healthy === true, temporalChain);
    add('signed-witness-council', 20, signed.valid === true ? 20 : 0, signed.valid === true, signed);
    const truthPoints = truth.status === 'TRUSTED' ? 30 : truth.status === 'DEGRADED' ? 20 : truth.status === 'FROZEN' ? 8 : 0;
    add('truth-lattice', 30, truthPoints, truthPoints >= 20, { status: truth.status, confidence: truth.confidence });
    let immunePoints = 5;
    if (immune.status === 'HEALTHY') immunePoints = 15;
    else if (immune.status === 'SUSPICIOUS') immunePoints = 10;
    else if (immune.status === 'SICK' || immune.status === 'HOSTILE' || immune.status === 'ERROR') immunePoints = 0;
    add('semantic-immune-system', 15, immunePoints, immunePoints >= 10 || immune.status === 'UNTRAINED', { status: immune.status, health: immune.health });
    const archivePoints = orthogonal.status === 'STRONG' ? 10 : (!options.verifyArchives && latestOrthogonal) ? 7 : orthogonal.status === 'DEGRADED' ? 4 : 0;
    add('orthogonal-archive', 10, archivePoints, archivePoints >= 7, { status: orthogonal.status, id: latestOrthogonal?.id });

    const latestTemporal = await readJson(this.guardian.latest, null);
    const rootDisagreement = Boolean(signed.statement?.worldRoot && latestTemporal?.worldRoot && signed.statement.worldRoot !== latestTemporal.worldRoot);
    if (rootDisagreement) {
      score -= 35;
      evidence.push({ channel: 'root-contradiction', possible: 0, awarded: -35, ok: false, details: { council: signed.statement.worldRoot, temporal: latestTemporal.worldRoot } });
    }
    score = Math.max(0, Math.min(100, score));

    let verdict = 'UNKNOWN';
    if (rootDisagreement || !canary.ok || truth.status === 'UNKNOWN' || immune.status === 'HOSTILE') verdict = 'PANIC';
    else if (immune.status === 'SICK' || truth.status === 'FROZEN') verdict = 'READ_ONLY';
    else if (score >= 85 && truth.status === 'TRUSTED' && signed.valid && temporalChain.healthy && !['SICK','HOSTILE','ERROR'].includes(immune.status)) verdict = 'SAFE';
    else if (score >= 60) verdict = 'READ_ONLY';
    else verdict = 'PANIC';

    return {
      format: 'JSONDB-SURVIVAL-ORACLE-2', at: now(), verdict, confidence: score,
      doctrine: 'No single evidence channel can reopen writes. Automatic action may only preserve or reduce authority.',
      evidence,
      summary: {
        canary: canary.ok, temporalChain: temporalChain.healthy,
        witnessCouncil: signed.valid, truth: truth.status,
        truthConfidence: truth.confidence, immune: immune.status,
        immuneHealth: immune.health, orthogonal: orthogonal.status,
        rootDisagreement
      }
    };
  }

  async enforce(options = {}) {
    const assessment = await this.assess(options);
    const current = await this.savior.status();
    let action = 'NONE';
    if (assessment.verdict === 'PANIC' && current.mode !== 'panic') {
      await this.savior.setMode('panic', `Oracle panic at confidence ${assessment.confidence}`);
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
