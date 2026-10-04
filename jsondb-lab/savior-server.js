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
const { FailureDomainTrustBudget } = require('./monster/trustbudget');
const { ChallengeScrubber } = require('./monster/challenge');
const { MemoryPalace } = require('./monster/memorypalace');
const { NVersionMutationGuard } = require('./monster/nversion');
const { RepairConstitution } = require('./monster/repairpolicy');
const { ProtectedCommitCoordinator } = require('./monster/protected');
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
const trustBudget = new FailureDomainTrustBudget();
const challenge = new ChallengeScrubber({ savior, braid });
const memoryPalace = new MemoryPalace(engine, savior, { vaults: 3 });
const nversion = new NVersionMutationGuard(engine, savior);
const repair = new RepairConstitution(engine, savior);
const oracle = new SurvivalOracle({ savior, guardian, truth, orthogonal, council, immune, chronicle, braid, trinity, genome });
const fabric = new SurvivalFabric({
  engine, savior, guardian, truth, council, immune, orthogonal, trinity,
  genome, fractal, metamorphic, chronicle, braid, oracle, trustBudget, challenge
});
const protectedCommit = new ProtectedCommitCoordinator({
  engine, savior, chronicle, guardian, council, orthogonal, braid,
  fabric, nversion, memoryPalace
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
    trustBudget: fabricStatus.trustBudget || null,
    challengeCoverage: fabricStatus.challengeCoverage || null,
    witnessChain: await guardian.verifyChain(),
    mirrorWorld: await guardian.worldVerdict().catch(error => ({ healthy: false, error: error.message })),
    semanticChronicle: await chronicle.verify().catch(error => ({ valid: false, error: error.message })),
    crossHistoryBraid: await braid.verify().catch(error => ({ valid: false, error: error.message })),
    memoryPalaceLatest: await readJson(path.join(memoryPalace.root, 'latest.json'), null),
    orthogonalLatest: await readJson(path.join(orthogonal.root, 'latest.json'), null),
    trinityLatest: await readJson(path.join(trinity.root, 'latest.json'), null)
  };
}

async function safeTransact(spec = {}) { return protectedCommit.transact(spec); }

async function panic(reason = 'operator initiated panic') {
  const capsule = await savior.capsule('panic');
  const dualCode = await orthogonal.archive('panic');
  const trinityArchive = await trinity.archive('panic');
  const genomeArchive = await genome.create('panic');
  const memory = await memoryPalace.snapshot('panic');
  const temporal = await guardian.witnessRound('panic-capsule');
  const signed = await council.round(temporal.worldRoot, { panic: true, reason, temporalRoundHash: temporal.roundHash });
  const braidEpoch = await braid.weave('panic-capsule').catch(error => ({ error: error.message }));
  const challengeRound = await challenge.challenge({ perFile: 16, freezeOnFailure: false }).catch(error => ({ error: error.message }));
  const state = await savior.setMode('panic', reason);
  return {
    state, capsule, orthogonal: dualCode, trinity: trinityArchive, genome: genomeArchive, memoryPalace: memory,
    witness: temporal.roundHash, signedWitness: { valid: signed.valid, validSignatures: signed.validSignatures, threshold: signed.threshold },
    braid: braidEpoch, challenge: challengeRound
  };
}

async function api(req, res, url) {
  const p = url.pathname;
  if (p === '/api/savior/status' && req.method === 'GET') return json(res, 200, await status());
  if (p === '/api/savior/state' && req.method === 'GET') return json(res, 200, await savior.status());
  if (p === '/api/savior/journal' && req.method === 'GET') return json(res, 200, { events: (await readJsonl(savior.journal)).slice(-Math.min(500, Number(url.searchParams.get('limit') || 100))) });

  if (p === '/api/savior/fabric/status' && req.method === 'GET') return json(res, 200, await fabric.status({ deep: url.searchParams.get('deep') === '1' }));
  if (p === '/api/savior/fabric/seal' && req.method === 'POST') { const b = await body(req); return json(res, 201, await fabric.seal(b.label || 'operator-seal', b)); }
  if (p === '/api/savior/fabric/recovery-case' && req.method === 'POST') return json(res, 200, await fabric.recoveryCase(await body(req)));
  if (p === '/api/savior/fabric/emergency-seal' && req.method === 'POST') return json(res, 200, await fabric.emergencySeal((await body(req)).reason || 'operator emergency seal'));

  if (p === '/api/savior/oracle/assess' && req.method === 'POST') return json(res, 200, await oracle.assess(await body(req)));
  if (p === '/api/savior/oracle/enforce' && req.method === 'POST') return json(res, 200, await oracle.enforce(await body(req)));
  if (p === '/api/savior/trust-budget' && req.method === 'POST') return json(res, 200, trustBudget.evaluate(await oracle.assess(await body(req))));

  if (p === '/api/savior/challenge' && req.method === 'POST') return json(res, 200, await challenge.challenge(await body(req)));
  if (p === '/api/savior/challenge/coverage' && req.method === 'GET') return json(res, 200, await challenge.coverage());

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
  if (p === '/api/savior/nversion/preflight' && req.method === 'POST') return json(res, 200, await nversion.preflight((await body(req)).ops || [], { freezeOnDivergence: false }));

  if (p === '/api/savior/memory/snapshot' && req.method === 'POST') return json(res, 201, await memoryPalace.snapshot((await body(req)).label || 'manual'));
  if (p === '/api/savior/memory/verify' && req.method === 'POST') {
    const result = await memoryPalace.verify((await body(req)).id || null); delete result._buffer; return json(res, 200, result);
  }
  if (p === '/api/savior/memory/restore' && req.method === 'POST') {
    const b = await body(req); const target = path.join(savior.root, 'restore-sandboxes', String(b.file || `memory-${Date.now()}.json`).replace(/[^A-Za-z0-9_.-]/g, '_'));
    return json(res, 201, await memoryPalace.restore(target, b.id || null));
  }
  if (p === '/api/savior/memory/ancestry' && req.method === 'GET') return json(res, 200, { snapshots: await memoryPalace.ancestry(Number(url.searchParams.get('limit') || 100)) });
  if (p === '/api/savior/memory/gc-plan' && req.method === 'GET') return json(res, 200, await memoryPalace.gcPlan());

  if (p === '/api/savior/repair/constitution' && req.method === 'GET') return json(res, 200, await repair.init());
  if (p === '/api/savior/repair/propose' && req.method === 'POST') return json(res, 201, await repair.propose(await body(req)));
  if (p === '/api/savior/repair/verify' && req.method === 'POST') return json(res, 200, await repair.verifyProposal((await body(req)).id));

  if (p === '/api/savior/mirrors/capture' && req.method === 'POST') return json(res, 201, await savior.captureMirrors());
  if (p === '/api/savior/mirrors/scrub' && req.method === 'POST') return json(res, 200, await savior.mirrors.scrub());
  if (p === '/api/savior/temporal/repair' && req.method === 'POST') {
    const b = await body(req); return json(res, 200, await guardian.repairFromTemporalVerdict(String(b.path || ''), b.options || {}));
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
  if (p === '/api/savior/trinity/verify' && req.method === 'POST') { const result = await trinity.verify((await body(req)).id || null); delete result._buffers; return json(res, 200, result); }
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

  if (p === '/api/savior/mode' && req.method === 'POST') { const b = await body(req); return json(res, 200, await savior.setMode(b.mode, b.reason)); }
  if (p === '/api/savior/panic' && req.method === 'POST') return json(res, 200, await panic((await body(req)).reason));

  if (p === '/api/savior/tx' && req.method === 'POST') return json(res, 200, await safeTransact(await body(req)));
  if (p === '/api/savior/query' && req.method === 'POST') return json(res, 200, await engine.query(await body(req)));

  if (p === '/api/savior/quantum/superpose' && req.method === 'POST') return json(res, 200, await quantum.superpose(await body(req)));
  if (p === '/api/savior/quantum/collapse' && req.method === 'POST') {
    const spec = await body(req);
    const rehearsal = await quantum.superpose(spec);
    if (!rehearsal.winner || spec.dryRun !== false) return json(res, 200, { ...rehearsal, collapsed: false, dryRun: true });
    const committed = await protectedCommit.transact({
      ops: rehearsal.winningOps || [], isolation: spec.isolation,
      survivalLevel: spec.survivalLevel || 'ULTIMATE', verifyQueries: spec.verifyQueries
    });
    return json(res, 200, {
      ...rehearsal, collapsed: true, dryRun: false,
      collapse: {
        at: new Date().toISOString(), protectedCommit: committed,
        winnerWorldHash: rehearsal.winner.worldHash,
        note: 'Winner committed through the shared protected coordinator. Quantum-inspired only; no quantum hardware.'
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
  await memoryPalace.snapshot('genesis');
  await braid.weave('genesis');
  await challenge.challenge({ perFile: 4, freezeOnFailure: false }).catch(() => {});
}

async function main() {
  await engine.init();
  await apocalypse.init();
  await fabric.init();
  await memoryPalace.init();
  await repair.init();
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
    console.log('Protected tx  : 3 reducers → real commit → postflight comparison');
    console.log('Fabric        : coordinated epoch seals + recovery dossiers');
    console.log('Oracle        : cross-domain trust adjudication');
    console.log('Trust budget  : discounts correlated evidence by failure domain');
    console.log('Challenge     : braid-seeded latent-rot sampling');
    console.log('Memory Palace : content-addressed chunks + Merkle ancestry');
    console.log('Repair law    : self-healing authority constitution');
    console.log('Chronicle     : independent semantic commit replay');
    console.log('Braid         : cross-anchored independent history heads');
    console.log('ARK           : XOR + GF(256) + Trinity decoder quorum');
    console.log('Quantum-ish   : deterministic speculative worlds + protected collapse');
    console.log('Apocalypse    : isolated destruction drills; canonical data untouched\n');
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
