'use strict';

function get(obj, field) {
  if (!field) return undefined;
  return String(field).split('.').reduce((v, part) => v == null ? undefined : v[part], obj);
}

function cmp(left, op, right) {
  if (op === 'eq') return left === right;
  if (op === 'ne') return left !== right;
  if (op === 'gt') return left > right;
  if (op === 'gte') return left >= right;
  if (op === 'lt') return left < right;
  if (op === 'lte') return left <= right;
  if (op === 'in') return Array.isArray(right) && right.includes(left);
  if (op === 'nin') return Array.isArray(right) && !right.includes(left);
  if (op === 'contains') return String(left ?? '').toLowerCase().includes(String(right ?? '').toLowerCase());
  if (op === 'startsWith') return String(left ?? '').toLowerCase().startsWith(String(right ?? '').toLowerCase());
  if (op === 'endsWith') return String(left ?? '').toLowerCase().endsWith(String(right ?? '').toLowerCase());
  if (op === 'exists') return right ? left !== undefined : left === undefined;
  if (op === 'regex') {
    try { return new RegExp(String(right), 'i').test(String(left ?? '')); } catch { return false; }
  }
  throw Object.assign(new Error(`Unsupported operator: ${op}`), { status: 400 });
}

function evaluate(node, row) {
  if (!node) return true;
  if (Array.isArray(node)) return node.every(item => evaluate(item, row));
  if (node.and) return node.and.every(item => evaluate(item, row));
  if (node.or) return node.or.some(item => evaluate(item, row));
  if (node.not) return !evaluate(node.not, row);
  if (node.field) return cmp(get(row, node.field), node.op || 'eq', node.value);
  throw Object.assign(new Error('Invalid where AST.'), { status: 400 });
}

function flattenAnd(node, out = []) {
  if (!node) return out;
  if (node.and) for (const child of node.and) flattenAnd(child, out);
  else out.push(node);
  return out;
}

function key(v) { return `${typeof v}:${JSON.stringify(v)}`; }

function choosePlan({ query, indexes, rowCount }) {
  const predicates = flattenAnd(query.where);
  const candidates = [];
  for (const predicate of predicates) {
    if (!predicate?.field || (predicate.op || 'eq') !== 'eq') continue;
    for (const [indexName, index] of Object.entries(indexes || {})) {
      if (index.fields?.length !== 1 || index.fields[0] !== predicate.field) continue;
      const ids = index.map?.[key(predicate.value)] || [];
      candidates.push({ type: 'index-scan', index: indexName, field: predicate.field, value: predicate.value, ids, cost: Math.max(1, ids.length) });
    }
  }
  if (!candidates.length) return { type: 'full-scan', cost: rowCount, reason: 'No usable equality index.' };
  candidates.sort((a, b) => a.cost - b.cost);
  return { ...candidates[0], reason: `Selected cheapest equality index from ${candidates.length} candidate(s).` };
}

function applyProjection(rows, select) {
  if (!Array.isArray(select) || !select.length || select.includes('*')) return rows;
  return rows.map(row => {
    const out = {};
    for (const field of select) out[field] = get(row, field);
    return out;
  });
}

function applyOrder(rows, orderBy = []) {
  if (!Array.isArray(orderBy) || !orderBy.length) return rows;
  return [...rows].sort((a, b) => {
    for (const spec of orderBy) {
      const field = typeof spec === 'string' ? spec.replace(/^-/, '') : spec.field;
      const dir = typeof spec === 'string' && spec.startsWith('-') ? -1 : (String(spec.direction || 'asc').toLowerCase() === 'desc' ? -1 : 1);
      const av = get(a, field); const bv = get(b, field);
      if (av === bv) continue;
      return (av > bv ? 1 : -1) * dir;
    }
    return 0;
  });
}

function aggregate(rows, groupBy = [], aggregates = {}) {
  if (!groupBy.length && !Object.keys(aggregates).length) return rows;
  const buckets = new Map();
  for (const row of rows) {
    const values = groupBy.map(field => get(row, field));
    const bucketKey = JSON.stringify(values);
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, { rows: [], values });
    buckets.get(bucketKey).rows.push(row);
  }
  if (!groupBy.length) buckets.set('[]', { rows, values: [] });
  const output = [];
  for (const bucket of buckets.values()) {
    const out = {};
    groupBy.forEach((field, i) => out[field] = bucket.values[i]);
    for (const [alias, spec] of Object.entries(aggregates)) {
      const op = spec.op || 'count';
      const vals = spec.field ? bucket.rows.map(row => get(row, spec.field)).filter(v => v != null) : [];
      if (op === 'count') out[alias] = spec.field ? vals.length : bucket.rows.length;
      else if (op === 'sum') out[alias] = vals.reduce((a, b) => a + Number(b || 0), 0);
      else if (op === 'avg') out[alias] = vals.length ? vals.reduce((a, b) => a + Number(b || 0), 0) / vals.length : null;
      else if (op === 'min') out[alias] = vals.length ? vals.reduce((a, b) => a < b ? a : b) : null;
      else if (op === 'max') out[alias] = vals.length ? vals.reduce((a, b) => a > b ? a : b) : null;
      else throw Object.assign(new Error(`Unsupported aggregate: ${op}`), { status: 400 });
    }
    output.push(out);
  }
  return output;
}

function hashJoin(leftRows, rightRows, spec) {
  const leftField = spec.on?.left;
  const rightField = spec.on?.right;
  if (!leftField || !rightField) throw Object.assign(new Error('Join needs on.left and on.right.'), { status: 400 });
  const type = spec.type || 'inner';
  const alias = spec.as || spec.collection;
  const buckets = new Map();
  for (const row of rightRows) {
    const k = key(get(row, rightField));
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(row);
  }
  const out = [];
  for (const left of leftRows) {
    const matches = buckets.get(key(get(left, leftField))) || [];
    if (!matches.length && type === 'left') out.push({ ...left, [alias]: null });
    for (const right of matches) out.push({ ...left, [alias]: right });
  }
  return { rows: out, algorithm: 'hash-join', buckets: buckets.size };
}

async function executeQuery({ query, readCollection, readIndexes }) {
  if (!query?.from) throw Object.assign(new Error('Query needs from.'), { status: 400 });
  const started = process.hrtime.bigint();
  const base = await readCollection(query.from, query.asOf);
  const indexes = await readIndexes(query.from);
  const plan = choosePlan({ query, indexes, rowCount: base.length });
  let rows;
  let examined;
  if (plan.type === 'index-scan') {
    const wanted = new Set(plan.ids);
    rows = base.filter(row => wanted.has(row.id));
    examined = plan.ids.length;
  } else {
    rows = base;
    examined = base.length;
  }
  rows = rows.filter(row => evaluate(query.where, row));

  const joins = [];
  for (const joinSpec of query.joins || []) {
    const right = await readCollection(joinSpec.collection, query.asOf);
    const joined = hashJoin(rows, right, joinSpec);
    rows = joined.rows;
    joins.push({ collection: joinSpec.collection, algorithm: joined.algorithm, buckets: joined.buckets, rightRows: right.length });
  }

  rows = aggregate(rows, query.groupBy || [], query.aggregates || {});
  if (query.having) rows = rows.filter(row => evaluate(query.having, row));
  rows = applyOrder(rows, query.orderBy || []);
  const total = rows.length;
  const offset = Math.max(0, Number(query.offset || 0));
  const limit = Math.min(5000, Math.max(1, Number(query.limit || 100)));
  rows = rows.slice(offset, offset + limit);
  rows = applyProjection(rows, query.select || ['*']);
  const durationNs = Number(process.hrtime.bigint() - started);
  return {
    rows,
    total,
    offset,
    limit,
    explain: {
      from: query.from,
      access: plan,
      examined,
      joins,
      filtered: total,
      durationMs: durationNs / 1e6,
      asOf: query.asOf ?? 'latest'
    }
  };
}

module.exports = { get, evaluate, choosePlan, executeQuery, hashJoin, key };
