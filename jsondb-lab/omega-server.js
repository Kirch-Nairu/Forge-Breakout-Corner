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
const { OrthogonalArk } = require('./monster/orthogonal');
const { SemanticChronicle } = require('./monster/chronicle');
const { TruthLattice } = require('./monster/truth');
const { WitnessCouncil } = require('./monster/witnesses');
const { JsonImmuneSystem } = require('./monster/immune');
const { TrinityArk } = require('./monster/trinity');
const { SurvivorGenome } = require('./monster/genome');
const { FractalQuorum } = require('./monster/fractal');
const { MetamorphicVerifier } = require('./monster/metamorphic');
const { CrossHistoryBraid } = require('./monster/braid');
const { SurvivalOracle } = require('./monster/oracle');
const { SurvivalFabric } = require('./monster/fabric');
const { FailureDomainTrustBudget } = require('./monster/trustbudget');
const { ChallengeScrubber } = require('./monster/challenge');
const { MemoryPalace } = require('./monster/memorypalace');
const { NVersionMutationGuard } = require('./monster/nversion');
const { RepairConstitution } = require('./monster/repairpolicy');
const { ProtectedCommitCoordinator } = require('./monster/protected');
const { BootSentinel } = require('./monster/bootsentinel');
const { SovereignClock } = require('./monster/clockguard');
const { RuntimeGuard } = require('./monster/runtimeguard');
const { DurabilityRealityCheck } = require('./monster/durability');
const { HashPolyglot } = require('./monster/polyhash');
const { FormatPolyglotCapsule } = require('./monster/formatpolyglot');
const { FountainArk } = require('./monster/fountain');
const { CivilizationSeed } = require('./monster/seed');
const { readJson } = require('./monster/jsonfs');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.OMEGA_PORT || 7335);

const engine = new MonsterEngine(ROOT);
const savior = new SaviorSystem(engine, { cells: 5 });
const guardian = new TemporalQuorumGuardian(savior);
const orthogonal = new OrthogonalArk(engine, savior);
const chronicle = new SemanticChronicle(engine, path.join(savior.root, 'semantic-chronicle'));
const truth = new TruthLattice(savior, guardian, orthogonal);
const council = new WitnessCouncil(path.join(savior.root, 'witness-council'), 7, 5);
const immune = new JsonImmuneSystem(engine, path.join(savior.root, 'immune'));
const trinity = new TrinityArk(engine, savior);
const genome = new SurvivorGenome({ engine, savior, orthogonal, council });
const fractal = new FractalQuorum(savior);
const metamorphic = new MetamorphicVerifier(engine, savior);
const braid = new CrossHistoryBraid({ savior, guardian, chronicle, council, truth, immune, orthogonal, trinity });
const trustBudget = new FailureDomainTrustBudget();
const challenge = new ChallengeScrubber({ savior, braid });
const memory = new MemoryPalace(engine, savior, { vaults: 3 });
const nversion = new NVersionMutationGuard(engine, savior);
const repair = new RepairConstitution(engine, savior);
const oracle = new SurvivalOracle({ savior, guardian, truth, orthogonal, council, immune, chronicle, braid, trinity, genome });
const fabric = new SurvivalFabric({
  engine, savior, guardian, truth, council, immune, orthogonal, trinity,
  genome, fractal, metamorphic, chronicle, braid, oracle, trustBudget, challenge
});
const protectedCommit = new ProtectedCommitCoordinator({
  engine, savior, chronicle, guardian, council, orthogonal, braid,
  fabric, nversion, memoryPalace: memory
});

const bootSentinel = new BootSentinel(savior, { staleMs: 30_000 });
const sovereignClock = new SovereignClock(savior, { rollbackToleranceMs: 2_000 });
const runtime = new RuntimeGuard({ savior, bootSentinel, clock: sovereignClock, heartbeatMs: 10_000 });
const durability = new DurabilityRealityCheck(savior);
const polyhash = new HashPolyglot(path.join(savior.root, 'hash-polyglot'));
const formatCapsule = new FormatPolyglotCapsule(engine, savior);
const fountain = new FountainArk(path.join(savior.root, 'fountain-ark'));
const civilization = new CivilizationSeed({
  engine, savior, genome, council, braid, repair, polyhash,
  trinity, orthogonal, memoryPalace: memory, fountain, formatPolyglot: formatCapsule
});

function respond(res, status, payload) {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-jsondb-mode': 'omega-last-savior'
  });
  res.end(text);
}

async function parseBody(req, max = 16_000_000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > max) throw Object.assign(new Error('OMEGA request exceeded body limit.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
}

async function worldObject(label = 'omega-world') {
  const catalog = await engine.catalog();
  const meta = await engine.meta();
  const tables = {};
  for (const name of Object.keys(catalog.collections || {}).sort()) tables[name] = await engine.loadCurrent(name);
  return { format: 'JSONDB-OMEGA-WORLD-1', label, catalog, meta, tables };
}

async function worldBuffer(label = 'omega-world') {
  return Buffer.from(JSON.stringify(await worldObject(label)));
}

async function omegaStatus(deep = false) {
  const [fabricStatus, runtimeStatus, clockAudit, seedLatest, formatLatest, fountainLatest] = await Promise.all([
    fabric.status({ deep }).catch(error => ({ error: error.message })),
    runtime.status().catch(error => ({ error: error.message })),
    sovereignClock.audit({ freezeOnRollback: false }).catch(error => ({ error: error.message })),
    readJson(path.join(civilization.root, 'latest.json'), null),
    readJson(path.join(formatCapsule.root, 'latest.json'), null),
    readJson(path.join(fountain.root, 'latest.json'), null)
  ]);
  return {
    format: 'JSONDB-OMEGA-STATUS-1',
    mode: (await savior.status()).mode,
    doctrine: 'OMEGA treats runtime continuity, time, filesystem durability, representation diversity, and recovery-tool survivability as first-class database state.',
    engine: await engine.status(),
    fabric: fabricStatus.summary || fabricStatus,
    runtime: runtimeStatus,
    sovereignClock: clockAudit,
    recoveryMedia: {
      civilizationSeed: seedLatest,
      formatPolyglot: formatLatest,
      fountainArk: fountainLatest,
      memoryPalace: await readJson(path.join(memory.root, 'latest.json'), null)
    },
    hashPolicy: await polyhash.init()
  };
}

async function api(req, res, url) {
  const p = url.pathname;

  if (p === '/api/omega/status' && req.method === 'GET') return respond(res, 200, await omegaStatus(url.searchParams.get('deep') === '1'));
  if (p === '/api/omega/tx' && req.method === 'POST') return respond(res, 200, await protectedCommit.transact(await parseBody(req)));
  if (p === '/api/omega/query' && req.method === 'POST') return respond(res, 200, await engine.query(await parseBody(req)));

  if (p === '/api/omega/runtime/status' && req.method === 'GET') return respond(res, 200, await runtime.status());
  if (p === '/api/omega/runtime/heartbeat' && req.method === 'POST') return respond(res, 200, await runtime.heartbeat());
  if (p === '/api/omega/clock/audit' && req.method === 'POST') return respond(res, 200, await sovereignClock.audit(await parseBody(req)));
  if (p === '/api/omega/clock/acknowledge' && req.method === 'POST') return respond(res, 200, await sovereignClock.acknowledge((await parseBody(req)).reason));
  if (p === '/api/omega/durability/probe' && req.method === 'POST') return respond(res, 200, await durability.probe(await parseBody(req)));

  if (p === '/api/omega/oracle/assess' && req.method === 'POST') return respond(res, 200, await oracle.assess(await parseBody(req)));
  if (p === '/api/omega/oracle/enforce' && req.method === 'POST') return respond(res, 200, await oracle.enforce(await parseBody(req)));
  if (p === '/api/omega/fabric/status' && req.method === 'GET') return respond(res, 200, await fabric.status({ deep: url.searchParams.get('deep') === '1' }));
  if (p === '/api/omega/fabric/seal' && req.method === 'POST') { const b = await parseBody(req); return respond(res, 201, await fabric.seal(b.label || 'omega-seal', b)); }
  if (p === '/api/omega/fabric/recovery-case' && req.method === 'POST') return respond(res, 200, await fabric.recoveryCase(await parseBody(req)));
  if (p === '/api/omega/fabric/emergency-seal' && req.method === 'POST') return respond(res, 200, await fabric.emergencySeal((await parseBody(req)).reason || 'OMEGA emergency seal'));

  if (p === '/api/omega/hash/policy' && req.method === 'GET') return respond(res, 200, await polyhash.init());
  if (p === '/api/omega/hash/envelope' && req.method === 'POST') { const b = await parseBody(req); return respond(res, 200, await polyhash.envelope(b.value, b.metadata || {})); }
  if (p === '/api/omega/hash/verify' && req.method === 'POST') { const b = await parseBody(req); return respond(res, 200, await polyhash.verify(b.value, b.envelope)); }
  if (p === '/api/omega/hash/rotate' && req.method === 'POST') { const b = await parseBody(req); return respond(res, 200, await polyhash.rotatePolicy(b.active, b.minimumIndependentDigests, b.reason)); }

  if (p === '/api/omega/format/archive' && req.method === 'POST') return respond(res, 201, await formatCapsule.archive((await parseBody(req)).label || 'omega-format'));
  if (p === '/api/omega/format/verify' && req.method === 'POST') { const result = await formatCapsule.verify((await parseBody(req)).id || null); delete result._worlds; return respond(res, 200, result); }
  if (p === '/api/omega/format/restore' && req.method === 'POST') {
    const b = await parseBody(req);
    const target = path.join(savior.root, 'restore-sandboxes', String(b.file || `format-${Date.now()}.json`).replace(/[^A-Za-z0-9_.-]/g, '_'));
    return respond(res, 201, await formatCapsule.restore(target, b.id || null, { allowDegraded: b.allowDegraded === true }));
  }

  if (p === '/api/omega/fountain/archive' && req.method === 'POST') {
    const b = await parseBody(req);
    return respond(res, 201, await fountain.archiveBuffer(b.label || 'omega-fountain', await worldBuffer(b.label || 'omega-fountain'), b));
  }
  if (p === '/api/omega/fountain/recover' && req.method === 'POST') {
    const b = await parseBody(req);
    const directory = b.directory ? path.resolve(b.directory) : path.join(fountain.generations, String(b.generation || ''));
    const result = await fountain.recoverDirectory(directory);
    delete result.buffer;
    return respond(res, 200, result);
  }
  if (p === '/api/omega/fountain/restore' && req.method === 'POST') {
    const b = await parseBody(req);
    const directory = b.directory ? path.resolve(b.directory) : path.join(fountain.generations, String(b.generation || ''));
    const target = path.join(savior.root, 'restore-sandboxes', String(b.file || `fountain-${Date.now()}.json`).replace(/[^A-Za-z0-9_.-]/g, '_'));
    return respond(res, 201, await fountain.restoreDirectory(directory, target));
  }

  if (p === '/api/omega/memory/snapshot' && req.method === 'POST') return respond(res, 201, await memory.snapshot((await parseBody(req)).label || 'omega-memory'));
  if (p === '/api/omega/memory/verify' && req.method === 'POST') { const result = await memory.verify((await parseBody(req)).id || null); delete result._buffer; return respond(res, 200, result); }
  if (p === '/api/omega/memory/ancestry' && req.method === 'GET') return respond(res, 200, { snapshots: await memory.ancestry(Number(url.searchParams.get('limit') || 100)) });

  if (p === '/api/omega/seed/create' && req.method === 'POST') return respond(res, 201, await civilization.create((await parseBody(req)).label || 'omega-seed'));
  if (p === '/api/omega/seed/verify' && req.method === 'POST') return respond(res, 200, await civilization.verify((await parseBody(req)).id || null));

  if (p === '/api/omega/repair/constitution' && req.method === 'GET') return respond(res, 200, await repair.init());
  if (p === '/api/omega/repair/propose' && req.method === 'POST') return respond(res, 201, await repair.propose(await parseBody(req)));

  if (p === '/api/omega/challenge' && req.method === 'POST') return respond(res, 200, await challenge.challenge(await parseBody(req)));
  if (p === '/api/omega/trust-budget' && req.method === 'POST') return respond(res, 200, trustBudget.evaluate(await oracle.assess(await parseBody(req))));
  if (p === '/api/omega/fractal' && req.method === 'POST') return respond(res, 200, await fractal.reconstruct(String((await parseBody(req)).path || 'current/tasks.json')));
  if (p === '/api/omega/metamorphic' && req.method === 'POST') { const b = await parseBody(req); return respond(res, 200, await fabric.verifyQuery(b.query || b, { freezeOnMismatch: b.freezeOnMismatch !== false })); }
  if (p === '/api/omega/nversion' && req.method === 'POST') { const b = await parseBody(req); return respond(res, 200, await nversion.preflight(b.ops || [], { freezeOnDivergence: b.freezeOnDivergence !== false })); }

  return respond(res, 404, { error: 'OMEGA endpoint not found.' });
}

async function serveStatic(res, url) {
  let rel = url.pathname === '/' ? 'savior.html' : url.pathname.replace(/^\/+/, '');
  rel = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return respond(res, 403, { error: 'Path rejected.' });
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('not file');
    const ext = path.extname(file);
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch { respond(res, 404, { error: 'File not found.' }); }
}

let server = null;
let shuttingDown = false;

async function graceful(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  await runtime.shutdown(`OMEGA received ${signal}`).catch(() => {});
  if (server) server.close(() => { process.exitCode = 0; });
}

async function main() {
  await engine.init();
  await fabric.init();
  await memory.init();
  await repair.init();
  await polyhash.init();
  await formatCapsule.init();
  await fountain.init();
  await civilization.init();
  await runtime.begin({ server: 'omega-server', host: HOST, port: PORT });
  runtime.startHeartbeat();

  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await serveStatic(res, url);
    } catch (error) {
      console.error('[OMEGA]', error);
      respond(res, error.status || 500, {
        error: error.message,
        stack: process.env.JSONDB_DEBUG ? error.stack : undefined,
        committed: error.committed,
        tx: error.tx,
        failedSurvivalStage: error.failedSurvivalStage
      });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log('\n╔════════════════════════════════════════════════════════════════╗');
    console.log('║ JSONDB OMEGA MODE                                             ║');
    console.log('║ If JSON is the final surviving database, OMEGA guards runtime.║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log(`Control plane : http://${HOST}:${PORT}`);
    console.log('Boot Sentinel : dirty restart + concurrent-owner detection');
    console.log('Clock         : persistent logical chronology + rollback detection');
    console.log('Durability    : sacrificial filesystem primitive probe on demand');
    console.log('Polyglot      : hash agility + four representation decoders');
    console.log('Fountain      : manifestless self-describing recovery droplets');
    console.log('Seed          : cold-storage self-describing civilization bootstrap');
    console.log('Protected tx  : N-version preflight → canonical commit → survival fabric\n');
  });
}

process.on('SIGINT', () => graceful('SIGINT'));
process.on('SIGTERM', () => graceful('SIGTERM'));

main().catch(async error => {
  console.error(error);
  await runtime.shutdown('OMEGA startup failure').catch(() => {});
  process.exitCode = 1;
});
