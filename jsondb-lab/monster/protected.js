'use strict';

class ProtectedCommitCoordinator {
  constructor({
    engine, savior, chronicle, guardian, council, orthogonal, braid,
    fabric, nversion, memoryPalace = null
  }) {
    Object.assign(this, {
      engine, savior, chronicle, guardian, council, orthogonal, braid,
      fabric, nversion, memoryPalace
    });
  }

  async failCommitted(result, stage, error) {
    await this.savior.setMode('read-only', `Committed transaction ${result?.tx ?? '?'} failed post-commit survival stage ${stage}: ${error.message}`);
    throw Object.assign(new Error(`Transaction committed, but ${stage} failed. Future writes frozen: ${error.message}`), {
      status: 503, committed: true, tx: result?.tx, failedSurvivalStage: stage
    });
  }

  async transact(spec = {}) {
    await this.savior.assertWritable();
    const inputOps = Array.isArray(spec.ops) ? spec.ops : [];
    const survivalLevel = String(spec.survivalLevel || 'NORMAL').toUpperCase();

    const preflight = await this.nversion.preflight(inputOps, { freezeOnDivergence: true });
    if (!preflight.unanimous) throw Object.assign(new Error('N-version mutation preflight diverged; transaction refused before commit.'), { status: 409, preflight });
    const ops = preflight.frozenOps;

    const chroniclePrepare = await this.chronicle.prepare(ops);
    const preWitness = await this.guardian.witnessRound('pre-transaction');
    const result = await this.engine.transact(ops, { isolation: spec.isolation });

    let chronicleEntry;
    try { chronicleEntry = await this.chronicle.commit(chroniclePrepare, ops, result, { survivalLevel, nVersionPredictedHash: preflight.predictedHash }); }
    catch (error) { return this.failCommitted(result, 'semantic-chronicle-append', error); }

    let postflight;
    try { postflight = await this.nversion.postflight(preflight, { freezeOnMismatch: true }); }
    catch (error) { return this.failCommitted(result, 'n-version-postflight', error); }
    if (!postflight.match) return this.failCommitted(result, 'n-version-postflight', new Error(`${postflight.predictedHash} != ${postflight.liveHash}`));

    let mirror;
    try { mirror = await this.savior.captureMirrors(); }
    catch (error) { return this.failCommitted(result, 'mirror-capture', error); }

    let postWitness;
    try { postWitness = await this.guardian.witnessRound('post-transaction'); }
    catch (error) { return this.failCommitted(result, 'temporal-witness', error); }

    let signed;
    try {
      signed = await this.council.round(postWitness.worldRoot, {
        tx: result.tx, survivalLevel,
        temporalEpoch: postWitness.epoch, temporalRoundHash: postWitness.roundHash,
        nVersionPredictedHash: preflight.predictedHash
      });
    } catch (error) { return this.failCommitted(result, 'signed-witness-council', error); }

    let orthogonalArchive = null;
    if (['MAXIMUM','ULTIMATE'].includes(survivalLevel)) {
      try { orthogonalArchive = await this.orthogonal.archive(`tx-${result.tx || Date.now()}`); }
      catch (error) { return this.failCommitted(result, 'orthogonal-archive', error); }
    }

    let fabricSeal = null;
    if (survivalLevel === 'ULTIMATE') {
      try {
        fabricSeal = await this.fabric.seal(`tx-${result.tx}`, {
          level: 'ULTIMATE', trinity: true, genome: true, challenge: true,
          verifyArchives: false, enforceTrustBudget: true
        });
      } catch (error) { return this.failCommitted(result, 'ultimate-fabric-seal', error); }
    } else {
      try {
        const epoch = await this.braid.weave(`tx-${result.tx}`, { verifyChronicle: true });
        if (epoch.contradictions?.length) await this.savior.setMode('read-only', `Cross-history contradiction after tx ${result.tx}`);
        fabricSeal = { braid: { sequence: epoch.sequence, epochHash: epoch.epochHash, contradictions: epoch.contradictions } };
      } catch (error) { return this.failCommitted(result, 'cross-history-braid', error); }
    }

    let memoryPalace = null;
    if (survivalLevel === 'ULTIMATE' && this.memoryPalace) {
      try { memoryPalace = await this.memoryPalace.snapshot(`tx-${result.tx}`); }
      catch (error) { return this.failCommitted(result, 'memory-palace-snapshot', error); }
    }

    const verifiedQueries = [];
    if (Array.isArray(spec.verifyQueries)) {
      for (const query of spec.verifyQueries.slice(0, 25)) {
        const check = await this.fabric.verifyQuery(query, { freezeOnMismatch: true });
        verifiedQueries.push(check);
        if (!check.match) return this.failCommitted(result, 'metamorphic-query-verification', new Error(`Query disagreement ${check.optimizedHash} != ${check.referenceHash}`));
      }
    }

    return {
      result,
      survivalProtocol: {
        level: survivalLevel,
        nVersion: {
          preflightHash: preflight.predictedHash,
          postflightHash: postflight.liveHash,
          reducers: preflight.executions
        },
        semanticCommit: { sequence: chronicleEntry.sequence, entryHash: chronicleEntry.entryHash, worldRoot: chronicleEntry.afterRoot },
        preWitness: preWitness.roundHash,
        postWitness: postWitness.roundHash,
        signedWitnessCouncil: { valid: signed.valid, validSignatures: signed.validSignatures, threshold: signed.threshold, roundId: signed.statement?.roundId },
        mirrorFiles: mirror.files?.length || 0,
        orthogonalArchive,
        fabricSeal,
        memoryPalace: memoryPalace ? {
          id: memoryPalace.id, worldSha256: memoryPalace.worldSha256,
          chunks: memoryPalace.chunkCount, dedup: memoryPalace.dedup
        } : null,
        verifiedQueries: verifiedQueries.map(x => ({ match: x.match, optimizedHash: x.optimizedHash, referenceHash: x.referenceHash, receipt: x.receipt }))
      }
    };
  }
}

module.exports = { ProtectedCommitCoordinator };
