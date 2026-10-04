'use strict';

const crypto = require('crypto');
const { clone, now, hashValue } = require('./jsonfs');

const VOLATILE_KEYS = new Set(['createdAt', 'updatedAt']);
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter(k => !VOLATILE_KEYS.has(k)).sort().map(k => [k, stable(value[k])]));
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function deterministicUuid(seed) {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}

class QuantumInspiredLab {
  constructor(engine, savior = null) {
    this.engine = engine;
    this.savior = savior;
  }

  async snapshot(names) {
    const out = {};
    for (const name of names) out[name] = clone(await this.engine.loadCurrent(name));
    return out;
  }

  freezeOps(base, ops) {
    const baseHash = digest(base);
    return clone(ops).map((op, i) => {
      if (op.type !== 'insert') return op;
      op.row ||= {};
      op.row.id ||= deterministicUuid(`${baseHash}:${i}:${digest(op)}`);
      return op;
    });
  }

  apply(world, ops) {
    const result = clone(world);
    const effects = [];
    for (const op of ops) {
      const table = result[op.collection];
      if (!table) throw new Error(`Candidate references missing collection ${op.collection}`);
      if (op.type === 'insert') {
        const row = clone(op.row || {});
        row.id ||= deterministicUuid(`fallback:${digest({ table: op.collection, row })}`);
        row.createdAt ||= now();
        row.updatedAt = now();
        if (table.rows.some(r => r.id === row.id)) throw new Error(`Duplicate candidate id ${row.id}`);
        table.rows.push(row); effects.push({ type: 'insert', collection: op.collection, id: row.id });
      } else if (op.type === 'update') {
        const i = table.rows.findIndex(r => r.id === op.id);
        if (i < 0) throw new Error(`Candidate row not found ${op.collection}/${op.id}`);
        table.rows[i] = { ...table.rows[i], ...(clone(op.patch || {})), id: table.rows[i].id, updatedAt: now() };
        effects.push({ type: 'update', collection: op.collection, id: op.id });
      } else if (op.type === 'delete') {
        const i = table.rows.findIndex(r => r.id === op.id);
        if (i < 0) throw new Error(`Candidate row not found ${op.collection}/${op.id}`);
        table.rows.splice(i, 1); effects.push({ type: 'delete', collection: op.collection, id: op.id });
      } else throw new Error(`Unknown candidate operation ${op.type}`);
    }
    return { world: result, effects };
  }

  invariantScore(world, invariants = []) {
    let score = 0;
    const observations = [];
    for (const inv of invariants) {
      const table = world[inv.collection];
      let ok = true;
      let detail = null;
      if (!table) { ok = false; detail = 'collection missing'; }
      else if (inv.type === 'unique') {
        const seen = new Set();
        for (const row of table.rows) {
          const k = JSON.stringify(row[inv.field]);
          if (row[inv.field] != null && seen.has(k)) { ok = false; detail = `duplicate ${inv.field}=${k}`; break; }
          seen.add(k);
        }
      } else if (inv.type === 'nonnegative') {
        const bad = table.rows.find(r => typeof r[inv.field] === 'number' && r[inv.field] < 0);
        ok = !bad; detail = bad ? `${inv.field} below zero at ${bad.id}` : null;
      } else if (inv.type === 'required') {
        const bad = table.rows.find(r => r[inv.field] === undefined || r[inv.field] === null || r[inv.field] === '');
        ok = !bad; detail = bad ? `${inv.field} missing at ${bad.id}` : null;
      } else if (inv.type === 'maxRows') {
        ok = table.rows.length <= Number(inv.value); detail = ok ? null : `${table.rows.length} > ${inv.value}`;
      } else if (inv.type === 'predicate') {
        const violations = table.rows.filter(row => !this.evalPredicate(row, inv.where));
        ok = violations.length === 0; detail = ok ? null : `${violations.length} predicate violations`;
      } else {
        ok = false; detail = `unknown invariant ${inv.type}`;
      }
      const weight = Number(inv.weight ?? 10);
      score += ok ? weight : -Math.abs(weight) * 3;
      observations.push({ ...inv, ok, detail, weight });
    }
    return { score, observations };
  }

  evalPredicate(row, where) {
    if (!where) return true;
    if (where.and) return where.and.every(x => this.evalPredicate(row, x));
    if (where.or) return where.or.some(x => this.evalPredicate(row, x));
    if (where.not) return !this.evalPredicate(row, where.not);
    const v = row[where.field]; const x = where.value;
    if (where.op === 'eq') return v === x;
    if (where.op === 'ne') return v !== x;
    if (where.op === 'gt') return v > x;
    if (where.op === 'gte') return v >= x;
    if (where.op === 'lt') return v < x;
    if (where.op === 'lte') return v <= x;
    return false;
  }

  async tripleExecute(base, ops) {
    const frozenOps = this.freezeOps(base, ops);
    const executions = [];
    for (let i = 0; i < 3; i++) {
      const applied = this.apply(base, frozenOps);
      executions.push({ replica: i + 1, hash: digest(applied.world), effects: applied.effects, world: applied.world });
    }
    const hashes = executions.map(x => x.hash);
    const unanimous = new Set(hashes).size === 1;
    return { unanimous, hash: unanimous ? hashes[0] : null, executions, operations: frozenOps };
  }

  amplitude(scores) {
    const max = Math.max(...scores.map(x => x.score), 0);
    const raw = scores.map(x => Math.exp(Math.max(-50, x.score - max)));
    const sum = raw.reduce((a, b) => a + b, 0) || 1;
    return raw.map(x => x / sum);
  }

  async superpose(spec = {}) {
    const candidates = Array.isArray(spec.candidates) ? spec.candidates : [];
    if (!candidates.length) throw Object.assign(new Error('Quantum-inspired run needs candidate worlds.'), { status: 400 });
    const names = [...new Set(candidates.flatMap(c => (c.ops || []).map(o => o.collection)))];
    const base = await this.snapshot(names);
    const baseHash = digest(base);
    const worlds = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        const triple = await this.tripleExecute(base, candidate.ops || []);
        if (!triple.unanimous) {
          worlds.push({ index: i, name: candidate.name || `world-${i + 1}`, viable: false, reason: 'triple-execution divergence', executions: triple.executions.map(x => ({ replica: x.replica, hash: x.hash })) });
          continue;
        }
        const assessment = this.invariantScore(triple.executions[0].world, spec.invariants || []);
        const changePenalty = triple.operations.length * Number(spec.operationPenalty ?? 0.05);
        const score = assessment.score - changePenalty + Number(candidate.bias || 0);
        worlds.push({ index: i, name: candidate.name || `world-${i + 1}`, viable: true, score, worldHash: triple.hash, effects: triple.executions[0].effects, assessment, ops: triple.operations });
      } catch (error) {
        worlds.push({ index: i, name: candidate.name || `world-${i + 1}`, viable: false, reason: error.message });
      }
    }
    const viable = worlds.filter(w => w.viable);
    if (!viable.length) return { metaphor: 'quantum-inspired, not quantum computing', collapsed: false, baseHash, worlds, reason: 'No viable world survived.' };
    const amplitudes = this.amplitude(viable);
    viable.forEach((w, i) => { w.amplitude = amplitudes[i]; });
    viable.sort((a, b) => b.score - a.score || a.worldHash.localeCompare(b.worldHash));
    const winner = viable[0];
    return {
      metaphor: 'quantum-inspired speculative execution; amplitudes are softmax scores, not physics',
      comparison: 'volatile createdAt/updatedAt values are excluded from candidate determinism hashes; insert IDs are deterministically frozen before triple execution',
      collapsed: false, baseHash, candidateCount: candidates.length, worlds,
      winner: { index: winner.index, name: winner.name, score: winner.score, amplitude: winner.amplitude, worldHash: winner.worldHash, effects: winner.effects },
      winningOps: winner.ops
    };
  }

  async collapse(spec = {}) {
    if (this.savior) await this.savior.assertWritable();
    const rehearsal = await this.superpose(spec);
    if (!rehearsal.winner) return rehearsal;
    if (spec.dryRun !== false) return { ...rehearsal, collapsed: false, dryRun: true };
    const winner = rehearsal.winner;
    const candidate = rehearsal.worlds.find(w => w.viable && w.index === winner.index);
    const beforeMeta = await this.engine.meta();
    const committed = await this.engine.transact(candidate.ops || []);
    const afterMeta = await this.engine.meta();
    return {
      ...rehearsal, collapsed: true, dryRun: false,
      collapse: { at: now(), committed, timelineBeforeTx: beforeMeta.nextTx, timelineAfterTx: afterMeta.nextTx, collapseHash: hashValue({ baseHash: rehearsal.baseHash, winner: winner.worldHash, committed }) }
    };
  }
}

module.exports = { QuantumInspiredLab, digest, stable, deterministicUuid };
