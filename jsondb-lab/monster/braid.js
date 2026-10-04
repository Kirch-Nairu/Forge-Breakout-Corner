'use strict';

const path = require('path');
const crypto = require('crypto');
const fsp = require('fs/promises');
const { now, ensureDir, readJson, readJsonl, atomicJson, appendJsonl } = require('./jsonfs');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

class CrossHistoryBraid {
  constructor({ savior, guardian, chronicle, council, truth, immune, orthogonal, trinity = null }) {
    this.savior = savior;
    this.guardian = guardian;
    this.chronicle = chronicle;
    this.council = council;
    this.truth = truth;
    this.immune = immune;
    this.orthogonal = orthogonal;
    this.trinity = trinity;
    this.root = path.join(savior.root, 'cross-history-braid');
    this.chain = path.join(this.root, 'epochs.jsonl');
    this.head = path.join(this.root, 'head.json');
    this.anchors = path.join(this.root, 'anchors');
  }

  async init() {
    await ensureDir(this.root);
    await ensureDir(this.anchors);
    return this.verify();
  }

  async channelHeads(options = {}) {
    const temporal = await readJson(this.guardian.latest, null);
    const chronicleHead = await readJson(this.chronicle.headFile, null);
    const signedRound = await readJson(path.join(this.council.root, 'latest-round.json'), null);
    const orthogonal = await readJson(path.join(this.orthogonal.root, 'latest.json'), null);
    const trinity = this.trinity ? await readJson(path.join(this.trinity.root, 'latest.json'), null) : null;
    const immuneProfile = this.immune ? await readJson(this.immune.latest, null) : null;
    const truth = await this.truth.worldVerdict().catch(error => ({ status: 'ERROR', confidence: 0, error: error.message }));
    const chronicleVerify = options.verifyChronicle === false ? null : await this.chronicle.verify().catch(error => ({ valid: false, error: error.message }));
    const signedVerify = await this.council.verifyRound().catch(error => ({ valid: false, error: error.message }));
    return {
      temporal: temporal ? {
        epoch: temporal.epoch, worldRoot: temporal.worldRoot, roundHash: temporal.roundHash,
        previousRoundHash: temporal.previousRoundHash || null
      } : null,
      chronicle: chronicleHead ? {
        sequence: chronicleHead.sequence, entryHash: chronicleHead.entryHash,
        worldRoot: chronicleHead.worldRoot, tx: chronicleHead.tx ?? null,
        valid: chronicleVerify?.valid ?? null,
        liveMatchesReplay: chronicleVerify?.liveMatchesReplay ?? null
      } : null,
      signedCouncil: signedRound ? {
        roundId: signedRound.statement?.roundId || null,
        worldRoot: signedRound.statement?.worldRoot || null,
        councilGeneration: signedRound.statement?.councilGeneration || null,
        valid: signedVerify.valid === true,
        validSignatures: signedVerify.validSignatures || 0,
        threshold: signedVerify.threshold || null
      } : null,
      truthLattice: {
        status: truth.status, confidence: truth.confidence,
        worldFingerprint: truth.worldFingerprint || truth.semanticWorldRoot || truth.worldRoot || null
      },
      immune: immuneProfile ? {
        profileId: immuneProfile.id, learnedAt: immuneProfile.learnedAt,
        profileDigest: digest(immuneProfile)
      } : null,
      orthogonal: orthogonal ? {
        id: orthogonal.id, expectedSha256: orthogonal.expectedSha256 || orthogonal.expected || null,
        createdAt: orthogonal.createdAt
      } : null,
      trinity: trinity ? {
        id: trinity.id, expectedSha256: trinity.expectedSha256,
        createdAt: trinity.createdAt
      } : null
    };
  }

  crossContradictions(channels) {
    const roots = [];
    if (channels.temporal?.worldRoot) roots.push({ channel: 'temporal', root: channels.temporal.worldRoot });
    if (channels.chronicle?.worldRoot) roots.push({ channel: 'chronicle', root: channels.chronicle.worldRoot });
    if (channels.signedCouncil?.worldRoot) roots.push({ channel: 'signedCouncil', root: channels.signedCouncil.worldRoot });
    const groups = new Map();
    for (const r of roots) {
      const slot = groups.get(r.root) || [];
      slot.push(r.channel); groups.set(r.root, slot);
    }
    const contradictions = [];
    if (groups.size > 1) contradictions.push({
      type: 'WORLD_ROOT_DIVERGENCE',
      roots: [...groups.entries()].map(([root, channels]) => ({ root, channels }))
    });
    if (channels.chronicle && channels.chronicle.valid === false) contradictions.push({ type: 'CHRONICLE_INVALID' });
    if (channels.chronicle && channels.chronicle.liveMatchesReplay === false) contradictions.push({ type: 'CHRONICLE_LIVE_REPLAY_DIVERGENCE' });
    if (channels.signedCouncil && channels.signedCouncil.valid === false) contradictions.push({ type: 'WITNESS_COUNCIL_INVALID' });
    if (['UNKNOWN','FROZEN','ERROR'].includes(channels.truthLattice?.status)) contradictions.push({ type: 'TRUTH_LATTICE_UNTRUSTED', status: channels.truthLattice?.status });
    return contradictions;
  }

  async anchorCopies(epoch) {
    const targets = [];
    const copies = [
      path.join(this.anchors, `epoch-${String(epoch.sequence).padStart(10,'0')}.json`),
      path.join(this.savior.root, 'BRAID-HEAD.json')
    ];
    await this.savior.mirrors.init();
    for (const cell of this.savior.mirrors.cells()) {
      copies.push(path.join(this.savior.mirrors.cellsRoot, cell, '_bootstrap', 'BRAID-HEAD.json'));
    }
    for (const file of copies) {
      await ensureDir(path.dirname(file));
      await atomicJson(file, epoch);
      targets.push(file);
    }
    return targets;
  }

  async weave(label = 'survival-epoch', options = {}) {
    await this.init();
    const previous = await readJson(this.head, { sequence: 0, epochHash: null });
    const channels = await this.channelHeads(options);
    const contradictions = this.crossContradictions(channels);
    const epoch = {
      format: 'JSONDB-CROSS-HISTORY-BRAID-1',
      sequence: Number(previous.sequence || 0) + 1,
      at: now(), label,
      previousEpochHash: previous.epochHash || null,
      channels,
      contradictions,
      policy: {
        automaticAuthorityEscalation: false,
        contradictionMeansWritable: false,
        purpose: 'Cross-anchor independent histories so one subsystem cannot silently rewrite its past without disagreeing with already-recorded peers.'
      }
    };
    epoch.channelRoot = digest(channels);
    epoch.epochHash = digest({
      format: epoch.format, sequence: epoch.sequence, at: epoch.at, label: epoch.label,
      previousEpochHash: epoch.previousEpochHash, channelRoot: epoch.channelRoot,
      contradictions: epoch.contradictions, policy: epoch.policy
    });
    await appendJsonl(this.chain, epoch);
    await atomicJson(this.head, epoch);
    const anchors = await this.anchorCopies(epoch);
    return { ...epoch, anchors: anchors.length };
  }

  async verify() {
    const entries = await readJsonl(this.chain);
    const failures = [];
    let previous = null;
    let expectedSequence = 1;
    for (const epoch of entries) {
      if (epoch.__corrupt) { failures.push({ sequence: expectedSequence, reason: 'corrupt JSONL epoch' }); expectedSequence++; continue; }
      if (epoch.sequence !== expectedSequence) failures.push({ sequence: epoch.sequence, reason: 'sequence discontinuity', expectedSequence });
      if ((epoch.previousEpochHash || null) !== previous) failures.push({ sequence: epoch.sequence, reason: 'previous epoch hash mismatch', expected: previous, actual: epoch.previousEpochHash || null });
      const channelRoot = digest(epoch.channels || {});
      if (channelRoot !== epoch.channelRoot) failures.push({ sequence: epoch.sequence, reason: 'channel root mismatch', expected: epoch.channelRoot, actual: channelRoot });
      const calculated = digest({
        format: epoch.format, sequence: epoch.sequence, at: epoch.at, label: epoch.label,
        previousEpochHash: epoch.previousEpochHash || null, channelRoot,
        contradictions: epoch.contradictions || [], policy: epoch.policy
      });
      if (calculated !== epoch.epochHash) failures.push({ sequence: epoch.sequence, reason: 'epoch hash mismatch', expected: epoch.epochHash, actual: calculated });
      previous = epoch.epochHash;
      expectedSequence++;
    }
    const head = await readJson(this.head, null);
    if (head && head.epochHash !== previous) failures.push({ reason: 'head disagrees with chain', expected: previous, actual: head.epochHash });
    return {
      format: 'JSONDB-CROSS-HISTORY-BRAID-VERIFY-1',
      valid: failures.length === 0,
      epochs: entries.filter(x => !x.__corrupt).length,
      headHash: previous,
      failures,
      currentContradictions: head?.contradictions || []
    };
  }

  async quorumHead() {
    await this.savior.mirrors.init();
    const copies = [];
    const files = [path.join(this.savior.root, 'BRAID-HEAD.json')];
    for (const cell of this.savior.mirrors.cells()) files.push(path.join(this.savior.mirrors.cellsRoot, cell, '_bootstrap', 'BRAID-HEAD.json'));
    for (const file of files) {
      const value = await readJson(file, null).catch(() => null);
      copies.push({ file, hash: value?.epochHash || null, value });
    }
    const counts = new Map();
    for (const copy of copies.filter(x => x.hash)) counts.set(copy.hash, (counts.get(copy.hash) || 0) + 1);
    const ranked = [...counts.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]));
    const required = Math.floor(files.length / 2) + 1;
    const winner = ranked[0] && ranked[0][1] >= required ? ranked[0] : null;
    return { required, total: files.length, winner: winner ? { epochHash: winner[0], votes: winner[1] } : null, copies };
  }
}

module.exports = { CrossHistoryBraid, canonical, digest };
