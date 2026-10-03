#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const TABLES = path.join(DATA, 'tables');
const INDEXES = path.join(DATA, 'indexes');
const SNAPSHOTS = path.join(DATA, 'snapshots');
const TX = path.join(DATA, 'tx');
const WAL = path.join(DATA, 'wal.jsonl');
const CATALOG = path.join(DATA, 'catalog.json');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 7331);
const HOST = process.env.HOST || '127.0.0.1';

let writeTail = Promise.resolve();

function now() { return new Date().toISOString(); }
function id() { return crypto.randomUUID(); }
function safeName(value) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(String(value || ''))) throw new Error('Invalid collection name.');
  return String(value);
}
function tablePath(name) { return path.join(TABLES, `${safeName(name)}.json`); }
function indexPath(name) { return path.join(INDEXES, `${safeName(name)}.json`); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function scalar(v) { return v === null || ['string', 'number', 'boolean'].includes(typeof v); }
function key(v) { return `${typeof v}:${JSON.stringify(v)}`; }

async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); }

async function atomicJson(file, value) {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await fsp.open(temp, 'w');
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temp, file);
}

async function appendWal(event) {
  await ensureDir(DATA);
  await fsp.appendFile(WAL, `${JSON.stringify({ at: now(), ...event })}\n`, 'utf8');
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

async function loadCatalog() {
  return await readJson(CATALOG, { version: 1, collections: {} });
}

async function saveCatalog(catalog) { await atomicJson(CATALOG, catalog); }

async function loadTable(name) {
  const doc = await readJson(tablePath(name), null);
  if (!doc) throw Object.assign(new Error(`Collection not found: ${name}`), { status: 404 });
  return doc;
}

function buildIndex(table) {
  const fields = {};
  for (const row of table.rows) {
    for (const [field, value] of Object.entries(row)) {
      if (!scalar(value)) continue;
      fields[field] ||= {};
      const k = key(value);
      fields[field][k] ||= [];
      fields[field][k].push(row.id);
    }
  }
  return { collection: table.name, builtAt: now(), rowCount: table.rows.length, fields };
}

async function persistTable(table) {
  table.meta.updatedAt = now();
  table.meta.count = table.rows.length;
  table.meta.version = (table.meta.version || 0) + 1;
  await atomicJson(tablePath(table.name), table);
  await atomicJson(indexPath(table.name), buildIndex(table));
}

async function validateUniques(table, uniqueFields = []) {
  for (const field of uniqueFields) {
    const seen = new Map();
    for (const row of table.rows) {
      if (row[field] === undefined || row[field] === null) continue;
      const k = key(row[field]);
      if (seen.has(k)) throw Object.assign(new Error(`Unique constraint failed: ${table.name}.${field}`), { status: 409 });
      seen.set(k, row.id);
    }
  }
}

function queueWrite(fn) {
  const run = writeTail.then(fn, fn);
  writeTail = run.catch(() => {});
  return run;
}

async function init() {
  for (const dir of [DATA, TABLES, INDEXES, SNAPSHOTS, TX, PUBLIC]) await ensureDir(dir);
  let catalog = await loadCatalog();
  if (!catalog.collections.tasks) {
    catalog.collections.tasks = { createdAt: now(), unique: ['slug'] };
    await saveCatalog(catalog);
    const table = {
      name: 'tasks',
      meta: { createdAt: now(), updatedAt: now(), count: 0, version: 0 },
      rows: [
        { id: id(), slug: 'json-db-final-boss', title: 'Keep overengineering JSON until it becomes a database', status: 'active', priority: 5, createdAt: now(), updatedAt: now() },
        { id: id(), slug: 'refuse-sqlite', title: 'Refuse to use SQLite on principle', status: 'questionable', priority: 4, createdAt: now(), updatedAt: now() }
      ]
    };
    await persistTable(table);
  }
  await recoverTransactions();
  for (const name of Object.keys(catalog.collections)) {
    const table = await loadTable(name);
    await atomicJson(indexPath(name), buildIndex(table));
  }
}

async function recoverTransactions() {
  const files = (await fsp.readdir(TX).catch(() => [])).filter(x => x.endsWith('.json'));
  for (const file of files) {
    const manifest = await readJson(path.join(TX, file), null);
    if (!manifest?.before) continue;
    for (const [name, table] of Object.entries(manifest.before)) await persistTable(table);
    await appendWal({ type: 'RECOVER_ROLLBACK', txid: manifest.id, collections: Object.keys(manifest.before) });
    await fsp.unlink(path.join(TX, file)).catch(() => {});
  }
}

async function createCollection(name, unique = []) {
  return queueWrite(async () => {
    name = safeName(name);
    const catalog = await loadCatalog();
    if (catalog.collections[name]) throw Object.assign(new Error('Collection already exists.'), { status: 409 });
    catalog.collections[name] = { createdAt: now(), unique: [...new Set(unique.filter(x => /^[A-Za-z_][A-Za-z0-9_]*$/.test(x)))] };
    const table = { name, meta: { createdAt: now(), updatedAt: now(), count: 0, version: 0 }, rows: [] };
    await appendWal({ type: 'DDL_CREATE', collection: name, unique: catalog.collections[name].unique });
    await persistTable(table);
    await saveCatalog(catalog);
    return table;
  });
}

function normalizeRow(input, existing = null) {
  const t = now();
  const body = { ...(existing || {}), ...(input || {}) };
  delete body.__proto__;
  body.id = existing?.id || input?.id || id();
  body.createdAt = existing?.createdAt || input?.createdAt || t;
  body.updatedAt = t;
  return body;
}

async function transact(ops) {
  if (!Array.isArray(ops) || !ops.length) throw Object.assign(new Error('Transaction needs at least one operation.'), { status: 400 });
  if (ops.length > 100) throw Object.assign(new Error('Transaction operation limit is 100.'), { status: 400 });
  return queueWrite(async () => {
    const txid = id();
    const catalog = await loadCatalog();
    const names = [...new Set(ops.map(o => safeName(o.collection)))];
    const before = {};
    const working = {};
    for (const name of names) {
      if (!catalog.collections[name]) throw Object.assign(new Error(`Collection not found: ${name}`), { status: 404 });
      before[name] = await loadTable(name);
      working[name] = clone(before[name]);
    }

    const manifestPath = path.join(TX, `${txid}.json`);
    await atomicJson(manifestPath, { id: txid, state: 'prepared', at: now(), before });
    await appendWal({ type: 'BEGIN', txid, ops: ops.map(o => ({ type: o.type, collection: o.collection, id: o.id || o.row?.id || null })) });

    const results = [];
    try {
      for (const op of ops) {
        const table = working[op.collection];
        if (op.type === 'insert') {
          const row = normalizeRow(op.row || {});
          if (table.rows.some(r => r.id === row.id)) throw Object.assign(new Error(`Duplicate id: ${row.id}`), { status: 409 });
          table.rows.push(row);
          results.push(row);
        } else if (op.type === 'update') {
          const i = table.rows.findIndex(r => r.id === op.id);
          if (i < 0) throw Object.assign(new Error(`Row not found: ${op.id}`), { status: 404 });
          table.rows[i] = normalizeRow(op.patch || {}, table.rows[i]);
          results.push(table.rows[i]);
        } else if (op.type === 'delete') {
          const i = table.rows.findIndex(r => r.id === op.id);
          if (i < 0) throw Object.assign(new Error(`Row not found: ${op.id}`), { status: 404 });
          results.push(table.rows.splice(i, 1)[0]);
        } else {
          throw Object.assign(new Error(`Unknown operation: ${op.type}`), { status: 400 });
        }
      }

      for (const name of names) await validateUniques(working[name], catalog.collections[name].unique || []);
      for (const name of names) await persistTable(working[name]);
      await appendWal({ type: 'COMMIT', txid, collections: names });
      await fsp.unlink(manifestPath).catch(() => {});
      return { txid, committed: true, results };
    } catch (error) {
      for (const [name, table] of Object.entries(before)) await persistTable(table).catch(() => {});
      await appendWal({ type: 'ABORT', txid, reason: error.message });
      await fsp.unlink(manifestPath).catch(() => {});
      throw error;
    }
  });
}

async function queryCollection(name, q) {
  const table = await loadTable(name);
  let rows = table.rows;
  let plan = { type: 'full-scan', examined: rows.length };
  const field = q.get('field');
  const op = q.get('op') || 'eq';
  const raw = q.get('value');
  let value = raw;
  if (raw === 'true') value = true;
  else if (raw === 'false') value = false;
  else if (raw === 'null') value = null;
  else if (raw !== null && raw !== '' && !Number.isNaN(Number(raw))) value = Number(raw);

  if (field && raw !== null && op === 'eq') {
    const idx = await readJson(indexPath(name), null);
    const ids = idx?.fields?.[field]?.[key(value)];
    if (ids) {
      const set = new Set(ids);
      rows = rows.filter(r => set.has(r.id));
      plan = { type: 'json-index', field, matchedIds: ids.length, examined: ids.length };
    } else {
      rows = rows.filter(r => r[field] === value);
    }
  } else if (field && raw !== null) {
    rows = rows.filter(r => {
      const v = r[field];
      if (op === 'contains') return String(v ?? '').toLowerCase().includes(String(value).toLowerCase());
      if (op === 'gt') return v > value;
      if (op === 'gte') return v >= value;
      if (op === 'lt') return v < value;
      if (op === 'lte') return v <= value;
      if (op === 'ne') return v !== value;
      return v === value;
    });
  }

  const sort = q.get('sort');
  if (sort) {
    const desc = sort.startsWith('-');
    const f = desc ? sort.slice(1) : sort;
    rows = [...rows].sort((a, b) => (a[f] === b[f] ? 0 : a[f] > b[f] ? 1 : -1) * (desc ? -1 : 1));
  }
  const offset = Math.max(0, Number(q.get('offset') || 0));
  const limit = Math.min(500, Math.max(1, Number(q.get('limit') || 100)));
  const total = rows.length;
  rows = rows.slice(offset, offset + limit);
  return { collection: name, total, offset, limit, plan, rows };
}

async function createSnapshot() {
  return queueWrite(async () => {
    const stamp = now().replace(/[:.]/g, '-');
    const dir = path.join(SNAPSHOTS, stamp);
    await ensureDir(dir);
    const catalog = await loadCatalog();
    await atomicJson(path.join(dir, 'catalog.json'), catalog);
    for (const name of Object.keys(catalog.collections)) await atomicJson(path.join(dir, `${name}.json`), await loadTable(name));
    await appendWal({ type: 'SNAPSHOT', snapshot: stamp });
    return { snapshot: stamp, collections: Object.keys(catalog.collections) };
  });
}

async function stats() {
  const catalog = await loadCatalog();
  const collections = [];
  for (const name of Object.keys(catalog.collections)) {
    const t = await loadTable(name);
    collections.push({ name, rows: t.rows.length, version: t.meta.version, updatedAt: t.meta.updatedAt, unique: catalog.collections[name].unique || [] });
  }
  const walStat = await fsp.stat(WAL).catch(() => ({ size: 0 }));
  const snapshots = await fsp.readdir(SNAPSHOTS).catch(() => []);
  return { engine: 'JSONDB Lab', durability: 'atomic rename + undo journal + WAL', collections, walBytes: walStat.size, snapshots: snapshots.length };
}

function json(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

async function body(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1_000_000) throw Object.assign(new Error('Body too large.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
}

async function api(req, res, url) {
  if (url.pathname === '/api/meta' && req.method === 'GET') return json(res, 200, await stats());
  if (url.pathname === '/api/collections' && req.method === 'GET') return json(res, 200, await loadCatalog());
  if (url.pathname === '/api/collections' && req.method === 'POST') {
    const b = await body(req); return json(res, 201, await createCollection(b.name, Array.isArray(b.unique) ? b.unique : []));
  }
  if (url.pathname === '/api/tx' && req.method === 'POST') return json(res, 200, await transact((await body(req)).ops));
  if (url.pathname === '/api/snapshot' && req.method === 'POST') return json(res, 201, await createSnapshot());
  if (url.pathname === '/api/wal' && req.method === 'GET') {
    const text = await fsp.readFile(WAL, 'utf8').catch(() => '');
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 40)));
    const events = text.trim() ? text.trim().split('\n').slice(-limit).map(line => JSON.parse(line)) : [];
    return json(res, 200, { events });
  }

  const match = url.pathname.match(/^\/api\/data\/([A-Za-z][A-Za-z0-9_-]{0,63})(?:\/([0-9a-f-]{36}))?$/i);
  if (match) {
    const [, collection, rowId] = match;
    if (req.method === 'GET' && !rowId) return json(res, 200, await queryCollection(collection, url.searchParams));
    if (req.method === 'POST' && !rowId) return json(res, 201, await transact([{ type: 'insert', collection, row: await body(req) }]));
    if (req.method === 'PATCH' && rowId) return json(res, 200, await transact([{ type: 'update', collection, id: rowId, patch: await body(req) }]));
    if (req.method === 'DELETE' && rowId) return json(res, 200, await transact([{ type: 'delete', collection, id: rowId }]));
  }
  return json(res, 404, { error: 'API route not found.' });
}

async function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  rel = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'Nope.' });
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('Not a file');
    const ext = path.extname(file);
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size });
    fs.createReadStream(file).pipe(res);
  } catch { json(res, 404, { error: 'File not found.' }); }
}

async function main() {
  await init();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await serveStatic(req, res, url);
    } catch (error) {
      console.error(error);
      json(res, error.status || 500, { error: error.message, stack: process.env.JSONDB_DEBUG ? error.stack : undefined });
    }
  });
  server.listen(PORT, HOST, () => {
    console.log(`\nJSONDB Lab is committing crimes against simplicity at http://${HOST}:${PORT}`);
    console.log(`Persistent state: ${DATA}`);
    console.log('No npm. No framework. No account. Just JSON pretending to be a database.\n');
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
