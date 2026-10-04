#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');
const { MonsterEngine } = require('./monster/engine');
const { SaviorSystem } = require('./monster/savior');
const { TemporalQuorumGuardian } = require('./monster/guardian');
const { QuantumInspiredLab } = require('./monster/quantum');
const { ExtinctionLab } = require('./monster/apocalypse');
const { readJson, readJsonl } = require('./monster/jsonfs');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.SAVIOR_PORT || 7334);

const engine = new MonsterEngine(ROOT);
const savior = new SaviorSystem(engine, { cells: 5 });
const guardian = new TemporalQuorumGuardian(savior);
const quantum = new QuantumInspiredLab(engine, savior);
const apocalypse = new ExtinctionLab(engine, savior);

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-jsondb-mode': 'last-savior'
  });
  res.end(body);
}

async function body(req, max = 10_000_000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > max) throw Object.assign(new Error('Body too large for SAVIOR control plane.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
}

async function status() {
  return {
    mode: 'JSONDB SAVIOR',
    disclaimer: 'Quantum-inspired means speculative deterministic execution, not quantum hardware or quantum algorithms.',
    engine: await engine.status(),
    savior: await savior.status(),
    witnessChain: await guardian.verifyChain(),
    mirrorWorld: await guardian.worldVerdict().catch(error => ({ healthy: false, error: error.message }))
  };
}

async function safeTransact(spec = {}) {
  await savior.assertWritable();
  const pre = await guardian.witnessRound('pre-transaction');
  const result = await engine.transact(spec.ops || [], { isolation: spec.isolation });
  const post = await guardian.witnessRound('post-transaction');
  return { result, witness: { pre: pre.roundHash, post: post.roundHash } };
}

async function panic(reason = 'operator initiated panic') {
  const capsule = await savior.capsule('panic');
  const witness = await guardian.witnessRound('panic-capsule');
  const state = await savior.setMode('panic', reason);
  return { state, capsule, witness: witness.roundHash };
}

async function api(req, res, url) {
  const p = url.pathname;
  if (p === '/api/savior/status' && req.method === 'GET') return json(res, 200, await status());
  if (p === '/api/savior/state' && req.method === 'GET') return json(res, 200, await savior.status());
  if (p === '/api/savior/journal' && req.method === 'GET') return json(res, 200, { events: (await readJsonl(savior.journal)).slice(-Math.min(500, Number(url.searchParams.get('limit') || 100))) });

  if (p === '/api/savior/guardian' && req.method === 'POST') return json(res, 200, await savior.guardianCycle(await body(req)));
  if (p === '/api/savior/witness' && req.method === 'POST') return json(res, 201, await guardian.witnessRound((await body(req)).label || 'operator'));
  if (p === '/api/savior/witness/verify' && req.method === 'POST') return json(res, 200, await guardian.verifyChain());
  if (p === '/api/savior/world-verdict' && req.method === 'GET') return json(res, 200, await guardian.worldVerdict());

  if (p === '/api/savior/mirrors/capture' && req.method === 'POST') return json(res, 201, await savior.captureMirrors());
  if (p === '/api/savior/mirrors/scrub' && req.method === 'POST') return json(res, 200, await savior.mirrors.scrub());
  if (p === '/api/savior/temporal/repair' && req.method === 'POST') {
    const b = await body(req);
    return json(res, 200, await guardian.repairFromTemporalVerdict(String(b.path || ''), b.options || {}));
  }

  if (p === '/api/savior/capsule' && req.method === 'POST') return json(res, 201, await savior.capsule((await body(req)).label || 'manual'));
  if (p === '/api/savior/catalog/infer' && req.method === 'GET') return json(res, 200, await savior.inferCatalog());
  if (p === '/api/savior/catalog/rebuild-sandbox' && req.method === 'POST') return json(res, 201, await savior.rebuildCatalogFromWorld());
  if (p === '/api/savior/canary' && req.method === 'POST') return json(res, 200, await savior.canary());

  if (p === '/api/savior/mode' && req.method === 'POST') {
    const b = await body(req);
    return json(res, 200, await savior.setMode(b.mode, b.reason));
  }
  if (p === '/api/savior/panic' && req.method === 'POST') return json(res, 200, await panic((await body(req)).reason));

  if (p === '/api/savior/tx' && req.method === 'POST') return json(res, 200, await safeTransact(await body(req)));
  if (p === '/api/savior/query' && req.method === 'POST') return json(res, 200, await engine.query(await body(req)));

  if (p === '/api/savior/quantum/superpose' && req.method === 'POST') return json(res, 200, await quantum.superpose(await body(req)));
  if (p === '/api/savior/quantum/collapse' && req.method === 'POST') return json(res, 200, await quantum.collapse(await body(req)));

  if (p === '/api/savior/extinction-drill' && req.method === 'POST') return json(res, 200, await apocalypse.run(await body(req)));
  if (p === '/api/savior/black-swan' && req.method === 'POST') return json(res, 200, await apocalypse.impossibleMode(await body(req)));

  const ark = p.match(/^\/api\/savior\/ark\/([^/]+)\/(verify|restore)$/);
  if (ark && req.method === 'POST') {
    if (ark[2] === 'verify') {
      const result = await savior.ark.verifyAndRepair(ark[1]);
      const { buffer, ...safe } = result;
      return json(res, 200, safe);
    }
    const b = await body(req);
    const target = path.join(savior.root, 'restore-sandboxes', String(b.file || `restored-${Date.now()}.json`).replace(/[^A-Za-z0-9_.-]/g, '_'));
    return json(res, 201, await savior.ark.restore(ark[1], target));
  }

  return json(res, 404, { error: 'SAVIOR endpoint not found.' });
}

async function serveStatic(res, url) {
  let rel = url.pathname === '/' ? 'savior.html' : url.pathname.replace(/^\/+/, '');
  rel = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'Path rejected.' });
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('not file');
    const ext = path.extname(file);
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch { json(res, 404, { error: 'File not found.' }); }
}

async function main() {
  await engine.init();
  await savior.init();
  await guardian.init();
  await apocalypse.init();
  if (!(await readJson(guardian.latest, null))) {
    await savior.captureMirrors();
    await guardian.witnessRound('genesis');
    await savior.capsule('genesis');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await serveStatic(res, url);
    } catch (error) {
      console.error('[SAVIOR]', error);
      json(res, error.status || 500, { error: error.message, stack: process.env.JSONDB_DEBUG ? error.stack : undefined });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log('\n╔════════════════════════════════════════════════════════════════╗');
    console.log('║ JSONDB SAVIOR MODE                                            ║');
    console.log('║ Assume JSON is the last surviving database format on Earth.   ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log(`Control plane : http://${HOST}:${PORT}`);
    console.log('Guardian      : quorum + temporal witnesses + circuit breaker');
    console.log('ARK           : parity shards + quarantine + recovery capsules');
    console.log('Quantum-ish   : triple execution + speculative world collapse');
    console.log('Apocalypse    : isolated destruction drills; canonical data untouched\n');
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
