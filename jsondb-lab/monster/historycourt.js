'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

class HistoryCourt {
  constructor({ savior, worldTree, chronicle, braid, cryptoCouncil, memory, polyhash }) {
    this.savior = savior;
    this.worldTree = worldTree;
    this.chronicle = chronicle;
    this.braid = braid;
    this.cryptoCouncil = cryptoCouncil;
    this.memory = memory;
    this.polyhash = polyhash;
    this.root = path.join(savior.root, 'history-court');
    this.cases = path.join(this.root, 'cases');
  }

  async init() { await ensureDir(this.cases); }

  async lineage(refOrCommit, limit = 256) {
    const start = await this.worldTree.resolve(refOrCommit);
    const log = await this.worldTree.log(start.id, limit);
    return {
      head: start,
      commits: log,
      ids: new Set(log.map(x => x.id)),
      worldHashes: new Set(log.map(x => x.worldSha256).filter(Boolean))
    };
  }

  async evidence(refOrCommit) {
    const lineage = await this.lineage(refOrCommit);
    const headWorld = await this.worldTree.world(lineage.head);
    const memory = await this.memory.verify(lineage.head.memoryPalaceId).catch(error => ({ valid: false, error: error.message }));
    const crypto = await this.cryptoCouncil.verify().catch(error => ({ valid: false, status: 'UNAVAILABLE', error: error.message }));
    const chronicle = await this.chronicle.verify().catch(error => ({ valid: false, error: error.message }));
    const braid = await this.braid.verify().catch(error => ({ valid: false, error: error.message }));
    const braidQuorum = await this.braid.quorumHead().catch(error => ({ winner: null, error: error.message }));
    const semantic = hash(headWorld.world);

    return {
      refOrCommit,
      head: lineage.head,
      commitCount: lineage.commits.length,
      semanticWorldSha256: semantic,
      memory: { valid: memory.valid === true, worldSha256: memory.worldSha256 || null, error: memory.error },
      crypto: { valid: crypto.valid === true, status: crypto.status, worldRoot: crypto.worldRoot || null, familyQuorum: crypto.familyQuorum || 0 },
      chronicle: { valid: chronicle.valid === true, liveMatchesReplay: chronicle.liveMatchesReplay === true, replayRoot: chronicle.replayRoot || null, liveRoot: chronicle.liveRoot || null },
      braid: { valid: braid.valid === true, head: braid.head || braid.latest || null, quorumHead: braidQuorum.winner || null },
      lineage
    };
  }

  score(e) {
    let score = 0;
    const reasons = [];
    const add = (name, points, ok, details = null) => { if (ok) score += points; reasons.push({ name, points: ok ? points : 0, possible: points, ok, details }); };
    add('memory-palace', 20, e.memory.valid, e.memory);
    add('dual-crypto-family', 20, e.crypto.valid && e.crypto.familyQuorum >= 2, e.crypto);
    add('chronicle-valid', 15, e.chronicle.valid, e.chronicle);
    add('chronicle-live-match', 15, e.chronicle.liveMatchesReplay, e.chronicle);
    add('braid-valid', 15, e.braid.valid, e.braid);
    add('world-hash-self-consistency', 15, !e.memory.worldSha256 || e.memory.worldSha256 === e.head.worldSha256, { memory: e.memory.worldSha256, commit: e.head.worldSha256 });
    return { score, reasons };
  }

  async compare(a, b, options = {}) {
    await this.init();
    const [ea, eb] = await Promise.all([this.evidence(a), this.evidence(b)]);
    const ancestor = await this.worldTree.commonAncestor(ea.head.id, eb.head.id);
    const sa = this.score(ea);
    const sb = this.score(eb);

    const contradictions = [];
    if (!ancestor) contradictions.push({ type: 'NO_COMMON_ANCESTOR', severity: 'critical' });
    if (ea.head.worldSha256 === eb.head.worldSha256 && ea.head.id !== eb.head.id) contradictions.push({ type: 'SAME_WORLD_DIFFERENT_HISTORY', severity: 'info' });
    if (ea.crypto.valid && eb.crypto.valid && ea.crypto.worldRoot && eb.crypto.worldRoot && ea.crypto.worldRoot !== eb.crypto.worldRoot) contradictions.push({ type: 'VALID_CRYPTO_ROOTS_DISAGREE', severity: 'critical', a: ea.crypto.worldRoot, b: eb.crypto.worldRoot });

    let verdict = 'UNDECIDED';
    let preferred = null;
    const margin = Math.abs(sa.score - sb.score);
    if (!ancestor) verdict = 'DISCONNECTED_HISTORIES';
    else if (contradictions.some(x => x.severity === 'critical')) verdict = 'FORENSIC_HOLD';
    else if (ea.head.worldSha256 === eb.head.worldSha256) verdict = 'SEMANTIC_CONVERGENCE';
    else if (sa.score >= 80 && sb.score >= 80 && margin < 15) verdict = 'BOTH_DEFENSIBLE';
    else if (margin >= Number(options.preferenceMargin || 20)) {
      verdict = 'EVIDENCE_PREFERS_ONE_LINEAGE';
      preferred = sa.score > sb.score ? 'A' : 'B';
    } else verdict = 'AMBIGUOUS_DIVERGENCE';

    let mergePreview = null;
    if (ancestor && options.previewMerge === true) {
      mergePreview = await this.worldTree.mergePreview(ea.head.id, eb.head.id).catch(error => ({ status: 'ERROR', error: error.message }));
    }

    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const record = {
      format: 'JSONDB-HISTORY-COURT-1', id, at: now(),
      parties: {
        A: { input: a, head: ea.head.id, worldSha256: ea.head.worldSha256, score: sa.score, reasons: sa.reasons },
        B: { input: b, head: eb.head.id, worldSha256: eb.head.worldSha256, score: sb.score, reasons: sb.reasons }
      },
      commonAncestor: ancestor,
      contradictions,
      verdict, preferred, mergePreview,
      doctrine: 'History Court ranks evidence and preserves ambiguity. It never moves World Tree refs and never promotes a recovered world automatically.'
    };
    record.caseHash = hash(record);
    if (this.polyhash) record.polyhash = await this.polyhash.envelope(record, { purpose: 'history-court-case' });
    await atomicJson(path.join(this.cases, `${id}.json`), record);
    await atomicJson(path.join(this.root, 'latest.json'), record);
    return record;
  }

  async verify(id = null) {
    await this.init();
    const record = id ? await readJson(path.join(this.cases, `${id}.json`), null) : await readJson(path.join(this.root, 'latest.json'), null);
    if (!record) return { valid: false, status: 'ABSENT' };
    const copy = { ...record }; delete copy.caseHash; delete copy.polyhash;
    const computed = hash(copy);
    let polyhash = null;
    if (this.polyhash && record.polyhash) polyhash = await this.polyhash.verify({ ...copy, caseHash: record.caseHash }, record.polyhash);
    return { valid: computed === record.caseHash && (!polyhash || polyhash.valid), id: record.id, expected: record.caseHash, computed, verdict: record.verdict, polyhash };
  }
}

module.exports = { HistoryCourt };
