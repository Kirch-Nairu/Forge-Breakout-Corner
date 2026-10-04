'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');
const { canonical } = require('./truth');

const ABSENT_ROW = '__JSONDB_ABSENT_ROW__';
const ABSENT_FIELD = '__JSONDB_ABSENT_FIELD__';
function key(value) { return value === ABSENT_ROW || value === ABSENT_FIELD ? value : JSON.stringify(canonical(value)); }
function hash(value) { return crypto.createHash('sha256').update(key(value)).digest('hex'); }
function majority(values, quorum) {
  const counts = new Map();
  for (const value of values) {
    const k = key(value);
    const slot = counts.get(k) || { key: k, count: 0, value };
    slot.count++;
    counts.set(k, slot);
  }
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const winner = ranked[0] || null;
  return { winner: winner && winner.count >= quorum ? winner : null, ranked };
}

class FractalQuorum {
  constructor(savior) {
    this.savior = savior;
    this.root = path.join(savior.root, 'fractal-recovery');
  }
  async init() { await ensureDir(this.root); }

  async loadCopies(relativePath) {
    await this.savior.mirrors.init();
    const copies = [];
    for (const cell of this.savior.mirrors.cells()) {
      const file = path.join(this.savior.mirrors.cellsRoot, cell, relativePath);
      try {
        const table = await readJson(file, null);
        if (!table?.name || !Array.isArray(table.rows)) throw new Error('not a table-shaped JSON document');
        copies.push({ cell, file, valid: true, table });
      } catch (error) {
        copies.push({ cell, file, valid: false, error: error.message, table: null });
      }
    }
    return copies;
  }

  rowMap(table) { return new Map((table?.rows || []).filter(r => r && typeof r.id === 'string').map(r => [r.id, r])); }

  async reconstruct(relativePath) {
    await this.init();
    const copies = await this.loadCopies(relativePath);
    const valid = copies.filter(x => x.valid);
    const totalCells = copies.length;
    const quorum = Math.floor(totalCells / 2) + 1;
    if (valid.length < quorum) return { status: 'UNRECOVERABLE', relativePath, reason: `Only ${valid.length}/${totalCells} mirror files parse as tables; quorum is ${quorum}.`, copies };

    const names = majority(valid.map(x => x.table.name), quorum);
    if (!names.winner) return { status: 'UNRECOVERABLE', relativePath, reason: 'Table name has no quorum.', copies };
    const tableName = names.winner.value;
    const maps = valid.map(x => ({ cell: x.cell, rows: this.rowMap(x.table), table: x.table }));
    const ids = new Set();
    for (const m of maps) for (const id of m.rows.keys()) ids.add(id);

    const recovered = [];
    const provenance = [];
    const unresolved = [];

    for (const id of [...ids].sort()) {
      const rowVotes = maps.map(m => m.rows.has(id) ? m.rows.get(id) : ABSENT_ROW);
      const rowMajority = majority(rowVotes, quorum);
      if (rowMajority.winner) {
        if (rowMajority.winner.value !== ABSENT_ROW) {
          recovered.push(rowMajority.winner.value);
          provenance.push({ id, level: 'row', votes: rowMajority.winner.count, rowHash: hash(rowMajority.winner.value) });
        } else provenance.push({ id, level: 'row-tombstone', votes: rowMajority.winner.count });
        continue;
      }

      const present = maps.filter(m => m.rows.has(id));
      if (present.length < quorum) {
        unresolved.push({ id, reason: `row existence has only ${present.length} positive copies and no tombstone quorum`, rowVoteSummary: rowMajority.ranked.map(x => ({ count: x.count, hash: hash(x.value) })) });
        continue;
      }
      const fields = new Set(['id']);
      for (const p of present) for (const f of Object.keys(p.rows.get(id))) fields.add(f);
      const row = {};
      const fieldEvidence = [];
      let failed = false;
      for (const field of [...fields].sort()) {
        const votes = present.map(p => Object.prototype.hasOwnProperty.call(p.rows.get(id), field) ? p.rows.get(id)[field] : ABSENT_FIELD);
        const m = majority(votes, quorum);
        if (!m.winner) {
          failed = true;
          fieldEvidence.push({ field, resolved: false, candidates: m.ranked.map(x => ({ count: x.count, valueHash: hash(x.value) })) });
          continue;
        }
        fieldEvidence.push({ field, resolved: true, votes: m.winner.count, valueHash: hash(m.winner.value) });
        if (m.winner.value !== ABSENT_FIELD) row[field] = m.winner.value;
      }
      if (failed || row.id !== id) unresolved.push({ id, reason: failed ? 'one or more fields lack quorum' : 'reconstructed id does not match row identity', fieldEvidence });
      else {
        recovered.push(row);
        provenance.push({ id, level: 'field', votesRequired: quorum, rowHash: hash(row), fieldEvidence });
      }
    }

    recovered.sort((a, b) => a.id.localeCompare(b.id));
    const sourceMetas = valid.map(x => x.table.meta || {});
    const result = {
      name: tableName,
      meta: {
        reconstructedAt: now(), source: 'fractal-quorum',
        sourceCopies: valid.length, quorum, count: recovered.length,
        priorVersions: sourceMetas.map(x => x.version).filter(x => x != null)
      },
      rows: recovered
    };
    const status = unresolved.length ? 'PARTIAL' : 'RECOVERED';
    const id = `${Date.now()}-${tableName}`;
    const sandbox = path.join(this.root, `${id}.json`);
    await atomicJson(sandbox, result);
    await atomicJson(path.join(this.root, `${id}.evidence.json`), {
      format: 'JSONDB-FRACTAL-QUORUM-EVIDENCE-1', at: now(), relativePath,
      status, quorum, totalCells, validCopies: valid.map(x => x.cell), invalidCopies: copies.filter(x => !x.valid).map(x => ({ cell: x.cell, error: x.error })),
      recoveredRows: recovered.length, unresolved, provenance
    });
    return { status, relativePath, sandbox, table: result, unresolved, provenance, quorum, validCopies: valid.length };
  }
}

module.exports = { FractalQuorum, majority, ABSENT_ROW, ABSENT_FIELD };
