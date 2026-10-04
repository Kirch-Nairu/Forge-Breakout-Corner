'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, exists, readJsonl, atomicJson, hashFile, merkleRoot } = require('./jsonfs');

function h(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }

class TemporalQuorumGuardian {
  constructor(savior) {
    this.savior = savior;
    this.engine = savior.engine;
    this.root = path.join(savior.root, 'temporal-quorum');
    this.chain = path.join(this.root, 'witness-chain.jsonl');
    this.latest = path.join(this.root, 'latest.json');
    this.quarantine = path.join(this.root, 'quarantine');
  }

  async init() {
    await ensureDir(this.root);
    await ensureDir(this.quarantine);
  }

  async witnessRound(label = 'guardian') {
    await this.init();
    const files = await this.savior.criticalFiles();
    const witnesses = [];
    for (const file of files) {
      if (!(await exists(file))) continue;
      witnesses.push({ path: path.relative(this.engine.data, file).split(path.sep).join('/'), sha256: await hashFile(file), bytes: (await fsp.stat(file)).size });
    }
    witnesses.sort((a, b) => a.path.localeCompare(b.path));
    const rounds = await readJsonl(this.chain);
    const prev = rounds.filter(x => !x.__corrupt).at(-1) || null;
    const body = {
      format: 'JSONDB-TEMPORAL-WITNESS-1', epoch: (prev?.epoch || 0) + 1,
      at: now(), label, prevHash: prev?.roundHash || null,
      worldRoot: merkleRoot(witnesses.map(x => x.sha256)), witnesses
    };
    body.roundHash = h({ epoch: body.epoch, at: body.at, label: body.label, prevHash: body.prevHash, worldRoot: body.worldRoot, witnesses: body.witnesses });
    await fsp.appendFile(this.chain, `${JSON.stringify(body)}\n`, 'utf8');
    await atomicJson(this.latest, body);
    return body;
  }

  async verifyChain() {
    await this.init();
    const rounds = await readJsonl(this.chain);
    const failures = [];
    let prevHash = null;
    let valid = 0;
    for (let i = 0; i < rounds.length; i++) {
      const row = rounds[i];
      if (row.__corrupt) { failures.push({ index: i, reason: 'corrupt jsonl row' }); continue; }
      const expected = h({ epoch: row.epoch, at: row.at, label: row.label, prevHash: row.prevHash, worldRoot: row.worldRoot, witnesses: row.witnesses });
      if (row.prevHash !== prevHash) failures.push({ index: i, epoch: row.epoch, reason: 'previous hash mismatch', expectedPrev: prevHash, actualPrev: row.prevHash });
      if (row.roundHash !== expected) failures.push({ index: i, epoch: row.epoch, reason: 'round hash mismatch', expected, actual: row.roundHash });
      if (row.roundHash === expected && row.prevHash === prevHash) valid++;
      prevHash = row.roundHash;
    }
    return { healthy: failures.length === 0, rounds: rounds.length, valid, failures, head: prevHash };
  }

  async historicalCandidates(relativePath, depth = 12) {
    const rounds = (await readJsonl(this.chain)).filter(x => !x.__corrupt).slice(-Math.max(1, Number(depth || 12)));
    const score = new Map();
    const evidence = [];
    for (let i = 0; i < rounds.length; i++) {
      const round = rounds[i];
      const witness = round.witnesses?.find(x => x.path === relativePath);
      if (!witness) continue;
      const recencyWeight = i + 1;
      score.set(witness.sha256, (score.get(witness.sha256) || 0) + recencyWeight);
      evidence.push({ epoch: round.epoch, at: round.at, sha256: witness.sha256, weight: recencyWeight });
    }
    return { relativePath, scores: [...score.entries()].sort((a, b) => b[1] - a[1]).map(([sha256, weight]) => ({ sha256, weight })), evidence };
  }

  async currentCellStates(relativePath) {
    await this.savior.mirrors.init();
    const states = [];
    for (const cell of this.savior.mirrors.cells()) {
      const file = path.join(this.savior.mirrors.cellsRoot, cell, relativePath);
      let sha256 = null;
      try { sha256 = await hashFile(file); } catch {}
      states.push({ cell, file, sha256 });
    }
    return states;
  }

  async temporalVerdict(relativePath, options = {}) {
    const current = await this.currentCellStates(relativePath);
    const historical = await this.historicalCandidates(relativePath, options.depth || 12);
    const counts = new Map();
    for (const state of current) if (state.sha256) counts.set(state.sha256, (counts.get(state.sha256) || 0) + 1);
    const quorum = Math.floor(current.length / 2) + 1;
    const normal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (normal && normal[1] >= quorum) return { method: 'present-quorum', winner: normal[0], presentVotes: normal[1], quorum, current, historical };

    for (const candidate of historical.scores) {
      const presentVotes = counts.get(candidate.sha256) || 0;
      const epochs = new Set(historical.evidence.filter(e => e.sha256 === candidate.sha256).map(e => e.epoch)).size;
      if (presentVotes >= Number(options.minimumSurvivors || 2) && epochs >= Number(options.minimumHistoricalEpochs || 2)) {
        return { method: 'temporal-quorum', winner: candidate.sha256, presentVotes, historicalEpochs: epochs, historicalWeight: candidate.weight, quorum, current, historical };
      }
    }
    return { method: 'no-safe-verdict', winner: null, quorum, current, historical };
  }

  async repairFromTemporalVerdict(relativePath, options = {}) {
    const verdict = await this.temporalVerdict(relativePath, options);
    if (!verdict.winner) return { repaired: false, verdict };
    const source = verdict.current.find(x => x.sha256 === verdict.winner);
    if (!source) return { repaired: false, verdict, reason: 'winning bytes are not present in any current cell' };
    const bytes = await fsp.readFile(source.file);
    const repaired = [];
    for (const state of verdict.current) {
      if (state.sha256 === verdict.winner) continue;
      if (state.sha256) {
        const q = path.join(this.quarantine, `${state.cell}-${path.basename(relativePath)}-${Date.now()}-${state.sha256.slice(0, 12)}.bin`);
        await fsp.copyFile(state.file, q).catch(() => {});
      }
      await ensureDir(path.dirname(state.file));
      await fsp.writeFile(state.file, bytes);
      repaired.push({ cell: state.cell, from: state.sha256, to: verdict.winner });
    }
    return { repaired: true, relativePath, verdict, repairedCells: repaired };
  }

  async worldVerdict() {
    const latestCapture = await require('./jsonfs').readJson(path.join(this.savior.mirrors.cellsRoot, 'latest-capture.json'), null);
    if (!latestCapture) return { healthy: false, reason: 'No mirror capture.' };
    const files = [];
    let unsafe = 0;
    let temporal = 0;
    for (const spec of latestCapture.files) {
      const verdict = await this.temporalVerdict(spec.relative);
      files.push({ path: spec.relative, method: verdict.method, winner: verdict.winner, presentVotes: verdict.presentVotes || 0 });
      if (!verdict.winner) unsafe++;
      if (verdict.method === 'temporal-quorum') temporal++;
    }
    return { healthy: unsafe === 0, unsafe, temporalRecoveriesAvailable: temporal, files };
  }
}

module.exports = { TemporalQuorumGuardian };
