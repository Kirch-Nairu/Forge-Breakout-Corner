#!/usr/bin/env node
'use strict';

const path = require('path');
const { MonsterEngine } = require('./monster/engine');
const { JsonCluster } = require('./monster/cluster');
const { AdvancedServices } = require('./monster/advanced');
const { JsonBPlusTree, JsonFullTextIndex } = require('./monster/exotic-indexes');
const { compileSQL } = require('./monster/sql');

const engine = new MonsterEngine(__dirname);
const cluster = new JsonCluster(engine);
const advanced = new AdvancedServices(engine);
const btree = new JsonBPlusTree(engine);
const fulltext = new JsonFullTextIndex(engine);
const args = process.argv.slice(2);
const command = args.shift() || 'help';
const print = value => console.log(JSON.stringify(value, null, 2));
const numberOr = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;

async function boot() {
  await engine.init();
  await cluster.init();
  await advanced.init();
}

async function main() {
  await boot();
  if (command === 'status') return print({ engine: await engine.status(), cluster: await cluster.status(), advanced: await advanced.status() });
  if (command === 'sql') {
    const sql = args.join(' ');
    const compiled = compileSQL(sql);
    return print({ compiled: compiled.query, result: await engine.query(compiled.query) });
  }
  if (command === 'analyze') return print(await advanced.analyze(args[0]));
  if (command === 'bloom-build') return print(await advanced.buildBloom(args[0], args[1], numberOr(args[2], 32768), numberOr(args[3], 7)));
  if (command === 'bloom-test') return print(await advanced.testBloom(args[0], args[1], parseScalar(args.slice(2).join(' '))));
  if (command === 'partition') return print(await advanced.buildPartitions(args[0], args[1], numberOr(args[2], 8)));
  if (command === 'btree-build') return print(await btree.build(args[0], args[1], numberOr(args[2], 64)));
  if (command === 'btree-range') return print(await btree.range(args[0], args[1], parseNullable(args[2]), parseNullable(args[3]), numberOr(args[4], 1000)));
  if (command === 'fts-build') return print(await fulltext.build(args[0], args[1], args.slice(2)));
  if (command === 'fts-search') return print(await fulltext.search(args[0], args[1], args.slice(2).join(' '), 50));
  if (command === 'checkpoint') return print(await engine.checkpoint());
  if (command === 'compact') return print(await engine.compact(args[0] || null));
  if (command === 'snapshot') return print(await engine.snapshot());
  if (command === 'integrity') return print(await engine.verifyIntegrity());
  if (command === 'backup') return print(await advanced.backup());
  if (command === 'replicate') return print(await cluster.replicateAll());
  if (command === 'failover') return print(await cluster.failover());
  if (command === 'promote-local') return print(await cluster.promoteLocal());
  return console.log(`
JSONDB MONSTER OPERATOR CLI

node monster-cli.js status
node monster-cli.js sql "SELECT * FROM tasks WHERE priority >= 5 ORDER BY priority DESC LIMIT 20"
node monster-cli.js analyze tasks
node monster-cli.js bloom-build tasks slug 32768 7
node monster-cli.js bloom-test tasks slug past-the-limit
node monster-cli.js partition tasks status 8
node monster-cli.js btree-build tasks priority 32
node monster-cli.js btree-range tasks priority 5 999 100
node monster-cli.js fts-build tasks task_text title slug
node monster-cli.js fts-search tasks task_text "json database"
node monster-cli.js checkpoint
node monster-cli.js compact
node monster-cli.js snapshot
node monster-cli.js integrity
node monster-cli.js backup
node monster-cli.js replicate
node monster-cli.js failover
node monster-cli.js promote-local

No npm. No database. No restraint.
`);
}

function parseNullable(value) {
  if (value === undefined || value === 'null' || value === '*') return null;
  return parseScalar(value);
}

function parseScalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
