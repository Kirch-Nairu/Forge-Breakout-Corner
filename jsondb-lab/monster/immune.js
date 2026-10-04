'use strict';

const path = require('path');
const { now, ensureDir, readJson, atomicJson, listFilesRecursive } = require('./jsonfs');

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
function ratio(n, d) { return d ? n / d : 0; }

class JsonImmuneSystem {
  constructor(engine, root) {
    this.engine = engine;
    this.root = root || path.join(engine.data, 'advanced', 'immune');
    this.profiles = path.join(this.root, 'profiles');
    this.latest = path.join(this.root, 'latest-profile.json');
  }

  async init() { await ensureDir(this.profiles); }

  profileTable(table) {
    const rowCount = table.rows.length;
    const fields = {};
    for (const row of table.rows) {
      for (const [name, value] of Object.entries(row)) {
        const f = fields[name] ||= { present: 0, nulls: 0, types: {}, distinct: new Set(), numeric: [], stringLengths: [] };
        f.present++;
        const t = typeOf(value);
        f.types[t] = (f.types[t] || 0) + 1;
        if (value === null) f.nulls++;
        if (['string','number','boolean'].includes(typeof value) || value === null) f.distinct.add(JSON.stringify(value));
        if (typeof value === 'number' && Number.isFinite(value)) f.numeric.push(value);
        if (typeof value === 'string') f.stringLengths.push(value.length);
      }
    }
    const cooked = {};
    for (const [name, f] of Object.entries(fields)) {
      const nonNull = f.present - f.nulls;
      const spec = {
        presentRate: ratio(f.present, rowCount), nullRate: ratio(f.nulls, f.present),
        types: f.types, distinct: f.distinct.size,
        distinctRatio: ratio(f.distinct.size, Math.max(1, nonNull)),
        candidateUnique: nonNull > 1 && f.distinct.size === nonNull
      };
      if (f.numeric.length) {
        const sorted = [...f.numeric].sort((a,b)=>a-b);
        spec.numeric = { min: sorted[0], max: sorted.at(-1), mean: sorted.reduce((a,b)=>a+b,0)/sorted.length, p05: sorted[Math.floor((sorted.length-1)*.05)], p95: sorted[Math.floor((sorted.length-1)*.95)] };
      }
      if (f.stringLengths.length) {
        const sorted = [...f.stringLengths].sort((a,b)=>a-b);
        spec.string = { minLength: sorted[0], maxLength: sorted.at(-1), p95Length: sorted[Math.floor((sorted.length-1)*.95)] };
      }
      cooked[name] = spec;
    }
    return { rows: rowCount, fields: cooked };
  }

  async learn(label = 'trusted') {
    await this.init();
    const catalog = await this.engine.catalog();
    const collections = {};
    for (const name of Object.keys(catalog.collections || {})) collections[name] = this.profileTable(await this.engine.loadCurrent(name));
    const id = `${Date.now()}-${String(label).replace(/[^A-Za-z0-9_-]/g,'_')}`;
    const profile = { format: 'JSONDB-IMMUNE-PROFILE-1', id, label, learnedAt: now(), collections };
    await atomicJson(path.join(this.profiles, `${id}.json`), profile);
    await atomicJson(this.latest, profile);
    return profile;
  }

  async baseline(id = null) {
    await this.init();
    return id ? readJson(path.join(this.profiles, `${id}.json`), null) : readJson(this.latest, null);
  }

  compareField(name, baseline, current, rows, anomalies) {
    const score = { penalty: 0, findings: [] };
    const baselineTypes = new Set(Object.keys(baseline.types || {}));
    const currentTypes = new Set(Object.keys(current?.types || {}));
    const newTypes = [...currentTypes].filter(x => !baselineTypes.has(x));
    if (newTypes.length) { score.penalty += 20; score.findings.push(`new types: ${newTypes.join(',')}`); }
    if (!current) { score.penalty += 25; score.findings.push('field disappeared entirely'); return score; }
    if (Math.abs((current.nullRate || 0) - (baseline.nullRate || 0)) > .25) { score.penalty += 12; score.findings.push('null-rate shifted >25%'); }
    if ((baseline.presentRate || 0) > .98 && (current.presentRate || 0) < .8) { score.penalty += 15; score.findings.push('formerly required-looking field became sparse'); }
    if (baseline.candidateUnique && !current.candidateUnique) { score.penalty += 18; score.findings.push('unique-like field lost uniqueness'); }
    if (baseline.numeric) {
      for (const row of rows) {
        const value = row[name];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const span = Math.max(1, baseline.numeric.max - baseline.numeric.min);
        if (value < baseline.numeric.min - span * 2 || value > baseline.numeric.max + span * 2) anomalies.push({ rowId: row.id, field: name, reason: 'extreme numeric drift', value, learned: baseline.numeric });
      }
    }
    if (baseline.string) {
      for (const row of rows) {
        const value = row[name];
        if (typeof value === 'string' && value.length > Math.max(128, baseline.string.maxLength * 8)) anomalies.push({ rowId: row.id, field: name, reason: 'extreme string-length drift', length: value.length, learnedMax: baseline.string.maxLength });
      }
    }
    return score;
  }

  async scan(profileId = null) {
    const baseline = await this.baseline(profileId);
    if (!baseline) return { status: 'UNTRAINED', health: 0, reason: 'No immune profile. Learn only from a world you intentionally trust.' };
    const findings = [];
    const rowAnomalies = [];
    let penalty = 0;
    for (const [name, learned] of Object.entries(baseline.collections || {})) {
      let table;
      try { table = await this.engine.loadCurrent(name); }
      catch { findings.push({ collection: name, severity: 'critical', finding: 'collection disappeared' }); penalty += 40; continue; }
      const current = this.profileTable(table);
      if (learned.rows > 0 && current.rows < learned.rows * .4) { findings.push({ collection: name, severity: 'critical', finding: `row count collapsed ${learned.rows} -> ${current.rows}` }); penalty += 35; }
      if (learned.rows > 0 && current.rows > learned.rows * 10 + 100) { findings.push({ collection: name, severity: 'warning', finding: `row count exploded ${learned.rows} -> ${current.rows}` }); penalty += 12; }
      for (const [field, baselineField] of Object.entries(learned.fields || {})) {
        const compared = this.compareField(field, baselineField, current.fields[field], table.rows, rowAnomalies);
        penalty += compared.penalty;
        for (const finding of compared.findings) findings.push({ collection: name, field, severity: compared.penalty >= 20 ? 'high' : 'warning', finding });
      }
    }
    penalty += Math.min(40, rowAnomalies.length * 3);
    const health = Math.max(0, 100 - penalty);
    let status = 'HEALTHY';
    if (health < 35) status = 'HOSTILE';
    else if (health < 60) status = 'SICK';
    else if (health < 80) status = 'SUSPICIOUS';
    return { format: 'JSONDB-IMMUNE-SCAN-1', at: now(), profileId: baseline.id, status, health, penalty, findings, rowAnomalies: rowAnomalies.slice(0, 500) };
  }
}

module.exports = { JsonImmuneSystem, typeOf };
