'use strict';

function splitComma(text) {
  const out = []; let current = ''; let depth = 0; let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function scalar(raw) {
  const v = raw.trim();
  if (/^null$/i.test(v)) return null;
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  const quoted = v.match(/^(['"])([\s\S]*)\1$/);
  if (quoted) return quoted[2].replace(/\\(['"\\])/g, '$1');
  return v;
}

function parseCondition(text) {
  const orParts = text.split(/\s+OR\s+/i);
  if (orParts.length > 1) return { or: orParts.map(parseCondition) };
  const andParts = text.split(/\s+AND\s+/i);
  if (andParts.length > 1) return { and: andParts.map(parseCondition) };
  const t = text.trim().replace(/^\((.*)\)$/s, '$1').trim();
  let m = t.match(/^([A-Za-z_][\w.]*)\s+IS\s+(NOT\s+)?NULL$/i);
  if (m) return { field: m[1], op: m[2] ? 'ne' : 'eq', value: null };
  m = t.match(/^([A-Za-z_][\w.]*)\s+(CONTAINS|STARTS\s+WITH|ENDS\s+WITH)\s+(.+)$/i);
  if (m) {
    const op = m[2].replace(/\s+/g, '').toLowerCase();
    return { field: m[1], op: op === 'startswith' ? 'startsWith' : op === 'endswith' ? 'endsWith' : 'contains', value: scalar(m[3]) };
  }
  m = t.match(/^([A-Za-z_][\w.]*)\s*(=|!=|<>|>=|<=|>|<)\s*(.+)$/);
  if (!m) throw Object.assign(new Error(`Cannot parse WHERE condition: ${text}`), { status: 400 });
  const map = { '=': 'eq', '!=': 'ne', '<>': 'ne', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' };
  return { field: m[1], op: map[m[2]], value: scalar(m[3]) };
}

function parseSelectList(text) {
  const select = [];
  const aggregates = {};
  for (const item of splitComma(text)) {
    if (item === '*') { select.push('*'); continue; }
    const agg = item.match(/^(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(\*|[A-Za-z_][\w.]*)\s*\)(?:\s+AS\s+([A-Za-z_][\w]*))?$/i);
    if (agg) {
      const op = agg[1].toLowerCase();
      const field = agg[2] === '*' ? undefined : agg[2];
      const alias = agg[3] || `${op}_${field || 'all'}`;
      aggregates[alias] = { op, field };
      continue;
    }
    const field = item.match(/^([A-Za-z_][\w.]*)(?:\s+AS\s+([A-Za-z_][\w]*))?$/i);
    if (!field) throw Object.assign(new Error(`Cannot parse select expression: ${item}`), { status: 400 });
    select.push(field[1]);
  }
  return { select, aggregates };
}

function compileSQL(sql) {
  sql = String(sql || '').trim().replace(/;\s*$/, '');
  const explain = /^EXPLAIN(?:\s+ANALYZE)?\s+/i.test(sql);
  sql = sql.replace(/^EXPLAIN(?:\s+ANALYZE)?\s+/i, '');
  const head = sql.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+([A-Za-z_][\w-]*)(?:\s+(?:AS\s+)?([A-Za-z_][\w]*))?\s*([\s\S]*)$/i);
  if (!head) throw Object.assign(new Error('Only SELECT/EXPLAIN SELECT is supported by cursed SQL mode.'), { status: 400 });
  const { select, aggregates } = parseSelectList(head[1]);
  const query = { from: head[2], select: select.length ? select : ['*'] };
  let rest = head[4].trim();

  const joins = [];
  while (/^(?:LEFT\s+|INNER\s+)?JOIN\s+/i.test(rest)) {
    const m = rest.match(/^(?:(LEFT|INNER)\s+)?JOIN\s+([A-Za-z_][\w-]*)(?:\s+(?:AS\s+)?([A-Za-z_][\w]*))?\s+ON\s+([A-Za-z_][\w.]*)\s*=\s*([A-Za-z_][\w.]*)\s*([\s\S]*)$/i);
    if (!m) throw Object.assign(new Error(`Cannot parse JOIN near: ${rest}`), { status: 400 });
    joins.push({ collection: m[2], as: m[3] || m[2], type: (m[1] || 'inner').toLowerCase(), on: { left: m[4].replace(new RegExp(`^${head[3] || head[2]}\\.`), ''), right: m[5].replace(new RegExp(`^${m[3] || m[2]}\\.`), '') } });
    rest = m[6].trim();
    if (/^(WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|AS\s+OF)\b/i.test(rest)) break;
  }
  if (joins.length) query.joins = joins;

  const clauses = {};
  const patterns = [
    ['where', /\bWHERE\s+/i], ['groupBy', /\bGROUP\s+BY\s+/i], ['having', /\bHAVING\s+/i],
    ['orderBy', /\bORDER\s+BY\s+/i], ['limit', /\bLIMIT\s+/i], ['offset', /\bOFFSET\s+/i], ['asOf', /\bAS\s+OF(?:\s+TX)?\s+/i]
  ];
  const found = [];
  for (const [name, regex] of patterns) {
    const m = regex.exec(rest);
    if (m) found.push({ name, index: m.index, length: m[0].length });
  }
  found.sort((a, b) => a.index - b.index);
  for (let i = 0; i < found.length; i++) {
    const cur = found[i]; const next = found[i + 1];
    clauses[cur.name] = rest.slice(cur.index + cur.length, next ? next.index : rest.length).trim();
  }

  if (clauses.where) query.where = parseCondition(clauses.where);
  if (clauses.groupBy) query.groupBy = splitComma(clauses.groupBy);
  if (Object.keys(aggregates).length) query.aggregates = aggregates;
  if (clauses.having) query.having = parseCondition(clauses.having);
  if (clauses.orderBy) query.orderBy = splitComma(clauses.orderBy).map(item => {
    const m = item.match(/^([A-Za-z_][\w.]*)(?:\s+(ASC|DESC))?$/i);
    if (!m) throw Object.assign(new Error(`Cannot parse ORDER BY: ${item}`), { status: 400 });
    return { field: m[1], direction: (m[2] || 'asc').toLowerCase() };
  });
  if (clauses.limit) query.limit = Number(clauses.limit.match(/^\d+/)?.[0] || 100);
  if (clauses.offset) query.offset = Number(clauses.offset.match(/^\d+/)?.[0] || 0);
  if (clauses.asOf) query.asOf = Number(clauses.asOf.match(/^\d+/)?.[0]);
  return { sql, explain, query };
}

module.exports = { compileSQL, parseCondition, scalar };
