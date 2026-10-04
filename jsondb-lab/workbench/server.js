'use strict';

const http = require('http');
const path = require('path');
const fsp = require('fs/promises');
const { MonsterEngine } = require('../monster/engine');
const { domains, unresolvedDomains, collections, allowedCollections, scales, DOMAIN_VERSION } = require('./domain');
const { ensureSchema, seedScenario } = require('./seeder');
const { runBenchmark } = require('./benchmark');

const HOST = process.env.WORKBENCH_HOST || '127.0.0.1';
const PORT = Number(process.env.WORKBENCH_PORT || 7334);
const INTENT_HEADER = 'x-kirion-workbench-intent';
const INTENT_VALUE = 'write';
const BODY_LIMIT = 1024 * 1024;
const EVENT_LIMIT = 400;

const root = __dirname;
const labRoot = path.resolve(root, '..');
const publicRoot = path.join(root, 'public');
const engine = new MonsterEngine(labRoot);
const clients = new Set();
const events = [];
let sequence = 0;
let writeBusy = false;
let activeAction = null;
let lastBenchmark = null;
let lastSeed = null;

const staticRoutes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);

function headers(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ...extra
  };
}

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(status, headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  }));
  res.end(body);
}

function errorStatus(error) {
  return Number(error?.status || 500);
}

function publicError(error) {
  const status = errorStatus(error);
  return {
    error: status >= 500 ? 'WORKBENCH_INTERNAL_ERROR' : 'WORKBENCH_REQUEST_ERROR',
    message: error?.message || 'Unknown Workbench error.',
    status
  };
}

async function bodyJson(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('application/json')) throw Object.assign(new Error('Workbench POST endpoints require application/json.'), { status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error('Request body too large.'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }); }
}

function requireWriteIntent(req) {
  if (String(req.headers[INTENT_HEADER] || '').toLowerCase() !== INTENT_VALUE) {
    throw Object.assign(new Error(`Explicit ${INTENT_HEADER}: ${INTENT_VALUE} header required for Workbench writes.`), { status: 403 });
  }
}

function emit(input) {
  const event = {
    format: 'JSONDB-KIRION-WORKBENCH-EVENT-1',
    sequence: ++sequence,
    at: new Date().toISOString(),
    type: input.type || 'WORKBENCH_EVENT',
    phase: input.phase || 'observe',
    domain: input.domain || 'workbench',
    severity: input.severity || 'normal',
    simple: input.simple || input.type || 'Workbench event',
    engineer: input.engineer || input.simple || input.type || 'Workbench event',
    details: input.details || null
  };
  events.push(event);
  if (events.length > EVENT_LIMIT) events.splice(0, events.length - EVENT_LIMIT);
  const wire = `id: ${event.sequence}\nevent: workbench\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try { client.write(wire); }
    catch { clients.delete(client); }
  }
  return event;
}

function allowedCollection(value) {
  const name = String(value || '');
  if (!allowedCollections.has(name)) throw Object.assign(new Error('Collection is not part of the bounded KIRION Workbench schema.'), { status: 400 });
  return name;
}

function validateQueryCollections(query) {
  const from = allowedCollection(query?.from);
  for (const join of query?.joins || []) allowedCollection(join?.collection);
  return { ...query, from };
}

async function collectionState() {
  const catalog = await engine.catalog();
  const rows = [];
  for (const spec of collections) {
    if (!catalog.collections?.[spec.name]) {
      rows.push({ name: spec.name, domain: spec.domain, purpose: spec.purpose, present: false, rows: 0, revision: 0, lastTx: 0 });
      continue;
    }
    const table = await engine.loadCurrent(spec.name);
    rows.push({
      name: spec.name,
      domain: spec.domain,
      purpose: spec.purpose,
      present: true,
      rows: table.rows.length,
      revision: Number(table.meta?.revision || 0),
      lastTx: Number(table.meta?.lastTx || 0),
      updatedAt: table.meta?.updatedAt || null,
      indexes: catalog.collections[spec.name].indexes || []
    });
  }
  return rows;
}

async function state() {
  const [meta, collectionRows] = await Promise.all([engine.meta(), collectionState()]);
  return {
    format: 'JSONDB-KIRION-WORKBENCH-STATE-1',
    observedAt: new Date().toISOString(),
    authority: 'EXPLICIT_WRITE_APP',
    busy: writeBusy,
    activeAction,
    engine: {
      nextTx: Number(meta.nextTx || 1),
      currentLsn: Math.max(0, Number(meta.nextLsn || 1) - 1),
      checkpointLsn: Number(meta.checkpointLsn || 0)
    },
    totals: {
      collections: collectionRows.filter(item => item.present).length,
      rows: collectionRows.reduce((sum, item) => sum + item.rows, 0),
      workbenchRows: collectionRows.filter(item => item.present).reduce((sum, item) => sum + item.rows, 0)
    },
    collections: collectionRows,
    recentEvents: events.slice(-60),
    lastSeed,
    lastBenchmark: lastBenchmark ? {
      at: lastBenchmark.at,
      benchmarkRows: lastBenchmark.benchmarkRows,
      passed: lastBenchmark.passed,
      failed: lastBenchmark.failed,
      total: lastBenchmark.total,
      totalDurationMs: lastBenchmark.totalDurationMs,
      plannerCases: lastBenchmark.plannerCases
    } : null
  };
}

async function sampleCollection(name, limit = 50) {
  name = allowedCollection(name);
  const catalog = await engine.catalog();
  if (!catalog.collections?.[name]) throw Object.assign(new Error('Collection has not been created yet. Run a seed or initialize the Workbench schema.'), { status: 404 });
  const table = await engine.loadCurrent(name);
  const capped = Math.min(200, Math.max(1, Number(limit || 50)));
  return {
    format: 'JSONDB-KIRION-WORKBENCH-SAMPLE-1',
    collection: name,
    rowCount: table.rows.length,
    meta: table.meta,
    rows: table.rows.slice(-capped)
  };
}

async function withWriteAction(kind, detail, fn) {
  if (writeBusy) throw Object.assign(new Error(`Workbench is busy with ${activeAction?.kind || 'another write operation'}.`), { status: 409 });
  writeBusy = true;
  activeAction = { kind, startedAt: new Date().toISOString(), ...detail };
  emit({
    type: 'WRITE_ACTION_BEGIN', phase: 'request', domain: detail?.domain || 'workbench',
    simple: `${kind} started.`,
    engineer: `Workbench write authority entered for ${kind}; this operation will mutate MonsterEngine state through declared engine APIs only.`,
    details: activeAction
  });
  try { return await fn(); }
  finally {
    emit({
      type: 'WRITE_ACTION_END', phase: 'observe', domain: detail?.domain || 'workbench',
      simple: `${kind} finished.`,
      engineer: `Workbench write authority exited for ${kind}.`,
      details: activeAction
    });
    activeAction = null;
    writeBusy = false;
  }
}

async function serveStatic(res, route) {
  const spec = staticRoutes.get(route);
  if (!spec) return false;
  const [file, type] = spec;
  try {
    const body = await fsp.readFile(path.join(publicRoot, file));
    res.writeHead(200, headers({ 'Content-Type': type, 'Content-Length': body.length }));
    res.end(body);
  } catch (error) {
    sendJson(res, 500, publicError(error));
  }
  return true;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (await serveStatic(res, url.pathname)) return;
    if (url.pathname === '/api/state') return sendJson(res, 200, await state());
    if (url.pathname === '/api/schema') return sendJson(res, 200, {
      format: 'JSONDB-KIRION-WORKBENCH-SCHEMA-1',
      domainVersion: DOMAIN_VERSION,
      authority: 'EXPLICIT_WRITE_APP',
      domains,
      unresolvedDomains,
      scales,
      collections
    });
    if (url.pathname === '/api/sample') return sendJson(res, 200, await sampleCollection(url.searchParams.get('collection'), url.searchParams.get('limit')));
    if (url.pathname === '/api/events') {
      res.writeHead(200, headers({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }));
      res.write(`event: hello\ndata: ${JSON.stringify({ authority: 'EXPLICIT_WRITE_APP', latestSequence: sequence })}\n\n`);
      for (const event of events.slice(-30)) res.write(`id: ${event.sequence}\nevent: workbench\ndata: ${JSON.stringify(event)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  }

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  requireWriteIntent(req);
  const body = await bodyJson(req);

  if (url.pathname === '/api/seed') {
    const result = await withWriteAction('SEED', { domain: 'forge', scale: body.scale || 'demo' }, async () => {
      const seeded = await seedScenario(engine, body, emit);
      lastSeed = { ...seeded, at: new Date().toISOString() };
      return seeded;
    });
    return sendJson(res, 200, result);
  }

  if (url.pathname === '/api/record') {
    const collection = allowedCollection(body.collection);
    const result = await withWriteAction('INSERT_RECORD', { domain: collections.find(item => item.name === collection)?.domain || 'workbench', collection }, async () => {
      await ensureSchema(engine, emit);
      emit({
        type: 'RECORD_VALIDATE', phase: 'validate', domain: collections.find(item => item.name === collection)?.domain || 'workbench',
        simple: `Validating new ${collection} record.`,
        engineer: `Record insert validation passed bounded collection authority for ${collection}; MonsterEngine constraints will perform final database validation.`,
        details: { collection }
      });
      const tx = await engine.transact([{ type: 'insert', collection, row: body.row || {} }]);
      emit({
        type: 'RECORD_COMMIT', phase: 'commit', domain: collections.find(item => item.name === collection)?.domain || 'workbench',
        simple: `Record committed to ${collection}.`,
        engineer: `COMMIT tx=${tx.tx}; collection=${collection}; WAL/current/version/index surfaces advanced through MonsterEngine.`,
        details: { collection, tx: tx.tx, id: tx.results?.[0]?.id }
      });
      return tx;
    });
    return sendJson(res, 200, result);
  }

  if (url.pathname === '/api/query') {
    const query = validateQueryCollections(body.query || {});
    const result = await engine.query(query);
    emit({
      type: 'QUERY_COMPLETE', phase: 'query', domain: 'benchmark',
      simple: `Query returned ${result.rows.length.toLocaleString()} rows.`,
      engineer: `Query COMPLETE; from=${query.from}; access=${result.explain.access.type}; examined=${result.explain.examined}; returned=${result.rows.length}; duration=${result.explain.durationMs.toFixed(3)}ms.`,
      details: { query, explain: result.explain, returned: result.rows.length }
    });
    return sendJson(res, 200, result);
  }

  if (url.pathname === '/api/benchmark') {
    const result = await withWriteAction('BENCHMARK', { domain: 'benchmark' }, async () => {
      await ensureSchema(engine, emit);
      const bench = await runBenchmark(engine, body, emit);
      lastBenchmark = bench;
      return bench;
    });
    return sendJson(res, 200, result);
  }

  return sendJson(res, 404, { error: 'NOT_FOUND' });
}

async function main() {
  await engine.init();
  emit({
    type: 'WORKBENCH_READY', phase: 'observe', domain: 'workbench',
    simple: 'KIRION Data Workbench is ready.',
    engineer: `Workbench booted against MonsterEngine at ${labRoot}; authority=EXPLICIT_WRITE_APP; host=${HOST}; port=${PORT}.`,
    details: { host: HOST, port: PORT }
  });
  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      emit({
        type: 'REQUEST_FAILED', phase: 'abort', domain: 'workbench', severity: 'error',
        simple: error.message,
        engineer: error.stack || error.message,
        details: { method: req.method, url: req.url, status: errorStatus(error) }
      });
      if (!res.headersSent) sendJson(res, errorStatus(error), publicError(error));
      else res.end();
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`KIRION DATA WORKBENCH\nhttp://${HOST}:${PORT}\nauthority=EXPLICIT_WRITE_APP\nintent-header=${INTENT_HEADER}: ${INTENT_VALUE}`);
  });
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

module.exports = { emit, state, collectionState, validateQueryCollections, allowedCollection };
