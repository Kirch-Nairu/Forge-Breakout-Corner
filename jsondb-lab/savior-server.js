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
const truth = new TruthLattice(savior, guardian, orthogonal);
const council = new WitnessCouncil(path.join(savior.root, 'witness-council'), 7, 5);
const immune = new JsonImmuneSystem(engine, path.join(savior.root, 'immune'));
const trinity = new TrinityArk(engine, savior);
const genome = new SurvivorGenome({ engine, savior, orthogonal, council });
const fractal = new FractalQuorum(savior);
const metamorphic = new MetamorphicVerifier(engine, savior);
const braid = new CrossHistoryBraid({ savior, guardian, chronicle, council, truth, immune, orthogonal, trinity });
const oracle = new SurvivalOracle({ savior, guardian, truth, orthogonal, council, immune, chronicle, braid, trinity, genome });
const fabric = new SurvivalFabric({
  engine, savior, guardian, truth, council, immune, orthogonal, trinity,
  genome, fractal, metamorphic, chronicle, braid, oracle
});

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
  const fabricStatus = await fabric.status({ deep: false }).catch(error => ({ error: error.message }));
  return {
    mode: 'JSONDB SAVIOR',
    disclaimer: 'Quantum-inspired means speculative deterministic execution, not quantum hardware or quantum algorithms.',
    engine: await engine.status(),
    savior: await savior.status(),
    fabric: fabricStatus.summary || fabricStatus,
    oracle: fabricStatus.oracle ? { verdict: fabricStatus.oracle.verdict, confidence: fabricStatus.oracle.confidence, contradictions: fabricStatus.oracle.contradictions } : null,
    witnessChain: await guardian.verifyChain(),
    mirrorWorld: await guardian.worldVerdict().catch(error => ({ healthy: false, error: error.message })),
    semanticChronicle: await chronicle.verify().catch(error => ({ valid: false, error: error.message })),
    crossHistoryBraid: await braid.verify().catch(error => ({ valid: false, error: error.message })),
    orthogonalLatest: await readJson(path.join(orthogonal.root, 'latest.json'), null),
    trinityLatest: await readJson(path.join(trinity.root, 'latest.json'), null)
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
  const survivalLevel = String(spec.survivalLevel || 'NORMAL').toUpperCase();
  const chroniclePrepare = await chronicle.prepare(ops);
  const pre = await guardian.witnessRound('pre-transaction');
  const result = await engine.transact(ops, { isolation: spec.isolation });

  let chronicleEntry;
  try {
    chronicleEntry = await chronicle.commit(chroniclePrepare, ops, result, { survivalLevel });
  } catch (error) {
    return committedButSurvivalFailed(result, 'semantic-chronicle-append', error);
  }

  let mirror;
  try { mirror = await savior.captureMirrors(); }
  catch (error) { return committedButSurvivalFailed(result, 'mirror-capture', error); }

  let post;
  try { post = await guardian.witnessRound('post-transaction'); }
  catch (error) { return committedButSurvivalFailed(result, 'temporal-witness', error); }

  let signed;
  try {
    signed = await council.round(post.worldRoot, { tx: result.tx, survivalLevel, temporalEpoch: post.epoch, temporalRoundHash: post.roundHash });
  } catch (error) {
    return committedButSurvivalFailed(result, 'signed-witness-council', error);
  }

  let archive = null;
  if (['MAXIMUM','ULTIMATE'].includes(survivalLevel)) {
    try { archive = await orthogonal.archive(`tx-${result.tx || Date.now()}`); }
    catch (error) { return committedButSurvivalFailed(result, 'orthogonal-archive', error); }
  }

  let fabricSeal = null;
  if (survivalLevel === 'ULTIMATE') {
    try {
      fabricSeal = await fabric.seal(`tx-${result.tx}`, {
        level: 'ULTIMATE', trinity: true, genome: true, verifyArchives: false
      });
    } catch (error) {
      return committedButSurvivalFailed(result, 'ultimate-fabric-seal', error);
    }
  } else {
    try {
      const epoch = await braid.weave(`tx-${result.tx}`, { verifyChronicle: true });
      if (epoch.contradictions?.length) await savior.setMode('read-only', `Cross-history contradiction after tx ${result.tx}`);
      fabricSeal = { braid: { sequence: epoch.sequence, epochHash: epoch.epochHash, contradictions: epoch.contradictions } };
    } catch (error) {
      return committedButSurvivalFailed(result, 'cross-history-braid', error);
    }
  }

  if (Array.isArray(spec.verifyQueries)) {
    for (const query of spec.verifyQueries.slice(0, 25)) {
      const check = await fabric.verifyQuery(query, { freezeOnMismatch: true });
      if (!check.match) return committedButSurvivalFailed(result, 'metamorphic-query-verification', new Error(`Query disagreement ${check.optimizedHash} != ${check.referenceHash}`));
    }
  }

  return {
    result,
    survivalProtocol: {
      level: survivalLevel,
      semanticCommit: { sequence: chronicleEntry.sequence, entryHash: chronicleEntry.entryHash, worldRoot: chronicleEntry.afterRoot },
      preWitness: pre.roundHash,
      postWitness: post.roundHash,
      signedWitnessCouncil: { valid: signed.valid, validSignatures: signed.validSignatures, threshold: signed.threshold, roundId: signed.statement?.roundId },
      mirrorFiles: mirror.files?.length || 0,
      orthogonalArchive: archive,
      fabricSeal
    }
  };
}

async function panic(reason = 'operator initiated panic') {
  const capsule = await savior.capsule('panic');
  const dualCode = await orthogonal.archive('panic');
  const trinityArchive = await trinity.archive('panic');
  const genomeArchive = await genome.create('panic');
  const temporal = await guardian.witnessRound('panic-capsule');
  const signed = await council.round(temporal.worldRoot, { panic: true, reason, temporalRoundHash: temporal.roundHash });
  const braidEpoch = await braid.weave('panic-capsule').catch(error => ({ error: error.message }));
  const state = await savior.setMode('panic', reason);
  return {
    state, capsule, orthogonal: dualCode, trinity: trinityArchive, genome: genomeArchive,
    witness: temporal.roundHash, signedWitness: { valid: signed.valid, validSignatures: signed.validSignatures, threshold: signed.threshold },
    braid: braidEpoch
  };
}

async function api(req, res, url) {
  const p = url.pathname;
  if (p === '/api/savior/status' && req.method === 'GET') return json(res, 200, await status());
  if (p === '/api/savior/state' && req.method === 'GET') return json(res, 200, await savior.status());
  if (p === '/api/savior/journal' && req.method === 'GET') return json(res, 200, { events: (await readJsonl(savior.journal)).slice(-Math.min(500, Number(url.searchParams.get('limit') || 100))) });

  if (p === '/api/savior/fabric/status' && req.method === 'GET') return json(res, 200, await fabric.status({ deep: url.searchParams.get('deep') === '1' }));
  if (p === '/api/savior/fabric/seal' && req.method === 'POST') {
    const b = await body(req); return json(res, 201, await fabric.seal(b.label || 'operator-seal', b));
  }
  if (p === '/api/savior/fabric/recovery-case' && req.method === 'POST') return json(res, 200, await fabric.recoveryCase(await body(req)));
  if (p === '/api/savior/fabric/emergency-seal' && req.method === 'POST') return json(res, 200, await fabric.emergencySeal((await body(req)).reason || 'operator emergency seal'));

  if (p === '/api/savior/oracle/assess' && req.method === 'POST') return json(res, 200, await oracle.assess(await body(req)));
  if (p === '/api/savior/oracle/enforce' && req.method === 'POST') return json(res, 200, await oracle.enforce(await body(req)));

  if (p === '/api/savior/chronicle' && req.method === 'GET') return json(res, 200, await chronicle.verify());
  if (p === '/api/savior/chronicle/reset' && req.method === 'POST') return json(res, 201, await chronicle.resetGenesis((await body(req)).reason || 'operator reset'));

  if (p === '/api/savior/braid' && req.method === 'GET') return json(res, 200, await braid.verify());
  if (p === '/api/savior/braid/quorum' && req.method === 'GET') return json(res, 200, await braid.quorumHead());
  if (p === '/api/savior/braid/weave' && req.method === 'POST') return json(res, 201, await braid.weave((await body(req)).label || 'operator-braid'));

  if (p === '/api/savior/guardian' && req.method === 'POST') return json(res, 200, await savior.guardianCycle(await body(req)));
  if (p === '/api/savior/witness' && req.method === 'POST') return json(res, 201, await guardian.witnessRound((await body(req)).label || 'operator'));
  if (p === '/api/savior/witness/verify' && req.method === 'POST') return json(res, 200, await guardian.verifyChain());
  if (p === '/api/savior/witness-council/attest' && req.method === 'POST') {
    const b = await body(req); const temporal = await guardian.witnessRound(b.label || 'signed-attestation');
    return json(res, 201, await council.round(temporal.worldRoot, { temporalRoundHash: temporal.roundHash, label: b.label || 'signed-attestation' }));
  }
  if (p === '/api/savior/witness-council/verify' && req.method === 'POST') return json(res, 200, await council.verifyRound((await body(req)).roundId || null));
  if (p === '/api/savior/world-verdict' && req.method === 'GET') return json(res, 200, await truth.worldVerdict());

  if (p === '/api/savior/immune/learn' && req.method === 'POST') return json(res, 201, await immune.learn((await body(req)).label || 'operator-trusted'));
  if (p === '/api/savior/immune/scan' && req.method === 'GET') return json(res, 200, await immune.scan(url.searchParams.get('profile') || null));

  if (p === '/api/savior/metamorphic' && req.method === 'POST') {
    const b = await body(req); return json(res, 200, await fabric.verifyQuery(b.query || b, { freezeOnMismatch: b.freezeOnMismatch !== false }));
  }

  if (p === '/api/savior/mirrors/capture' && req.method === 'POST') return json(res, 201, await savior.captureMirrors());
  if (p === '/api/savior/mirrors/scrub' && req.method === 'POST') return json(res, 200, await savior.mirrors.scrub());
  if (p === '/api/savior/temporal/repair' && req.method === 'POST') {
    const b = await body(req);
    return json(res, 200, await guardian.repairFromTemporalVerdict(String(b.path || ''), b.options || {}));
  }
  if (p === '/api/savior/fractal' && req.method === 'POST') return json(res, 200, await fractal.reconstruct(String((await body(req)).path || 'current/tasks.json')));

  if (p === '/api/savior/capsule' && req.method === 'POST') return json(res, 201, await savior.capsule((await body(req)).label || 'manual'));
  if (p === '/api/savior/orthogonal/archive' && req.method === 'POST') return json(res, 201, await orthogonal.archive((await body(req)).label || 'manual'));
  if (p === '/api/savior/orthogonal/verify' && req.method === 'POST') return json(res, 200, await orthogonal.verify((await body(req)).id || null));
  if (p === '/api/savior/orthogonal/restore' && req.method === 'POST') {
    const b = await body(req);
    const target = path.join(savior.root, 'restore-sandboxes', String(b.file || `orthogonal-${Date.now()}.json`).replace(/[^A-Za-z0-9_.-]/g, '_'));
    return json(res, 201, await orthogonal.restore(target, b.id || null, { allowDegraded: b.allowDegraded === true }));
  }

  if (p === '/api/savior/trinity/archive' && req.method === 'POST') return json(res, 201, await trinity.archive((await body(req)).label || 'manual'));
  if (p === '/api/savior/trinity/verify' && req.method === 'POST') {
    const result = await trinity.verify((await body(req)).id || null); delete result._buffers; return json(res, 200, result);
  }
  if (p === '/api/savior/trinity/restore' && req.method === 'POST') {
    const b = await body(req);
    const target = path.join(savior.root, 'restore-sandboxes', String(b.file || `trinity-${Date.now()}.json`).replace(/[^A-Za-z0-9_.-]/g, '_'));
    return json(res, 201, await trinity.restore(target, b.id || null, { allowDegraded: b.allowDegraded === true }));
  }

  if (p === '/api/savior/genome/create' && req.method === 'POST') return json(res, 201, await genome.create((await body(req)).label || 'manual'));
  if (p === '/api/savior/genome/verify' && req.method === 'POST') return json(res, 200, await genome.verify((await body(req)).file || null));
  if (p === '/api/savior/genome/extract' && req.method === 'POST') {
    const b = await body(req); const target = path.join(savior.root, 'restore-sandboxes', String(b.directory || `genome-${Date.now()}`).replace(/[^A-Za-z0-9_.-]/g, '_'));
    return json(res, 201, await genome.extract(target, b.file || null));
  }

  if (p === '/api/savior/catalog/infer' && req.method === 'GET') return json(res, 200, await savior.inferCatalog());
  if (p === '/api/savior/catalog/rebuild-sandbox' && req.method === 'POST') return json(res, 201, await savior.rebuildCatalogFromWorld());
  if (p === '/api/savior/canary' && req.method === 'POST') return json(res, 200, await savior.canary());

  if (p === '/api/savior/mode' && req.method === 'POST') {
    const b = await body(req); return json(res, 200, await savior.setMode(b.mode, b.reason));
  }
  if (p === '/api/savior/panic' && req.method === 'POST') return json(res, 200, await panic((await body(req)).reason));

  if (p === '/api/savior/tx' && req.method === 'POST') return json(res, 200, await safeTransact(await body(req)));
  if (p === '/api/savior/query' && req.method === 'POST') return json(res, 200, await engine.query(await body(req)));

  if (p === '/api/savior/quantum/superpose' && req.method === 'POST') return json(res, 200, await quantum.superpose(await body(req)));
  if (p === '/api/savior/quantum/collapse' && req.method === 'POST') {
    const spec = await body(req);
    const rehearsal = await quantum.superpose(spec);
    if (!rehearsal.winner || spec.dryRun !== false) return json(res, 200, { ...rehearsal, collapsed: false, dryRun: true });
    const protectedCommit = await safeTransact({
      ops: rehearsal.winningOps || [], isolation: spec.isolation,
      survivalLevel: spec.survivalLevel || 'ULTIMATE', verifyQueries: spec.verifyQueries
    });
    return json(res, 200, {
      ...rehearsal,
      collapsed: true,
      dryRun: false,
      collapse: {
        at: new Date().toISOString(), protectedCommit,
        winnerWorldHash: rehearsal.winner.worldHash,
        note: 'Winner committed through SAVIOR protected transaction path, then survival-sealed. Quantum-inspired only; no quantum hardware.'
      }
    });
  }

  if (p === '/api/savior/extinction-drill' && req.method === 'POST') return json(res, 200, await apocalypse.run(await body(req)));
  if (p === '/api/savior/black-swan' && req.method === 'POST') return json(res, 200, await apocalypse.impossibleMode(await body(req)));

  const ark = p.match(/^\/api\/savior\/ark\/([^/]+)\/(verify|restore)$/);
  if (ark && req.method === 'POST') {
    if (ark[2] === 'verify') {
      const result = await savior.ark.verifyAndRepair(ark[1]);
      const { buffer, ...safe } = result; return json(res, 200, safe);
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

async function bootstrapGenesis() {
  if (await readJson(guardian.latest, null)) return;
  await savior.captureMirrors();
  const temporal = await guardian.witnessRound('genesis');
  await council.round(temporal.worldRoot, { genesis: true, temporalRoundHash: temporal.roundHash });
  await savior.capsule('genesis');
  await orthogonal.archive('genesis');
  await trinity.archive('genesis');
  await genome.create('genesis');
  await braid.weave('genesis');
}

async function main() {
  await engine.init();
  await apocalypse.init();
  await fabric.init();
  await bootstrapGenesis();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await serveStatic(res, url);
    } catch (error) {
      console.error('[SAVIOR]', error);
      json(res, error.status || 500, {
        error: error.message,
        stack: process.env.JSONDB_DEBUG ? error.stack : undefined,
        committed: error.committed, tx: error.tx,
        failedSurvivalStage: error.failedSurvivalStage
      });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log('\n╔════════════════════════════════════════════════════════════════╗');
    console.log('║ JSONDB SAVIOR MODE                                            ║');
    console.log('║ Assume JSON is the last surviving database format on Earth.   ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log(`Control plane : http://${HOST}:${PORT}`);
    console.log('Fabric        : coordinated epoch seals + recovery dossiers');
    console.log('Oracle        : cross-domain trust adjudication');
    console.log('Guardian      : quorum + temporal witnesses + circuit breaker');
    console.log('Chronicle     : independent semantic commit replay');
    console.log('Braid         : cross-anchored independent history heads');
    console.log('ARK           : XOR + GF(256) + Trinity decoder quorum');
    console.log('Quantum-ish   : deterministic triple execution + protected collapse');
    console.log('Apocalypse    : isolated destruction drills; canonical data untouched\n');
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
