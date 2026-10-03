#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');
const { MonsterEngine } = require('./monster/engine');
const { JsonCluster } = require('./monster/cluster');
const { AdvancedServices } = require('./monster/advanced');
const { readJson, readJsonl } = require('./monster/jsonfs');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.MONSTER_PORT || process.env.PORT || 7332);
const engine = new MonsterEngine(ROOT);
const cluster = new JsonCluster(engine);
const advanced = new AdvancedServices(engine);

function json(res, status, payload) {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-jsondb-monster': 'we-could-have-used-sqlite'
  });
  res.end(text);
}

async function parseBody(req, max = 5_000_000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > max) throw Object.assign(new Error('Request body exceeded monster limit.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
}

async function requireLeader() { await cluster.assertLeader(); }

async function lockedTransact(ops, options = {}) {
  await requireLeader();
  const requestTx = `lock-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const resources = ops.flatMap(op => [`table:${op.collection}`, ...(op.id ? [`row:${op.collection}:${op.id}`] : [])]);
  const lock = await advanced.locks.acquire(requestTx, resources, options.lockTimeoutMs || 5000);
  try {
    const triggered = await advanced.applyBeforeTriggers(ops);
    const result = await engine.transact(triggered.ops, options);
    return { ...result, lock, triggersFired: triggered.fired };
  } finally {
    advanced.locks.release(requestTx);
  }
}

async function seed(collection, count) {
  await requireLeader();
  count = Math.min(50_000, Math.max(1, Number(count || 1000)));
  const catalog = await engine.catalog();
  if (!catalog.collections[collection]) {
    await engine.createCollection({
      name: collection,
      unique: ['syntheticKey'],
      indexes: [
        { name: `${collection}_key`, fields: ['syntheticKey'], unique: true },
        { name: `${collection}_status`, fields: ['status'] },
        { name: `${collection}_office_status`, fields: ['office', 'status'] }
      ]
    });
  }
  const statuses = ['pending', 'active', 'done', 'blocked'];
  const offices = ['Engineering', 'Budget', 'Accounting', 'MPDO', 'Mayor'];
  const started = process.hrtime.bigint();
  let inserted = 0;
  const batchNonce = Date.now();
  for (let start = 0; start < count; start += 500) {
    const size = Math.min(500, count - start);
    const ops = [];
    for (let i = 0; i < size; i++) {
      const n = start + i;
      ops.push({
        type: 'insert', collection,
        row: {
          syntheticKey: `row-${batchNonce}-${n}`,
          ordinal: n,
          status: statuses[n % statuses.length],
          office: offices[n % offices.length],
          score: (n * 7919) % 1000,
          payload: `JSON row ${n} exists because SQLite was apparently too easy.`
        }
      });
    }
    await lockedTransact(ops);
    inserted += size;
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { collection, inserted, elapsedMs, rowsPerSecond: Math.round(inserted / (elapsedMs / 1000)) };
}

async function api(req, res, url) {
  const p = url.pathname;

  if (p === '/api/status' && req.method === 'GET') return json(res, 200, { engine: await engine.status(), cluster: await cluster.status(), advanced: await advanced.status() });
  if (p === '/api/catalog' && req.method === 'GET') return json(res, 200, await engine.catalog());
  if (p === '/api/cluster' && req.method === 'GET') return json(res, 200, await cluster.status());
  if (p === '/api/locks' && req.method === 'GET') return json(res, 200, advanced.locks.status());
  if (p === '/api/cdc' && req.method === 'GET') return json(res, 200, { events: await engine.cdc(url.searchParams.get('after') || 0, url.searchParams.get('limit') || 200) });

  if (p === '/api/collections' && req.method === 'POST') {
    await requireLeader();
    return json(res, 201, await engine.createCollection(await parseBody(req)));
  }
  const collectionAlter = p.match(/^\/api\/collections\/([A-Za-z][A-Za-z0-9_-]{0,63})$/);
  if (collectionAlter && req.method === 'PATCH') {
    await requireLeader();
    return json(res, 200, await engine.alterCollection(collectionAlter[1], await parseBody(req)));
  }

  if (p === '/api/tx' && req.method === 'POST') {
    const body = await parseBody(req);
    return json(res, 200, await lockedTransact(body.ops, { isolation: body.isolation, lockTimeoutMs: body.lockTimeoutMs }));
  }
  if (p === '/api/query' && req.method === 'POST') return json(res, 200, await engine.query(await parseBody(req)));

  const dataRoute = p.match(/^\/api\/data\/([A-Za-z][A-Za-z0-9_-]{0,63})(?:\/([0-9a-f-]{36}))?$/i);
  if (dataRoute) {
    const [, collection, rowId] = dataRoute;
    if (req.method === 'GET' && !rowId) {
      const where = url.searchParams.get('field') ? { field: url.searchParams.get('field'), op: url.searchParams.get('op') || 'eq', value: parseScalar(url.searchParams.get('value')) } : null;
      const result = await engine.query({ from: collection, where, orderBy: url.searchParams.get('sort') ? [url.searchParams.get('sort')] : [], limit: Number(url.searchParams.get('limit') || 100), asOf: url.searchParams.get('asOf') || undefined });
      return json(res, 200, result);
    }
    if (req.method === 'POST' && !rowId) return json(res, 201, await lockedTransact([{ type: 'insert', collection, row: await parseBody(req) }]));
    if (req.method === 'PATCH' && rowId) return json(res, 200, await lockedTransact([{ type: 'update', collection, id: rowId, patch: await parseBody(req) }]));
    if (req.method === 'DELETE' && rowId) return json(res, 200, await lockedTransact([{ type: 'delete', collection, id: rowId }]));
  }

  if (p === '/api/checkpoint' && req.method === 'POST') { await requireLeader(); return json(res, 201, await engine.checkpoint()); }
  if (p === '/api/compact' && req.method === 'POST') { await requireLeader(); const body = await parseBody(req); return json(res, 200, await engine.compact(body.collection || null)); }
  if (p === '/api/snapshot' && req.method === 'POST') { await requireLeader(); return json(res, 201, await engine.snapshot()); }
  if (p === '/api/integrity' && req.method === 'POST') return json(res, 200, await engine.verifyIntegrity());
  if (p === '/api/integrity/latest' && req.method === 'GET') return json(res, 200, await readJson(path.join(engine.integrityDir, 'latest.json'), { status: 'never-run' }));

  const viewRoute = p.match(/^\/api\/views\/([A-Za-z][A-Za-z0-9_-]{0,63})$/);
  if (viewRoute && req.method === 'POST') { await requireLeader(); return json(res, 201, await engine.createMaterializedView(viewRoute[1], await parseBody(req))); }
  if (viewRoute && req.method === 'GET') return json(res, 200, await readJson(path.join(engine.views, `${viewRoute[1]}.json`), { error: 'View not materialized.' }));
  if (p === '/api/views/refresh' && req.method === 'POST') { await requireLeader(); return json(res, 200, await engine.refreshViews()); }

  if (p === '/api/analyze' && req.method === 'POST') return json(res, 200, await advanced.analyze((await parseBody(req)).collection));
  if (p === '/api/bloom/build' && req.method === 'POST') {
    const body = await parseBody(req);
    return json(res, 201, await advanced.buildBloom(body.collection, body.field, body.bits, body.hashes));
  }
  if (p === '/api/bloom/test' && req.method === 'POST') {
    const body = await parseBody(req);
    return json(res, 200, await advanced.testBloom(body.collection, body.field, body.value));
  }
  if (p === '/api/partitions/build' && req.method === 'POST') {
    const body = await parseBody(req);
    return json(res, 201, await advanced.buildPartitions(body.collection, body.field, body.buckets));
  }

  const preparedRoute = p.match(/^\/api\/prepared\/([A-Za-z][A-Za-z0-9_-]{0,63})$/);
  if (preparedRoute && req.method === 'POST') return json(res, 201, await advanced.prepare(preparedRoute[1], (await parseBody(req)).query));
  const executePrepared = p.match(/^\/api\/prepared\/([A-Za-z][A-Za-z0-9_-]{0,63})\/execute$/);
  if (executePrepared && req.method === 'POST') return json(res, 200, await advanced.executePrepared(executePrepared[1], (await parseBody(req)).params || {}));

  if (p === '/api/triggers' && req.method === 'POST') { await requireLeader(); return json(res, 201, await advanced.addTrigger(await parseBody(req))); }
  if (p === '/api/migrations' && req.method === 'POST') { await requireLeader(); return json(res, 200, await advanced.applyMigration(await parseBody(req))); }
  if (p === '/api/backup' && req.method === 'POST') return json(res, 201, await advanced.backup());
  if (p === '/api/restore-sandbox' && req.method === 'POST') return json(res, 201, await advanced.restoreSandbox((await parseBody(req)).backup));

  if (p === '/api/cluster/replicate' && req.method === 'POST') {
    const body = await parseBody(req);
    return json(res, 200, body.node ? await cluster.replicate(body.node) : await cluster.replicateAll());
  }
  if (p === '/api/cluster/elect' && req.method === 'POST') return json(res, 200, await cluster.elect((await parseBody(req)).candidate));
  if (p === '/api/cluster/failover' && req.method === 'POST') return json(res, 200, await cluster.failover());
  if (p === '/api/cluster/promote-local' && req.method === 'POST') return json(res, 200, await cluster.promoteLocal());
  if (p === '/api/cluster/node' && req.method === 'POST') {
    const body = await parseBody(req);
    return json(res, 200, await cluster.setOnline(body.node, body.online));
  }
  if (p === '/api/cluster/heartbeat' && req.method === 'POST') return json(res, 200, await cluster.heartbeat());

  if (p === '/api/benchmark/seed' && req.method === 'POST') {
    const body = await parseBody(req);
    return json(res, 201, await seed(engine.safeName(body.collection || 'bench'), body.count || 1000));
  }
  if (p === '/api/wal' && req.method === 'GET') {
    const rows = await readJsonl(engine.wal);
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    return json(res, 200, { events: rows.slice(-limit) });
  }

  return json(res, 404, { error: 'Monster endpoint not found.' });
}

function parseScalar(raw) {
  if (raw === null) return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

async function serveStatic(res, url) {
  let rel = url.pathname === '/' ? 'monster.html' : url.pathname.replace(/^\/+/, '');
  rel = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'Path rejected.' });
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('Not file');
    const ext = path.extname(file);
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch { json(res, 404, { error: 'File not found.' }); }
}

async function main() {
  await engine.init();
  await cluster.init();
  await advanced.init();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await serveStatic(res, url);
    } catch (error) {
      console.error('[MONSTER]', error);
      json(res, error.status || 500, { error: error.message, code: error.code, stack: process.env.JSONDB_DEBUG ? error.stack : undefined });
    }
  });
  server.listen(PORT, HOST, () => {
    console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║ JSONDB MONSTER MODE                                                ║');
    console.log('║ We went past the point where SQLite would have been sane.          ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝');
    console.log(`Control plane : http://${HOST}:${PORT}`);
    console.log(`Persistent JSON: ${engine.data}`);
    console.log('WAL + MVCC-ish + planner + joins + locks + deadlocks + bloom + cluster.');
    console.log('No npm. No framework. No actual database. Absolutely no reason.\n');
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
