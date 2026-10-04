'use strict';

const path = require('path');
const { now, uuid, ensureDir, readJson, atomicJson } = require('./jsonfs');

function get(obj, field) {
  return String(field || '').split('.').reduce((v, part) => v == null ? undefined : v[part], obj);
}
function numeric(rows, field) { return rows.map(row => Number(get(row, field))).filter(Number.isFinite); }
function sum(rows, field) { return numeric(rows, field).reduce((a,b)=>a+b,0); }
function max(rows, field) { const x = numeric(rows, field); return x.length ? Math.max(...x) : null; }
function min(rows, field) { const x = numeric(rows, field); return x.length ? Math.min(...x) : null; }

class ConservationLawEngine {
  constructor(engine, savior) {
    this.engine = engine;
    this.savior = savior;
    this.root = path.join(savior.root, 'conservation-laws');
    this.registry = path.join(this.root, 'laws.json');
    this.baselines = path.join(this.root, 'baselines');
    this.reports = path.join(this.root, 'reports');
  }

  async init() {
    await ensureDir(this.baselines);
    await ensureDir(this.reports);
    if (!(await readJson(this.registry, null))) await atomicJson(this.registry, { format: 'JSONDB-CONSERVATION-LAWS-1', createdAt: now(), laws: [] });
  }

  normalize(spec) {
    const law = {
      id: spec.id || `law-${uuid().slice(0,8)}`,
      type: String(spec.type || ''),
      label: spec.label || spec.id || spec.type,
      severity: String(spec.severity || 'critical').toLowerCase(),
      config: spec.config || {},
      createdAt: spec.createdAt || now(),
      enabled: spec.enabled !== false,
      doctrine: spec.doctrine || null
    };
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(law.id)) throw new Error('Invalid conservation law id.');
    const allowed = ['sum-constant','balance-equality','count-range','monotonic-max','monotonic-min','sequence-contiguous','ratio-range','nonempty-field'];
    if (!allowed.includes(law.type)) throw new Error(`Unsupported conservation law: ${law.type}`);
    return law;
  }

  async register(spec) {
    await this.init();
    const registry = await readJson(this.registry, { laws: [] });
    const law = this.normalize(spec);
    const i = registry.laws.findIndex(x => x.id === law.id);
    if (i >= 0) registry.laws[i] = law; else registry.laws.push(law);
    registry.updatedAt = now();
    await atomicJson(this.registry, registry);
    return law;
  }

  async rows(collection) { return (await this.engine.loadCurrent(collection)).rows || []; }

  async observe(law) {
    const c = law.config || {};
    if (law.type === 'sum-constant') {
      const rows = await this.rows(c.collection);
      return { value: sum(rows, c.field), collection: c.collection, field: c.field };
    }
    if (law.type === 'balance-equality') {
      const left = sum(await this.rows(c.left.collection), c.left.field);
      const right = sum(await this.rows(c.right.collection), c.right.field);
      return { left, right, delta: left - right };
    }
    if (law.type === 'count-range') {
      const count = (await this.rows(c.collection)).length;
      return { count, min: c.min ?? null, max: c.max ?? null };
    }
    if (law.type === 'monotonic-max') {
      const value = max(await this.rows(c.collection), c.field);
      return { value, collection: c.collection, field: c.field };
    }
    if (law.type === 'monotonic-min') {
      const value = min(await this.rows(c.collection), c.field);
      return { value, collection: c.collection, field: c.field };
    }
    if (law.type === 'sequence-contiguous') {
      const values = numeric(await this.rows(c.collection), c.field).sort((a,b)=>a-b);
      let gaps = 0;
      for (let i = 1; i < values.length; i++) if (values[i] !== values[i-1] + Number(c.step || 1)) gaps++;
      return { values: values.length, first: values[0] ?? null, last: values.at(-1) ?? null, gaps, step: Number(c.step || 1) };
    }
    if (law.type === 'ratio-range') {
      const numerator = sum(await this.rows(c.numerator.collection), c.numerator.field);
      const denominator = sum(await this.rows(c.denominator.collection), c.denominator.field);
      const ratio = denominator === 0 ? null : numerator / denominator;
      return { numerator, denominator, ratio, min: c.min ?? null, max: c.max ?? null };
    }
    if (law.type === 'nonempty-field') {
      const rows = await this.rows(c.collection);
      const violations = rows.filter(row => { const v = get(row,c.field); return v === undefined || v === null || v === ''; }).map(row=>row.id);
      return { rows: rows.length, violations: violations.length, violationIds: violations.slice(0,100) };
    }
    throw new Error(`Unknown law type ${law.type}`);
  }

  async learn(lawId, label = 'trusted-baseline') {
    await this.init();
    const registry = await readJson(this.registry, { laws: [] });
    const law = registry.laws.find(x => x.id === lawId);
    if (!law) throw new Error(`Conservation law not found: ${lawId}`);
    const observation = await this.observe(law);
    const baseline = {
      format: 'JSONDB-CONSERVATION-BASELINE-1', lawId, lawType: law.type,
      label, learnedAt: now(), observation,
      warning: 'Learning a bad baseline makes bad reality look normal. Baselines require explicit operator intent.'
    };
    await atomicJson(path.join(this.baselines, `${lawId}.json`), baseline);
    return baseline;
  }

  async evaluate(law, baseline = null) {
    const current = await this.observe(law);
    const c = law.config || {};
    let ok = true;
    let reason = null;
    if (law.type === 'sum-constant') {
      const expected = c.expected ?? baseline?.observation?.value;
      const tolerance = Number(c.tolerance || 0);
      ok = Number.isFinite(Number(expected)) && Math.abs(current.value - Number(expected)) <= tolerance;
      reason = ok ? null : `sum ${current.value} differs from expected ${expected} by more than ${tolerance}`;
    } else if (law.type === 'balance-equality') {
      const tolerance = Number(c.tolerance || 0);
      ok = Math.abs(current.delta) <= tolerance;
      reason = ok ? null : `balance delta ${current.delta} exceeds ${tolerance}`;
    } else if (law.type === 'count-range') {
      ok = (c.min == null || current.count >= Number(c.min)) && (c.max == null || current.count <= Number(c.max));
      reason = ok ? null : `count ${current.count} outside [${c.min ?? '-∞'}, ${c.max ?? '∞'}]`;
    } else if (law.type === 'monotonic-max') {
      const previous = baseline?.observation?.value;
      ok = previous == null || current.value == null || current.value >= previous;
      reason = ok ? null : `max decreased from ${previous} to ${current.value}`;
    } else if (law.type === 'monotonic-min') {
      const previous = baseline?.observation?.value;
      ok = previous == null || current.value == null || current.value <= previous;
      reason = ok ? null : `min increased from ${previous} to ${current.value}`;
    } else if (law.type === 'sequence-contiguous') {
      ok = current.gaps === 0;
      reason = ok ? null : `${current.gaps} sequence gaps found`;
    } else if (law.type === 'ratio-range') {
      ok = current.ratio != null && (c.min == null || current.ratio >= Number(c.min)) && (c.max == null || current.ratio <= Number(c.max));
      reason = ok ? null : `ratio ${current.ratio} outside [${c.min ?? '-∞'}, ${c.max ?? '∞'}]`;
    } else if (law.type === 'nonempty-field') {
      ok = current.violations === 0;
      reason = ok ? null : `${current.violations} rows have empty ${c.field}`;
    }
    return { lawId: law.id, type: law.type, label: law.label, severity: law.severity, ok, reason, current, baseline: baseline?.observation || null };
  }

  async scan(options = {}) {
    await this.init();
    const registry = await readJson(this.registry, { laws: [] });
    const results = [];
    for (const law of registry.laws.filter(x=>x.enabled !== false)) {
      const baseline = await readJson(path.join(this.baselines, `${law.id}.json`), null);
      try { results.push(await this.evaluate(law, baseline)); }
      catch (error) { results.push({ lawId: law.id, type: law.type, severity: law.severity, ok: false, reason: `evaluation error: ${error.message}` }); }
    }
    const violations = results.filter(x=>!x.ok);
    const critical = violations.filter(x=>x.severity === 'critical');
    const status = critical.length ? 'VIOLATION' : violations.length ? 'WARNING' : 'HEALTHY';
    const report = { format: 'JSONDB-CONSERVATION-SCAN-1', at: now(), status, laws: results.length, violations: violations.length, criticalViolations: critical.length, results };
    await atomicJson(path.join(this.reports, `${Date.now()}.json`), report);
    await atomicJson(path.join(this.root, 'latest.json'), report);
    if (critical.length && options.freezeOnViolation !== false) await this.savior.setMode('read-only', `Conservation Laws detected ${critical.length} critical logical violation(s).`);
    return report;
  }

  async advanceBaselines(label = 'operator-trusted-advance') {
    const registry = await readJson(this.registry, { laws: [] });
    const advanced = [];
    for (const law of registry.laws.filter(x=>['monotonic-max','monotonic-min'].includes(x.type))) advanced.push(await this.learn(law.id, label));
    return { at: now(), label, advanced };
  }
}

module.exports = { ConservationLawEngine, get, sum, numeric };
