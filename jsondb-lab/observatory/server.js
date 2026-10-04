'use strict';

const http = require('http');
const path = require('path');
const fsp = require('fs/promises');

const HOST = process.env.OBSERVATORY_HOST || '127.0.0.1';
const PORT = Number(process.env.OBSERVATORY_PORT || 7331);
const SCAN_MS = Math.max(250, Number(process.env.OBSERVATORY_SCAN_MS || 750));

const root = __dirname;
const labRoot = path.resolve(root, '..');
const publicRoot = path.join(root, 'public');
const dataRoot = path.join(labRoot, 'monster-data');
const saviorRoot = path.join(dataRoot, 'advanced', 'savior');

const staticRoutes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/index-lab.js', ['index-lab.js', 'text/javascript; charset=utf-8']]
]);

const observedSurfaces = [
  path.join(dataRoot, 'catalog.json'),
  path.join(dataRoot, 'meta.json'),
  path.join(dataRoot, 'wal.jsonl'),
  path.join(dataRoot, 'current'),
  path.join(dataRoot, 'indexes'),
  path.join(dataRoot, 'versions'),
  path.join(dataRoot, 'checkpoints'),
  path.join(dataRoot, 'snapshots'),
  saviorRoot
];

const clients = new Set();
let eventSequence = 0;
let lastScan = new Map();
let scanBusy = false;

function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ...extra
  };
}

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(status, securityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  }));
  res.end(body);
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function exists(file) {
  try { await fsp.access(file); return true; }
  catch { return false; }
}

async function tailJsonl(file, limit = 60, maxBytes = 256 * 1024) {
  try {
    const stat = await fsp.stat(file);
    const bytes = Math.min(stat.size, maxBytes);
    if (!bytes) return [];
    const handle = await fsp.open(file, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      await handle.read(buffer, 0, bytes, Math.max(0, stat.size - bytes));
      const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-limit);
      return lines.map(line => {
        try { return JSON.parse(line); }
        catch { return { __unparsed: true, preview: line.slice(0, 240) }; }
      });
    } finally { await handle.close(); }
  } catch { return []; }
}

async function collectionSummaries(catalog) {
  const result = [];
  for (const name of Object.keys(catalog?.collections || {}).sort()) {
    const table = await readJson(path.join(dataRoot, 'current', `${name}.json`), null);
    result.push({
      name,
      rows: Array.isArray(table?.rows) ? table.rows.length : Number(table?.meta?.rows || 0),
      revision: Number(table?.meta?.revision || 0),
      updatedAt: table?.meta?.updatedAt || null,
      indexes: (catalog.collections[name]?.indexes || []).map(index => ({
        name: index.name,
        fields: index.fields,
        unique: Boolean(index.unique)
      }))
    });
  }
  return result;
}

function primitiveFieldOptions(rows) {
  const stats = new Map();
  for (const row of rows.slice(0, 500)) {
    for (const [field, value] of Object.entries(row || {})) {
      if (value == null || !['string', 'number', 'boolean'].includes(typeof value)) continue;
      const current = stats.get(field) || { field, number: 0, string: 0, boolean: 0, seen: 0 };
      current[typeof value]++;
      current.seen++;
      stats.set(field, current);
    }
  }
  return [...stats.values()]
    .sort((a, b) => b.seen - a.seen || a.field.localeCompare(b.field))
    .map(item => ({
      field: item.field,
      dominantType: ['number', 'string', 'boolean'].sort((a, b) => item[b] - item[a])[0],
      observed: item.seen
    }));
}

async function indexLab(collection) {
  const catalog = await readJson(path.join(dataRoot, 'catalog.json'), { collections: {} });
  if (!collection || typeof collection !== 'string' || !Object.prototype.hasOwnProperty.call(catalog.collections || {}, collection)) {
    return { status: 404, body: { error: 'COLLECTION_NOT_FOUND', message: 'Index Lab only accepts collection names present in the canonical catalog.' } };
  }
  const [table, indexDoc] = await Promise.all([
    readJson(path.join(dataRoot, 'current', `${collection}.json`), null),
    readJson(path.join(dataRoot, 'indexes', `${collection}.json`), null)
  ]);
  if (!table) return { status: 404, body: { error: 'CURRENT_TABLE_NOT_FOUND' } };
  const rows = Array.isArray(table.rows) ? table.rows.slice(0, 500) : [];
  const indexes = Object.entries(indexDoc?.indexes || {}).map(([name, idx]) => {
    const buckets = Object.entries(idx.map || {}).map(([key, rowIds]) => ({ key, rowIds }));
    return {
      name,
      fields: idx.fields || [],
      unique: Boolean(idx.unique),
      distinct: Number(idx.distinct ?? buckets.length),
      bucketCount: buckets.length,
      buckets: buckets.slice(0, 500)
    };
  });
  return {
    status: 200,
    body: {
      format: 'JSONDB-OMEGA-OBSERVATORY-INDEX-LAB-1',
      observedAt: new Date().toISOString(),
      authority: 'READ_ONLY_OBSERVER',
      collection,
      truth: {
        engineIndexStructure: 'HASH_MAP',
        actualBuildSemantics: 'For every table row, encode configured index field value(s) into a key and append row.id to that key bucket.',
        persistedArtifact: `indexes/${collection}.json`,
        sortAnimation: 'EXPLAIN_ONLY',
        sortWarning: 'The engine does not sort rows to build this index. Sorting animations use real rows but execute only in browser memory.'
      },
      table: {
        rowCount: Number(table.meta?.rows ?? rows.length),
        revision: Number(table.meta?.revision || 0),
        lastTx: Number(table.meta?.lastTx || 0),
        rowsTruncated: Array.isArray(table.rows) && table.rows.length > rows.length,
        rows
      },
      indexArtifact: indexDoc ? {
        builtAt: indexDoc.builtAt || null,
        tx: Number(indexDoc.tx || 0),
        rowCount: Number(indexDoc.rowCount || 0),
        indexes
      } : { builtAt: null, tx: 0, rowCount: 0, indexes: [] },
      sortFields: primitiveFieldOptions(rows)
    }
  };
}

async function snapshot() {
  const [catalog, meta, saviorState, lastSavior, contractAnalysis, firewallHead, wal] = await Promise.all([
    readJson(path.join(dataRoot, 'catalog.json'), { version: 2, collections: {} }),
    readJson(path.join(dataRoot, 'meta.json'), { engineVersion: 2, nextTx: 1, nextLsn: 1, checkpointLsn: 0 }),
    readJson(path.join(saviorRoot, 'state.json'), null),
    readJson(path.join(saviorRoot, 'last-savior-archives', 'latest.json'), null),
    readJson(path.join(saviorRoot, 'recovery-contracts', 'latest-analysis.json'), null),
    readJson(path.join(saviorRoot, 'authority-firewall', 'head.json'), null),
    tailJsonl(path.join(dataRoot, 'wal.jsonl'))
  ]);
  const collections = await collectionSummaries(catalog);
  return {
    format: 'JSONDB-OMEGA-OBSERVATORY-SNAPSHOT-1',
    observedAt: new Date().toISOString(),
    authority: 'READ_ONLY_OBSERVER',
    engine: {
      present: await exists(dataRoot),
      version: meta?.engineVersion || null,
      nextTx: meta?.nextTx || 1,
      nextLsn: meta?.nextLsn || 1,
      currentLsn: Math.max(0, Number(meta?.nextLsn || 1) - 1),
      checkpointLsn: Number(meta?.checkpointLsn || 0),
      collections: collections.length,
      rows: collections.reduce((sum, item) => sum + item.rows, 0)
    },
    collections,
    wal,
    savior: saviorState ? {
      present: true,
      mode: saviorState.mode || 'unknown',
      reason: saviorState.reason || null,
      since: saviorState.at || saviorState.since || null
    } : { present: false, mode: 'absent', reason: null, since: null },
    lastSavior: lastSavior ? {
      present: true,
      id: lastSavior.id,
      createdAt: lastSavior.createdAt,
      archiveHash: lastSavior.archiveHash,
      semanticSha256: lastSavior.world?.semanticSha256 || null,
      format: lastSavior.format
    } : { present: false },
    recoveryContracts: contractAnalysis ? {
      present: true,
      valid: contractAnalysis.valid,
      contracts: contractAnalysis.summary?.contracts || 0,
      violations: contractAnalysis.violations?.length || 0
    } : { present: false },
    firewall: firewallHead ? {
      present: true,
      sequence: firewallHead.sequence || 0,
      decisionHash: firewallHead.decisionHash || null,
      actor: firewallHead.actor || null,
      action: firewallHead.action || null,
      allowed: firewallHead.allowed
    } : { present: false, sequence: 0 }
  };
}

function relativeObserved(file) {
  return path.relative(dataRoot, file).split(path.sep).join('/');
}

async function scanPath(target, out, budget) {
  if (budget.count >= budget.max) return;
  let stat;
  try { stat = await fsp.lstat(target); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    let entries;
    try { entries = await fsp.readdir(target, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (budget.count >= budget.max) break;
      await scanPath(path.join(target, entry.name), out, budget);
    }
    return;
  }
  if (!stat.isFile()) return;
  budget.count++;
  out.set(relativeObserved(target), { size: stat.size, mtimeMs: stat.mtimeMs });
}

async function scanObserved() {
  const out = new Map();
  const budget = { count: 0, max: 5000 };
  for (const surface of observedSurfaces) await scanPath(surface, out, budget);
  return out;
}

function classify(rel, mutation) {
  const common = { source: rel, mutation };
  if (rel === 'wal.jsonl') return { ...common, family: 'wal', type: 'WAL_CHANGED', from: 'tx', to: 'wal' };
  if (rel.startsWith('current/')) return { ...common, family: 'data', type: 'CURRENT_STATE_CHANGED', from: 'wal', to: 'current' };
  if (rel.startsWith('indexes/')) return { ...common, family: 'index', type: 'INDEX_CHANGED', from: 'current', to: 'index' };
  if (rel.startsWith('versions/')) return { ...common, family: 'history', type: 'VERSION_HISTORY_CHANGED', from: 'current', to: 'history' };
  if (rel.startsWith('checkpoints/')) return { ...common, family: 'history', type: 'CHECKPOINT_CHANGED', from: 'index', to: 'history' };
  if (rel.startsWith('snapshots/')) return { ...common, family: 'history', type: 'SNAPSHOT_CHANGED', from: 'current', to: 'history' };
  if (rel.startsWith('advanced/savior/')) return { ...common, family: 'recovery', type: 'RECOVERY_EVIDENCE_CHANGED', from: 'history', to: 'savior' };
  if (rel === 'catalog.json' || rel === 'meta.json') return { ...common, family: 'engine', type: 'ENGINE_METADATA_CHANGED', from: 'app', to: 'tx' };
  return { ...common, family: 'filesystem', type: 'OBSERVED_FILE_CHANGED', from: 'app', to: 'current' };
}

function publish(event) {
  const full = {
    format: 'JSONDB-OMEGA-OBSERVATORY-EVENT-1',
    id: `obs-${String(++eventSequence).padStart(10, '0')}`,
    time: new Date().toISOString(),
    mode: 'LIVE',
    ...event
  };
  const payload = `id: ${full.id}\nevent: observation\ndata: ${JSON.stringify(full)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

async function poll() {
  if (scanBusy) return;
  scanBusy = true;
  try {
    const next = await scanObserved();
    if (lastScan.size) {
      for (const [rel, value] of next) {
        const prior = lastScan.get(rel);
        if (!prior) publish(classify(rel, 'created'));
        else if (prior.size !== value.size || prior.mtimeMs !== value.mtimeMs) publish(classify(rel, 'changed'));
      }
      for (const rel of lastScan.keys()) if (!next.has(rel)) publish(classify(rel, 'removed'));
    }
    lastScan = next;
  } finally { scanBusy = false; }
}

async function serveStatic(req, res, pathname) {
  const route = staticRoutes.get(pathname);
  if (!route) return false;
  const [name, contentType] = route;
  try {
    const body = await fsp.readFile(path.join(publicRoot, name));
    res.writeHead(200, securityHeaders({ 'Content-Type': contentType, 'Content-Length': body.length }));
    if (req.method === 'HEAD') res.end(); else res.end(body);
  } catch (error) {
    sendJson(res, 500, { error: 'STATIC_ASSET_UNAVAILABLE', detail: error.message });
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      return sendJson(res, 405, { error: 'READ_ONLY_OBSERVER', message: 'OMEGA Observatory exposes no mutation methods.' });
    }
    if (await serveStatic(req, res, url.pathname)) return;
    if (url.pathname === '/api/health') return sendJson(res, 200, {
      format: 'JSONDB-OMEGA-OBSERVATORY-HEALTH-1',
      ok: true,
      authority: 'READ_ONLY_OBSERVER',
      host: HOST,
      port: PORT,
      scanMs: SCAN_MS,
      clients: clients.size
    });
    if (url.pathname === '/api/snapshot') return sendJson(res, 200, await snapshot());
    if (url.pathname === '/api/index-lab') {
      const result = await indexLab(url.searchParams.get('collection'));
      return sendJson(res, result.status, result.body);
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, securityHeaders({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }));
      res.write(`event: hello\ndata: ${JSON.stringify({ mode: 'LIVE', authority: 'READ_ONLY_OBSERVER', at: new Date().toISOString() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    return sendJson(res, 500, { error: 'OBSERVATORY_FAILURE', detail: error.message });
  }
});

server.listen(PORT, HOST, async () => {
  lastScan = await scanObserved();
  setInterval(poll, SCAN_MS).unref();
  process.stdout.write(`OMEGA OBSERVATORY\nhttp://${HOST}:${PORT}\nauthority=READ_ONLY_OBSERVER\nscan=${SCAN_MS}ms\n`);
});
