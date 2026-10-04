'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { readText, readJsonl } = require('./jsonfs');

function canonical(value) {
  if (Array.isArray(value)) {
    if (value.every(x => x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string')) {
      return [...value].sort((a, b) => a.id.localeCompare(b.id)).map(canonical);
    }
    return value.map(canonical);
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  if (Number.isNaN(value)) return '__NaN__';
  if (value === Infinity) return '__Infinity__';
  if (value === -Infinity) return '__-Infinity__';
  return value;
}
function hashText(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function semanticHash(value) { return hashText(JSON.stringify(canonical(value))); }

async function semanticHashFile(file) {
  const text = await readText(file, '');
  if (!text) return null;
  if (file.endsWith('.jsonl')) {
    const rows = await readJsonl(file);
    if (rows.some(x => x.__corrupt)) return null;
    return semanticHash(rows);
  }
  try { return semanticHash(JSON.parse(text)); }
  catch { return null; }
}

class TruthLattice {
  constructor(savior, guardian, orthogonal = null) {
    this.savior = savior;
    this.guardian = guardian;
    this.orthogonal = orthogonal;
  }

  async cellEvidence(relativePath) {
    const cells = await this.guardian.currentCellStates(relativePath);
    const evidence = [];
    for (const cell of cells) {
      let semantic = null;
      try { semantic = await semanticHashFile(cell.file); } catch {}
      evidence.push({ ...cell, semanticHash: semantic });
    }
    return evidence;
  }

  votes(rows, field) {
    const map = new Map();
    for (const row of rows) {
      const value = row[field];
      if (!value) continue;
      map.set(value, (map.get(value) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  }

  async verdict(relativePath, options = {}) {
    const current = await this.cellEvidence(relativePath);
    const physicalVotes = this.votes(current, 'sha256');
    const semanticVotes = this.votes(current, 'semanticHash');
    const quorum = Math.floor(current.length / 2) + 1;
    const temporal = await this.guardian.temporalVerdict(relativePath, options.temporal || {});
    const physicalWinner = physicalVotes[0] || null;
    const semanticWinner = semanticVotes[0] || null;

    let score = 0;
    const evidence = [];
    if (physicalWinner?.count >= quorum) { score += 40; evidence.push({ channel: 'physical-present-quorum', score: 40, value: physicalWinner.value, votes: physicalWinner.count }); }
    else evidence.push({ channel: 'physical-present-quorum', score: 0, votes: physicalWinner?.count || 0 });

    if (semanticWinner?.count >= quorum) { score += 25; evidence.push({ channel: 'semantic-present-quorum', score: 25, value: semanticWinner.value, votes: semanticWinner.count }); }
    else evidence.push({ channel: 'semantic-present-quorum', score: 0, votes: semanticWinner?.count || 0 });

    if (temporal.winner) {
      const points = temporal.method === 'present-quorum' ? 20 : 16;
      score += points;
      evidence.push({ channel: 'temporal-lineage', score: points, method: temporal.method, value: temporal.winner, votes: temporal.presentVotes || 0 });
    } else evidence.push({ channel: 'temporal-lineage', score: -15, method: temporal.method });

    const physicallySplitButSemanticallySame = Boolean(semanticWinner?.count >= quorum && (!physicalWinner || physicalWinner.count < semanticWinner.count));
    if (physicallySplitButSemanticallySame) {
      score += 8;
      evidence.push({ channel: 'semantic-equivalence', score: 8, note: 'byte representations diverge but canonical JSON semantics converge' });
    }

    const unparsable = current.filter(x => x.sha256 && !x.semanticHash).length;
    if (unparsable) { score -= Math.min(30, unparsable * 10); evidence.push({ channel: 'parse-corruption', score: -Math.min(30, unparsable * 10), count: unparsable }); }

    let status = 'UNKNOWN';
    if (score >= 80) status = 'TRUSTED';
    else if (score >= 55) status = 'DEGRADED';
    else if (score >= 30) status = 'FROZEN';
    else status = 'UNKNOWN';

    return {
      relativePath, status, confidence: Math.max(0, Math.min(100, score)), quorum,
      physicalWinner, semanticWinner, physicallySplitButSemanticallySame,
      temporal: { method: temporal.method, winner: temporal.winner, presentVotes: temporal.presentVotes || 0 },
      evidence, cells: current
    };
  }

  async worldVerdict() {
    const latest = await require('./jsonfs').readJson(path.join(this.savior.mirrors.cellsRoot, 'latest-capture.json'), null);
    if (!latest) return { status: 'UNKNOWN', confidence: 0, reason: 'No mirror capture.' };
    const files = [];
    for (const spec of latest.files) files.push(await this.verdict(spec.relative));
    const min = files.length ? Math.min(...files.map(x => x.confidence)) : 0;
    const avg = files.length ? files.reduce((a, b) => a + b.confidence, 0) / files.length : 0;
    const unknown = files.filter(x => x.status === 'UNKNOWN').length;
    const frozen = files.filter(x => x.status === 'FROZEN').length;
    const degraded = files.filter(x => x.status === 'DEGRADED').length;
    let status = 'TRUSTED';
    if (unknown) status = 'UNKNOWN';
    else if (frozen) status = 'FROZEN';
    else if (degraded) status = 'DEGRADED';
    return { status, confidence: Math.round((min * 0.65) + (avg * 0.35)), minimumFileConfidence: min, averageFileConfidence: Math.round(avg), files };
  }
}

module.exports = { TruthLattice, canonical, semanticHash, semanticHashFile };
