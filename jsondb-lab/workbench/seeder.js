'use strict';

const crypto = require('crypto');
const { collections, scales } = require('./domain');

function hash32(value) {
  const hex = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16) >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function choose(random, values) { return values[Math.floor(random() * values.length)]; }
function weighted(random, values) {
  const total = values.reduce((sum, item) => sum + item[1], 0);
  let n = random() * total;
  for (const [value, weight] of values) { n -= weight; if (n <= 0) return value; }
  return values[values.length - 1][0];
}
function id(prefix, runKey, index) { return `${prefix}-${runKey}-${String(index + 1).padStart(7, '0')}`; }
function fakeSha(seed) { return crypto.createHash('sha1').update(String(seed)).digest('hex'); }
function vector(random, dimensions = 12) {
  const values = [];
  for (let i = 0; i < dimensions; i++) values.push(Math.round((random() * 2 - 1) * 100000) / 100000);
  return values;
}
function sentence(random, words, min = 8, max = 22) {
  const count = min + Math.floor(random() * (max - min + 1));
  const out = [];
  for (let i = 0; i < count; i++) out.push(choose(random, words));
  return `${out.join(' ')}.`;
}
function docIp(index, family = 0) {
  const blocks = ['192.0.2', '198.51.100', '203.0.113'];
  return `${blocks[family % blocks.length]}.${1 + (index % 253)}`;
}
function safeRunKey(value) {
  const out = String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  if (!out) throw Object.assign(new Error('runKey contains no usable characters.'), { status: 400 });
  return out;
}

async function ensureSchema(engine, emit = () => {}) {
  const before = await engine.catalog();
  const created = [];
  for (const spec of collections) {
    if (before.collections?.[spec.name] || (await engine.catalog()).collections?.[spec.name]) continue;
    emit({
      type: 'SCHEMA_CREATE', phase: 'schema', domain: spec.domain,
      simple: `Creating ${spec.name}.`,
      engineer: `DDL create collection ${spec.name}; indexes=${spec.indexes?.length || 0}; foreignKeys=${spec.foreignKeys?.length || 0}.`,
      details: { collection: spec.name }
    });
    await engine.createCollection(spec);
    created.push(spec.name);
  }
  return { created, totalKnown: collections.length };
}

async function insertRows(engine, collection, rows, emit, options = {}) {
  const batchSize = Math.min(1000, Math.max(25, Number(options.batchSize || 500)));
  let inserted = 0;
  let transactions = 0;
  const started = process.hrtime.bigint();
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const chunk = rows.slice(offset, offset + batchSize);
    const batchNumber = Math.floor(offset / batchSize) + 1;
    emit({
      type: 'BATCH_BEGIN', phase: 'transaction', domain: options.domain || 'benchmark',
      simple: `Sending ${chunk.length.toLocaleString()} ${collection} rows into JSONDB.`,
      engineer: `BEGIN seed batch ${batchNumber}; collection=${collection}; ops=${chunk.length}; offset=${offset}.`,
      details: { collection, batchNumber, rows: chunk.length, inserted, total: rows.length }
    });
    const result = await engine.transact(chunk.map(row => ({ type: 'insert', collection, row })), { isolation: 'snapshot-ish' });
    transactions++;
    inserted += chunk.length;
    emit({
      type: 'BATCH_COMMIT', phase: 'commit', domain: options.domain || 'benchmark',
      simple: `${collection}: ${inserted.toLocaleString()} / ${rows.length.toLocaleString()} rows committed.`,
      engineer: `COMMIT tx=${result.tx}; collection=${collection}; mutations=${chunk.length}; progress=${inserted}/${rows.length}. WAL, current-state JSON, version history and configured hash indexes advanced.`,
      details: { collection, tx: result.tx, batchNumber, inserted, total: rows.length, progress: rows.length ? inserted / rows.length : 1 }
    });
  }
  return {
    collection,
    inserted,
    transactions,
    durationMs: Number(process.hrtime.bigint() - started) / 1e6
  };
}

function generateRows(profile, runKey, seedText) {
  const random = mulberry32(hash32(`${runKey}\0${seedText}`));
  const runId = `seedrun-${runKey}`;

  const projectNames = ['RAVELIN', 'SALRYN', 'INTER-LAN', 'TALIBON', 'OMEGA', 'NAIRU', 'AEGIS', 'OBSIDIAN', 'LANTERN', 'PARALLAX'];
  const forgeStates = ['planned', 'authorized', 'implementing', 'validation', 'review', 'accepted', 'rework', 'promoted'];
  const owners = ['Kirch', 'Writer-A', 'Writer-B', 'CI-CD', 'QA', 'Reviewer', 'Acceptance'];
  const evidenceTypes = ['E0-authority', 'E1-build', 'E2-tests', 'E3-negative-tests', 'E4-runtime', 'E5-review', 'E6-acceptance', 'E7-promotion'];
  const gates = ['build', 'unit', 'integration', 'security', 'architecture', 'qa', 'acceptance'];
  const earthKinds = ['architecture', 'research', 'requirement', 'tradeoff', 'failure-analysis', 'design-review'];
  const earthWords = ['authority','architecture','boundary','invariant','repository','candidate','evidence','validation','latency','storage','concurrency','recovery','contract','interface','dependency','migration','observability','determinism','failure','acceptance','benchmark','reasoning'];
  const assetClasses = ['api','database','workstation','build-runner','gateway','identity-service','storage-node','internal-tool'];
  const findingCategories = ['identity','authorization','configuration','dependency','network','logging','integrity','availability'];
  const eventTypes = ['AUTH_FAILURE','AUTH_SUCCESS','POLICY_DENY','PRIVILEGE_DENIED','PROCESS_START','NETWORK_CONNECT','FILE_INTEGRITY','DETECTION_SIGNAL','CONFIG_CHANGE','TOKEN_VALIDATION'];
  const severities = ['info','low','medium','high','critical'];
  const topics = ['authority-model','transaction-recovery','rag-evaluation','security-boundary','query-planning','evidence-governance','distributed-state','index-design','observability','failure-analysis'];
  const marsWords = ['embedding','retrieval','chunk','context','evaluation','dataset','index','recall','precision','rerank','grounding','corpus','vector','semantic','query','benchmark','pipeline','training','evidence','experiment','latency','quality'];
  const domains = ['forge','earth','jupiter','mars'];

  const projects = Array.from({ length: profile.projects }, (_, i) => ({
    id: id('project', runKey, i), seedRunId: runId,
    projectKey: `${runKey}:project:${i + 1}`,
    name: `${projectNames[i % projectNames.length]}-${String(Math.floor(i / projectNames.length) + 1).padStart(2, '0')}`,
    domain: choose(random, domains),
    status: weighted(random, [['active', 6], ['validation', 2], ['frozen', 1], ['archived', 1]]),
    priority: 1 + Math.floor(random() * 100),
    risk: weighted(random, [['low', 3], ['medium', 5], ['high', 2], ['critical', 0.5]]),
    repository: `Kirch-Nairu/${projectNames[i % projectNames.length].toLowerCase()}-${i + 1}.test`,
    branch: weighted(random, [['main', 7], ['candidate', 2], ['rework', 1]]),
    sourceSha: fakeSha(`${runKey}:project:${i}:source`),
    acceptedSha: random() > 0.35 ? fakeSha(`${runKey}:project:${i}:accepted`) : null
  }));

  const workPackages = Array.from({ length: profile.workPackages }, (_, i) => {
    const project = projects[i % projects.length];
    const state = weighted(random, forgeStates.map((s, idx) => [s, idx === 5 ? 4 : 1.5]));
    return {
      id: id('wp', runKey, i), seedRunId: runId,
      workPackageKey: `${runKey}:wp:${i + 1}`, projectId: project.id,
      code: `${String.fromCharCode(65 + (i % 8))}${String((i % 99) + 1).padStart(2, '0')}-${i % 2 ? 'B' : 'F'}`,
      title: `${choose(random, ['Authority','Runtime','Storage','Security','UI','Recovery','Query','Evidence'])} ${choose(random, ['core','lane','rework','hardening','adapter','validation','integration','migration'])} ${i + 1}`,
      state, priority: 1 + Math.floor(random() * 100), owner: choose(random, owners),
      sourceSha: fakeSha(`${runKey}:wp:${i}:source`),
      candidateSha: ['validation','review','accepted','promoted'].includes(state) ? fakeSha(`${runKey}:wp:${i}:candidate`) : null,
      acceptedSha: ['accepted','promoted'].includes(state) ? fakeSha(`${runKey}:wp:${i}:accepted`) : null,
      authorityExact: random() > 0.03,
      negativeTestsRequired: random() > 0.35
    };
  });

  const evidence = Array.from({ length: profile.evidence }, (_, i) => {
    const wp = workPackages[i % workPackages.length];
    const evidenceType = evidenceTypes[i % evidenceTypes.length];
    return {
      id: id('evidence', runKey, i), seedRunId: runId,
      evidenceKey: `${runKey}:evidence:${i + 1}`, workPackageId: wp.id,
      evidenceType,
      state: weighted(random, [['present', 7], ['pending', 2], ['rejected', 1]]),
      artifactHash: fakeSha(`${runKey}:evidence:${i}:artifact`),
      sizeBytes: 512 + Math.floor(random() * 800000),
      summary: sentence(random, earthWords, 10, 20)
    };
  });

  const ciRuns = Array.from({ length: profile.ciRuns }, (_, i) => {
    const wp = workPackages[i % workPackages.length];
    return {
      id: id('ci', runKey, i), seedRunId: runId,
      runKey: `${runKey}:ci:${i + 1}`, workPackageId: wp.id,
      gate: choose(random, gates),
      status: weighted(random, [['PASS', 8], ['FAIL', 1.5], ['REWORK', 0.5]]),
      durationMs: 150 + Math.floor(random() * 180000),
      runner: choose(random, ['ubuntu-24.04','windows-2025','self-hosted-lab']),
      candidateSha: wp.candidateSha || wp.sourceSha,
      tests: 5 + Math.floor(random() * 800),
      failures: random() > 0.9 ? 1 + Math.floor(random() * 8) : 0
    };
  });

  const earthCases = Array.from({ length: profile.earthCases }, (_, i) => {
    const project = projects[i % projects.length];
    return {
      id: id('earth', runKey, i), seedRunId: runId,
      caseKey: `${runKey}:earth:${i + 1}`, projectId: project.id,
      kind: choose(random, earthKinds),
      status: weighted(random, [['open', 3], ['investigating', 3], ['decided', 4]]),
      priority: 1 + Math.floor(random() * 100),
      question: sentence(random, earthWords, 9, 18),
      conclusion: random() > 0.35 ? sentence(random, earthWords, 12, 28) : null,
      confidence: Math.round((0.45 + random() * 0.55) * 1000) / 1000,
      tags: [choose(random, earthWords), choose(random, earthWords), choose(random, earthWords)]
    };
  });

  const jupiterAssets = Array.from({ length: profile.jupiterAssets }, (_, i) => ({
    id: id('asset', runKey, i), seedRunId: runId,
    assetKey: `${runKey}:asset:${i + 1}`,
    hostname: `node-${String(i + 1).padStart(5, '0')}.kirion.test`,
    address: docIp(i, i % 3),
    assetClass: choose(random, assetClasses),
    exposure: weighted(random, [['internal', 7], ['restricted', 2], ['edge', 1]]),
    risk: weighted(random, [['low', 3], ['medium', 5], ['high', 1.7], ['critical', 0.3]]),
    environment: choose(random, ['dev','test','staging','prod-sim']),
    owner: choose(random, ['platform','security','data','engineering','operations'])
  }));

  const jupiterFindings = Array.from({ length: profile.jupiterFindings }, (_, i) => {
    const asset = jupiterAssets[i % jupiterAssets.length];
    return {
      id: id('finding', runKey, i), seedRunId: runId,
      findingKey: `${runKey}:finding:${i + 1}`, assetId: asset.id,
      category: choose(random, findingCategories),
      severity: weighted(random, [['low', 2], ['medium', 5], ['high', 2.5], ['critical', 0.5]]),
      status: weighted(random, [['open', 4], ['mitigating', 3], ['accepted-risk', 1], ['closed', 4]]),
      control: `CTRL-${String((i % 120) + 1).padStart(3, '0')}`,
      title: `${choose(random, ['Boundary','Identity','Integrity','Configuration','Dependency','Telemetry'])} defensive finding ${i + 1}`,
      evidence: sentence(random, ['synthetic','telemetry','policy','boundary','control','authorization','integrity','signal','configuration','audit','defensive','validation'], 8, 18)
    };
  });

  const jupiterEvents = Array.from({ length: profile.jupiterEvents }, (_, i) => {
    const asset = jupiterAssets[Math.floor(random() * jupiterAssets.length)];
    const eventType = weighted(random, eventTypes.map(type => [type, type === 'AUTH_SUCCESS' ? 6 : type === 'NETWORK_CONNECT' ? 5 : 1]));
    return {
      id: id('soc', runKey, i), seedRunId: runId,
      eventKey: `${runKey}:event:${i + 1}`, assetId: asset.id,
      eventType,
      severity: weighted(random, [['info', 12], ['low', 6], ['medium', 3], ['high', 1], ['critical', 0.15]]),
      disposition: weighted(random, [['observed', 8], ['allowed', 5], ['denied', 2], ['investigate', 1]]),
      sourceIp: docIp(i * 7, i % 3),
      destination: `service-${i % 47}.kirion.test`,
      principal: `synthetic-user-${i % 311}`,
      traceId: fakeSha(`${runKey}:trace:${i}`).slice(0, 24),
      bytes: Math.floor(random() * 1200000)
    };
  });

  const marsDatasets = Array.from({ length: profile.marsDatasets }, (_, i) => ({
    id: id('dataset', runKey, i), seedRunId: runId,
    datasetKey: `${runKey}:dataset:${i + 1}`,
    name: `kirion-corpus-${String(i + 1).padStart(4, '0')}`,
    modality: choose(random, ['text','code','logs','mixed']),
    status: weighted(random, [['ready', 6], ['evaluating', 3], ['quarantined', 1]]),
    documents: 100 + Math.floor(random() * 200000),
    bytes: 100000 + Math.floor(random() * 1500000000),
    lineageHash: fakeSha(`${runKey}:dataset:${i}:lineage`)
  }));

  const marsChunks = Array.from({ length: profile.marsChunks }, (_, i) => {
    const dataset = marsDatasets[i % marsDatasets.length];
    const topic = choose(random, topics);
    return {
      id: id('chunk', runKey, i), seedRunId: runId,
      chunkKey: `${runKey}:chunk:${i + 1}`, datasetId: dataset.id,
      topic,
      text: sentence(random, [...marsWords, ...earthWords], 24, 70),
      tokens: 80 + Math.floor(random() * 900),
      embedding: vector(random, 12),
      quality: Math.round(random() * 10000) / 10000
    };
  });

  const marsEvaluations = Array.from({ length: profile.marsEvaluations }, (_, i) => {
    const dataset = marsDatasets[i % marsDatasets.length];
    const metric = choose(random, ['recall@10','precision@10','mrr','ndcg','groundedness','latency']);
    return {
      id: id('eval', runKey, i), seedRunId: runId,
      evaluationKey: `${runKey}:eval:${i + 1}`, datasetId: dataset.id,
      metric,
      score: metric === 'latency' ? 5 + random() * 800 : random(),
      status: weighted(random, [['PASS', 7], ['WARN', 2], ['FAIL', 1]]),
      sampleSize: 20 + Math.floor(random() * 5000),
      experiment: `EXP-${String((i % 80) + 1).padStart(3, '0')}`
    };
  });

  const payloadWords = [...earthWords, ...marsWords, 'hot','cold','partition','scan','selectivity','cardinality','skew','write','read','planner','mvcc'];
  const benchmarkRecords = Array.from({ length: profile.benchmarkRecords }, (_, i) => {
    const priority = weighted(random, [[1, 14],[2, 12],[3, 10],[4, 8],[5, 6],[10, 4],[25, 2],[50, 1],[99, 0.3]]);
    const domain = weighted(random, [['forge', 5], ['earth', 2], ['jupiter', 4], ['mars', 3]]);
    const hot = random() < 0.8 ? `hot-${Math.floor(random() * 8)}` : `cold-${Math.floor(random() * Math.max(32, profile.benchmarkRecords / 20))}`;
    return {
      id: id('bench', runKey, i), seedRunId: runId,
      benchKey: `${runKey}:bench:${i + 1}`,
      priority,
      status: weighted(random, [['active', 6], ['queued', 3], ['blocked', 1], ['complete', 5]]),
      domain, hotKey: hot,
      ordinal: i + 1,
      numericValue: Math.round(random() * 1000000) / 100,
      traceId: fakeSha(`${runKey}:bench-trace:${i}`),
      payload: sentence(random, payloadWords, 15, 80)
    };
  });

  return {
    runId,
    rowsByCollection: {
      kirion_projects: projects,
      forge_work_packages: workPackages,
      forge_evidence: evidence,
      forge_ci_runs: ciRuns,
      earth_cases: earthCases,
      jupiter_assets: jupiterAssets,
      jupiter_findings: jupiterFindings,
      jupiter_events: jupiterEvents,
      mars_datasets: marsDatasets,
      mars_chunks: marsChunks,
      mars_evaluations: marsEvaluations,
      benchmark_records: benchmarkRecords
    }
  };
}

async function seedScenario(engine, options = {}, emit = () => {}) {
  const scale = String(options.scale || 'demo');
  if (!scales[scale]) throw Object.assign(new Error(`Unknown scale: ${scale}`), { status: 400 });
  const seedText = String(options.seed || 'KIRION-OMEGA');
  const runKey = safeRunKey(options.runKey || `${Date.now().toString(36)}-${hash32(seedText).toString(16)}`);
  const profile = { ...scales[scale] };
  if (options.benchmarkRecords != null) {
    const requested = Number(options.benchmarkRecords);
    if (!Number.isInteger(requested) || requested < 0 || requested > 100000) throw Object.assign(new Error('benchmarkRecords must be an integer between 0 and 100000.'), { status: 400 });
    profile.benchmarkRecords = requested;
  }

  emit({
    type: 'SEED_BEGIN', phase: 'request', domain: 'forge',
    simple: `Starting ${scale} KIRION engineering seed run.`,
    engineer: `Seed request accepted; runKey=${runKey}; deterministicSeed=${seedText}; scale=${scale}. All writes will use MonsterEngine transactions.`,
    details: { runKey, scale, seed: seedText, profile }
  });

  const schema = await ensureSchema(engine, emit);
  const generated = generateRows(profile, runKey, seedText);
  const runRow = {
    id: generated.runId,
    runKey,
    scenario: 'kirion-engineering-cybersecurity-benchmark',
    scale,
    seed: seedText,
    status: 'running',
    profile,
    startedAt: new Date().toISOString()
  };
  await engine.transact([{ type: 'insert', collection: 'workbench_seed_runs', row: runRow }]);

  const results = [];
  try {
    for (const spec of collections) {
      const rows = generated.rowsByCollection[spec.name];
      if (!rows?.length) continue;
      results.push(await insertRows(engine, spec.name, rows, emit, { domain: spec.domain, batchSize: options.batchSize }));
    }
    const finishedAt = new Date().toISOString();
    await engine.transact([{ type: 'update', collection: 'workbench_seed_runs', id: generated.runId, patch: { status: 'complete', finishedAt, inserted: Object.fromEntries(results.map(item => [item.collection, item.inserted])) } }]);
    const totalRows = results.reduce((sum, item) => sum + item.inserted, 0);
    emit({
      type: 'SEED_COMPLETE', phase: 'commit', domain: 'forge',
      simple: `Seed complete: ${totalRows.toLocaleString()} synthetic engineering records committed.`,
      engineer: `Seed run ${runKey} COMPLETE; domainRows=${totalRows}; transactions=${results.reduce((sum, item) => sum + item.transactions, 0)}; schemaCreated=${schema.created.length}.`,
      details: { runKey, runId: generated.runId, totalRows, results, schema }
    });
    return { runKey, runId: generated.runId, scale, seed: seedText, profile, schema, totalRows, results };
  } catch (error) {
    await engine.transact([{ type: 'update', collection: 'workbench_seed_runs', id: generated.runId, patch: { status: 'failed', failedAt: new Date().toISOString(), error: error.message } }]).catch(() => {});
    emit({
      type: 'SEED_FAILED', phase: 'abort', domain: 'forge', severity: 'error',
      simple: `Seed failed: ${error.message}`,
      engineer: `Seed run ${runKey} aborted at orchestration layer: ${error.stack || error.message}`,
      details: { runKey, error: error.message }
    });
    throw error;
  }
}

module.exports = {
  ensureSchema,
  seedScenario,
  generateRows,
  insertRows,
  hash32,
  mulberry32
};
