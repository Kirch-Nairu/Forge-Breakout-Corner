'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

function h(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function u32(seed, counter) {
  const b = crypto.createHash('sha256').update(`${seed}:${counter}`).digest();
  return b.readUInt32BE(0);
}

class ChallengeScrubber {
  constructor({ savior, braid }) {
    this.savior = savior;
    this.braid = braid;
    this.root = path.join(savior.root, 'challenge-scrubber');
    this.rounds = path.join(this.root, 'rounds');
    this.coverageFile = path.join(this.root, 'coverage.json');
  }

  async init() { await ensureDir(this.rounds); }

  async seed(explicit = null) {
    if (explicit) return String(explicit);
    const head = await readJson(this.braid.head, null);
    if (head?.epochHash) return head.epochHash;
    const state = await this.savior.status();
    return h(JSON.stringify({ epoch: state.epoch, mode: state.mode, createdAt: state.createdAt }));
  }

  async fileSize(file) {
    try { return (await fsp.stat(file)).size; } catch { return 0; }
  }

  async response(file, challenges) {
    const size = await this.fileSize(file);
    if (!size) return { readable: false, size, responses: [], root: null };
    const handle = await fsp.open(file, 'r');
    const responses = [];
    try {
      for (const challenge of challenges) {
        const offset = Math.min(Math.max(0, challenge.offset), Math.max(0, size - 1));
        const length = Math.min(challenge.length, Math.max(1, size - offset));
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        const bytes = buffer.subarray(0, bytesRead);
        responses.push({ id: challenge.id, offset, length: bytesRead, digest: h(bytes) });
      }
    } finally { await handle.close(); }
    return { readable: true, size, responses, root: h(JSON.stringify(responses)) };
  }

  makeChallenges(seed, relative, size, count = 4, chunkBytes = 96) {
    const out = [];
    const safeSize = Math.max(1, size);
    for (let i = 0; i < count; i++) {
      const n = u32(`${seed}:${relative}`, i);
      const offset = n % safeSize;
      out.push({ id: `${relative}:${i}`, offset, length: Math.max(16, Number(chunkBytes || 96)) });
    }
    return out;
  }

  async challenge(options = {}) {
    await this.init();
    await this.savior.mirrors.init();
    const manifest = await readJson(path.join(this.savior.mirrors.cellsRoot, 'latest-capture.json'), null);
    if (!manifest) return { healthy: false, status: 'NO_MIRROR_CAPTURE', reason: 'Capture mirrors before challenge scrubbing.' };
    const seed = await this.seed(options.seed);
    const perFile = Math.max(1, Math.min(32, Number(options.perFile || 4)));
    const chunkBytes = Math.max(16, Math.min(4096, Number(options.chunkBytes || 96)));
    const files = [];
    let totalChallenges = 0;
    let disagreements = 0;
    let unreadable = 0;

    for (const spec of manifest.files || []) {
      const canonicalFile = path.join(this.savior.engine.data, spec.relative);
      const canonicalSize = await this.fileSize(canonicalFile);
      const challenges = this.makeChallenges(seed, spec.relative, Math.max(canonicalSize, spec.bytes || 1), perFile, chunkBytes);
      const canonical = await this.response(canonicalFile, challenges);
      const cells = [];
      for (const cell of this.savior.mirrors.cells()) {
        const file = path.join(this.savior.mirrors.cellsRoot, cell, spec.relative);
        const result = await this.response(file, challenges);
        const agrees = Boolean(canonical.root && result.root && canonical.root === result.root && canonical.size === result.size);
        if (!result.readable) unreadable++;
        else if (!agrees) disagreements++;
        cells.push({ cell, readable: result.readable, size: result.size, responseRoot: result.root, agreesCanonical: agrees });
      }
      totalChallenges += challenges.length * (1 + cells.length);
      files.push({
        relative: spec.relative,
        expectedCaptureSha256: spec.sha256,
        canonical: { readable: canonical.readable, size: canonical.size, responseRoot: canonical.root },
        challengeCount: challenges.length,
        challengeDescriptorHash: h(JSON.stringify(challenges)),
        cells
      });
    }

    const healthy = disagreements === 0 && unreadable === 0 && files.every(x => x.canonical.readable);
    const round = {
      format: 'JSONDB-CHALLENGE-SCRUB-1',
      id: `${Date.now()}-${seed.slice(0,12)}`,
      at: now(), seed, source: options.seed ? 'operator-seed' : 'cross-history-braid',
      perFile, chunkBytes, files: files.length, totalChallenges,
      disagreements, unreadable, healthy,
      fileResults: files,
      warning: 'Sampling is not a substitute for full verification. It increases latent-read coverage between full scrubs.'
    };
    await atomicJson(path.join(this.rounds, `${round.id}.json`), round);
    await atomicJson(path.join(this.root, 'latest.json'), round);
    await this.updateCoverage(round);
    if (!healthy && options.freezeOnFailure !== false) await this.savior.setMode('read-only', `Challenge scrub found ${disagreements} disagreements and ${unreadable} unreadable copies.`);
    return round;
  }

  async updateCoverage(round) {
    const coverage = await readJson(this.coverageFile, { format: 'JSONDB-CHALLENGE-COVERAGE-1', createdAt: now(), rounds: 0, files: {} });
    coverage.rounds++;
    coverage.updatedAt = now();
    for (const file of round.fileResults || []) {
      const row = coverage.files[file.relative] ||= { rounds: 0, challengeObservations: 0, disagreementRounds: 0, lastAt: null };
      row.rounds++;
      row.challengeObservations += Number(file.challengeCount || 0) * (1 + Number(file.cells?.length || 0));
      if (file.cells?.some(x => !x.agreesCanonical)) row.disagreementRounds++;
      row.lastAt = round.at;
    }
    await atomicJson(this.coverageFile, coverage);
    return coverage;
  }

  async coverage() {
    await this.init();
    return readJson(this.coverageFile, { format: 'JSONDB-CHALLENGE-COVERAGE-1', rounds: 0, files: {} });
  }
}

module.exports = { ChallengeScrubber, h, u32 };
