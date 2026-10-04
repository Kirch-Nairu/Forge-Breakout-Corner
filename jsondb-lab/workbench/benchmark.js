'use strict';

const { JsonBPlusTree, JsonFullTextIndex } = require('../monster/exotic-indexes');
const { JsonVectorIndex } = require('../monster/vector');

async function timed(name, fn, emit = () => {}, metadata = {}) {
  emit({
    type: 'BENCH_CASE_BEGIN', phase: 'benchmark', domain: metadata.domain || 'benchmark',
    simple: `Benchmarking ${name}.`,
    engineer: `Benchmark case ${name} started. ${metadata.description || ''}`.trim(),
    details: { name, ...metadata }
  });
  const started = process.hrtime.bigint();
  try {
    const result = await fn();
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    emit({
      type: 'BENCH_CASE_COMPLETE', phase: 'benchmark', domain: metadata.domain || 'benchmark',
      simple: `${name} finished in ${durationMs.toFixed(2)} ms.`,
      engineer: `Benchmark ${name} COMPLETE; wall=${durationMs.toFixed(3)}ms${result?.explain?.access?.type ? `; access=${result.explain.access.type}; examined=${result.explain.examined}` : ''}.`,
      details: { name, durationMs, ...metadata }
    });
    return { name, durationMs, ok: true, result };
  } catch (error) {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    emit({
      type: 'BENCH_CASE_FAILED', phase: 'benchmark', domain: metadata.domain || 'benchmark', severity: 'error',
      simple: `${name} failed: ${error.message}`,
      engineer: `Benchmark ${name} FAILED after ${durationMs.toFixed(3)}ms: ${error.stack || error.message}`,
      details: { name, durationMs, error: error.message, ...metadata }
    });
    return { name, durationMs, ok: false, error: error.message };
  }
}

function compactQueryResult(result) {
  if (!result) return result;
  return {
    total: result.total,
    returned: result.rows?.length || 0,
    explain: result.explain,
    sample: (result.rows || []).slice(0, 5)
  };
}

async function runBenchmark(engine, options = {}, emit = () => {}) {
  const catalog = await engine.catalog();
  const required = ['benchmark_records','forge_work_packages','kirion_projects','earth_cases','mars_chunks'];
  for (const name of required) if (!catalog.collections?.[name]) throw Object.assign(new Error(`Benchmark requires seeded collection: ${name}`), { status: 409 });

  const benchmarkTable = await engine.loadCurrent('benchmark_records');
  if (!benchmarkTable.rows.length) throw Object.assign(new Error('benchmark_records is empty. Run the seeder first.'), { status: 409 });
  const sample = benchmarkTable.rows[Math.min(benchmarkTable.rows.length - 1, Math.max(0, Math.floor(benchmarkTable.rows.length / 3)))];
  const cases = [];

  emit({
    type: 'BENCHMARK_BEGIN', phase: 'request', domain: 'benchmark',
    simple: `Starting advanced benchmark over ${benchmarkTable.rows.length.toLocaleString()} benchmark records.`,
    engineer: `Benchmark suite BEGIN; benchmarkRows=${benchmarkTable.rows.length}; latestTx=${benchmarkTable.meta?.lastTx || 0}; advancedIndexes=${options.advancedIndexes !== false}; durability=${Boolean(options.durability)}.`,
    details: { benchmarkRows: benchmarkTable.rows.length, options }
  });

  cases.push(await timed('indexed-priority-equality', async () => compactQueryResult(await engine.query({
    from: 'benchmark_records',
    where: { field: 'priority', op: 'eq', value: sample.priority },
    select: ['id','priority','status','domain','hotKey','ordinal'],
    limit: 200
  })), emit, { domain: 'benchmark', description: 'Equality predicate should select the persisted benchmark_priority hash index.' }));

  cases.push(await timed('indexed-hot-key-equality', async () => compactQueryResult(await engine.query({
    from: 'benchmark_records',
    where: { field: 'hotKey', op: 'eq', value: sample.hotKey },
    select: ['id','hotKey','priority','status'],
    limit: 500
  })), emit, { domain: 'benchmark', description: 'Hot-key skew reveals index bucket fanout and examined-row behavior.' }));

  cases.push(await timed('forced-full-scan-contains', async () => compactQueryResult(await engine.query({
    from: 'benchmark_records',
    where: { field: 'payload', op: 'contains', value: 'authority' },
    select: ['id','priority','domain','payload'],
    limit: 100
  })), emit, { domain: 'benchmark', description: 'Contains predicate has no usable equality index and should force a full scan.' }));

  cases.push(await timed('group-aggregate-domain', async () => compactQueryResult(await engine.query({
    from: 'benchmark_records',
    groupBy: ['domain'],
    aggregates: {
      rows: { op: 'count' },
      avgValue: { op: 'avg', field: 'numericValue' },
      maxValue: { op: 'max', field: 'numericValue' }
    },
    orderBy: [{ field: 'rows', direction: 'desc' }],
    limit: 50
  })), emit, { domain: 'benchmark', description: 'Group/aggregate pipeline over the mixed-domain benchmark corpus.' }));

  cases.push(await timed('forge-project-hash-join', async () => compactQueryResult(await engine.query({
    from: 'forge_work_packages',
    joins: [{ collection: 'kirion_projects', on: { left: 'projectId', right: 'id' }, as: 'project', type: 'inner' }],
    select: ['id','workPackageKey','state','priority','project.name','project.domain'],
    limit: 500
  })), emit, { domain: 'forge', description: 'Real hash join between work packages and their projects.' }));

  const asOf = Math.max(0, Number(benchmarkTable.meta?.lastTx || 0) - 1);
  cases.push(await timed('historical-read', async () => {
    const rows = await engine.readAt('benchmark_records', asOf);
    return { asOf, rows: rows.length, sample: rows.slice(0, 5) };
  }, emit, { domain: 'benchmark', description: `MVCC-ish reconstruction from version JSONL as of tx ${asOf}.` }));

  if (options.advancedIndexes !== false) {
    const btree = new JsonBPlusTree(engine);
    cases.push(await timed('bplus-build-priority', async () => btree.build('benchmark_records', 'priority', Number(options.fanout || 64)), emit, {
      domain: 'benchmark', description: 'Bulk-build immutable JSON B+ tree-ish pages over priority.'
    }));
    cases.push(await timed('bplus-range-priority', async () => btree.range('benchmark_records', 'priority', 3, 25, 2000), emit, {
      domain: 'benchmark', description: 'Range traversal through persisted B+ tree-ish JSON pages.'
    }));

    const fulltext = new JsonFullTextIndex(engine);
    cases.push(await timed('earth-fulltext-build', async () => fulltext.build('earth_cases', 'earth_reasoning', ['question','conclusion']), emit, {
      domain: 'earth', description: 'Build JSON inverted postings over engineering reasoning cases.'
    }));
    cases.push(await timed('earth-fulltext-search', async () => {
      const result = await fulltext.search('earth_cases', 'earth_reasoning', 'authority architecture recovery evidence', 20);
      return { ...result, rows: result.rows.slice(0, 10) };
    }, emit, { domain: 'earth', description: 'BM25-ish full-text retrieval over synthetic EARTH cases.' }));

    const mars = await engine.loadCurrent('mars_chunks');
    const vectorIndex = new JsonVectorIndex(engine);
    if (mars.rows.length && mars.rows.length <= Number(options.vectorBuildLimit || 3000)) {
      cases.push(await timed('mars-vector-build', async () => vectorIndex.build('mars_chunks', 'mars_semantic', 'embedding', Number(options.vectorM || 8)), emit, {
        domain: 'mars', description: 'Educational single-layer HNSW-ish graph over 12-dimensional MARS chunk embeddings.'
      }));
      const queryVector = mars.rows[Math.floor(mars.rows.length / 2)].embedding;
      cases.push(await timed('mars-vector-graph-search', async () => {
        const result = await vectorIndex.search('mars_chunks', 'mars_semantic', queryVector, 10, Number(options.vectorEf || 64));
        return { ...result, rows: result.rows.slice(0, 10) };
      }, emit, { domain: 'mars', description: 'Best-first graph search over persisted JSON neighbor lists.' }));
      cases.push(await timed('mars-vector-bruteforce', async () => {
        const result = await vectorIndex.bruteForce('mars_chunks', 'embedding', queryVector, 10);
        return { ...result, rows: result.rows.slice(0, 10) };
      }, emit, { domain: 'mars', description: 'Brute-force cosine baseline for comparison with the approximate graph.' }));
    } else {
      cases.push({
        name: 'mars-vector-build',
        ok: true,
        skipped: true,
        reason: `mars_chunks=${mars.rows.length}; vector graph build intentionally capped at ${Number(options.vectorBuildLimit || 3000)} because this educational implementation is O(n²).`
      });
    }
  }

  if (options.durability) {
    cases.push(await timed('checkpoint', async () => engine.checkpoint(), emit, {
      domain: 'forge', description: 'Copies current/index/catalog state and rotates the WAL base.'
    }));
    if (options.compact) {
      cases.push(await timed('compact-benchmark-records', async () => engine.compact('benchmark_records'), emit, {
        domain: 'benchmark', description: 'Writes compacted base JSON and archives mutation segments.'
      }));
    }
  }

  const passed = cases.filter(item => item.ok).length;
  const failed = cases.filter(item => !item.ok).length;
  const totalDurationMs = cases.reduce((sum, item) => sum + Number(item.durationMs || 0), 0);
  const plannerCases = cases.filter(item => item.result?.explain?.access).map(item => ({
    name: item.name,
    access: item.result.explain.access.type,
    index: item.result.explain.access.index || null,
    cost: item.result.explain.access.cost,
    examined: item.result.explain.examined,
    durationMs: item.result.explain.durationMs
  }));

  emit({
    type: 'BENCHMARK_COMPLETE', phase: 'commit', domain: 'benchmark', severity: failed ? 'warn' : 'normal',
    simple: `Benchmark complete: ${passed}/${cases.length} cases passed.`,
    engineer: `Benchmark suite COMPLETE; cases=${cases.length}; passed=${passed}; failed=${failed}; measuredWallSum=${totalDurationMs.toFixed(3)}ms.`,
    details: { passed, failed, total: cases.length, totalDurationMs, plannerCases }
  });

  return {
    format: 'JSONDB-KIRION-WORKBENCH-BENCHMARK-1',
    at: new Date().toISOString(),
    benchmarkRows: benchmarkTable.rows.length,
    passed,
    failed,
    total: cases.length,
    totalDurationMs,
    plannerCases,
    cases
  };
}

module.exports = { runBenchmark, timed };
