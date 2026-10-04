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
const { OrthogonalArk } = require('./monster/orthogonal');
const { SemanticChronicle } = require('./monster/chronicle');
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
const orthogonal = new OrthogonalArk(engine, savior);
const chronicle = new SemanticChronicle(engine, path.join(savior.root, 'semantic-chronicle'));

function json(res, status, payload) {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-jsondb-mode': 'last-savior'
  });
  res.end(text);
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
    mirrorWorld: await guardian.worldVerdict().catch(error => ({ healthy: false, error: error.message })),
    semanticChronicle: await chronicle.verify().catch(error => ({ valid: false, error: error.message })),
    orthogonalLatest: await readJson(path.join(orthogonal.root, 'latest.json'), null)
  };
}

async function committedButSurvivalFailed(result, stage, error) {
  await savior.setMode('read-only', `Committed transaction ${result?.tx ?? '?'} failed post-commit survival stage ${stage}: ${error.message}`);
  throw Object.assign(new Error(`Transaction committed, but ${stage} failed. Future writes frozen: ${error.message}`), {
    status: 503, committed: true, tx: result?.tx, failedSurvivalStage: stage
  });
}

async function safeTransact(spec = {}) {
  await savior.assertWritable();
  const ops = Array.isArray(spec.ops) ? spec.ops : [];
  const chroniclePrepare = await chronicle.prepare(ops);
  const pre = await guardian.witnessRound('pre-transaction');
  const result = await engine.transact(ops, { isolation: spec.isolation });

  let chronicleEntry;
  try {
    chronicleEntry = await chronicle.commit(chroniclePrepare, ops, result, { survivalLevel: spec.survivalLevel || 'NORMAL' });
  } catch (error) {
    return committedButSurvivalFailed(result, 'semantic-chronicle-append', error);
  }

  let mirror;
  try {
    mirror = await savior.captureMirrors();
  } catch (error) {
    return committedButSurvivalFailed(result, 'mirror-capture', error);
  }

  let post;
  try {
    post = await guardian.witnessRound('post-transaction');
  } catch (error) {
    return committedButSurvivalFailed(result, 'temporal-witness', error);
  }

  let archive = null;
  if (String(spec.survivalLevel || '').toUpperCase() === 'MAXIMUM') {
    try { archive = await orthogonal.archive(`tx-${result.tx || Date.now()}`); }
    catch (error) { return committedButSurvivalFailed(result, 'orthogonal-archive', error); }
  }

  return {
    result,
    survivalProtocol: {
      semanticCommit: { sequence: chronicleEntry.sequence, entryHash: chronicleEntry.entryHash, worldRoot: chronicleEntry.afterRoot },
      preWitness: pre.roundHash,
      postWitness: post.roundHash,
      mirrorFiles: mirror.files?.length || 0,
      orthogonalArchive: archive
    }
  };
}

async function panic(reason = 'operator initiated panic') {
  const capsule = await savior.capsule('panic');
  const dualCode = await orthogonal.archive('panic');
  const witness = await guardian.witnessRound('panic-capsule');
  const state = await savior.setMode('panic', reason);
  return { state, capsule, orthogonal: dualCode, witness: witness.roundHash };
}

async function api(req, res, url) {
  const p = url.pathname;
  if (p === '/api/savior/status' && req.method === 'GET') return json(res, 200, await status());
  if (p === '/api/savior/state' && req.method === 'GET') return json(res, 200, await savior.status());
  if (p === '/api/savior/journal' && req.method === 'GET') return json(res, 200, { events: (await readJsonl(savior.journal)).slice(-Math.min(500, Number(url.searchParams.get('limit') || 100))) });
  if (p === '/api/savior/chronicle' && req.method === 'GET') return json(res, 200, await chronicle.verify());
  if (p === '/api/savior/chronicle/reset' && req.method === 'POST') return json(res, 201, await chronicle.resetGenesis((await body(req)).reason || 'operator reset'));

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
  if (p === '/api/savior/orthogonal/archive' && req.method === 'POST') return json(res, 201, await orthogonal.archive((await body(req)).label || 'manual'));
  if (p === '/api/savior/orthogonal/verify' && req.method === 'POST') return json(res, 200, await orthogonal.verify((await body(req)).id || null));
  if (p === '/api/savior/orthogonal/restore' && req.method === 'POST') {
    const b = await body(req);
    const target = path.join(savior.root, 'restore-sandboxes', String(b.file || `orthogonal-${Date.now()}.json`).replace(/[^A-Za-z0-9_.-]/g, '_'));
    return json(res, 201, await orthogonal.restore(target, b.id || null, { allowDegraded: b.allowDegraded === true }));
  }

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
  if (p === '/api/savior/quantum/collapse' && req.method === 'POST') {
    const spec = await body(req);
    const rehearsal = await quantum.superpose(spec);
    if (!rehearsal.winner || spec.dryRun !== false) return json(res, 200, { ...rehearsal, collapsed: false, dryRun: true });
    const protectedCommit = await safeTransact({ ops: rehearsal.winningOps || [], isolation: spec.isolation, survivalLevel: spec.survivalLevel });
    return json(res, 200, {
      ...rehearsal,
      collapsed: true,
      dryRun: false,
      collapse: {
        at: new Date().toISOString(),
        protectedCommit,
        winnerWorldHash: rehearsal.winner.worldHash,
        note: 'Winner committed through SAVIOR protected transaction path, not directly through QuantumInspiredLab.'
      }
    });
  }

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
  await orthogonal.init();
  await chronicle.init();
  if (!(await readJson(guardian.latest, null))) {
    await savior.captureMirrors();
    await guardian.witnessRound('genesis');
    await savior.capsule('genesis');
    await orthogonal.archive('genesis');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await serveStatic(res, url);
    } catch (error) {
      console.error('[SAVIOR]', error);
      json(res, error.status || 500, { error: error.message, stack: process.env.JSONDB_DEBUG ? error.stack : undefined, committed: error.committed, tx: error.tx, failedSurvivalStage: error.failedSurvivalStage });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log('\n╔════════════════════════════════════════════════════════════════╗');
    console.log('║ JSONDB SAVIOR MODE                                            ║');
    console.log('║ Assume JSON is the last surviving database format on Earth.   ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log(`Control plane : http://${HOST}:${PORT}`);
    console.log('Guardian      : quorum + temporal witnesses + circuit breaker');
    console.log('Chronicle     : independent semantic commit replay');
    console.log('ARK           : XOR parity + GF(256) 6+3 orthogonal erasure coding');
    console.log('Quantum-ish   : deterministic triple execution + protected collapse');
    console.log('Apocalypse    : isolated destruction drills; canonical data untouched\n');
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
