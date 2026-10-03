#!/usr/bin/env node
'use strict';

const { MonsterEngine } = require('./monster/engine');
const { DistributedJsonStore } = require('./monster/distributed');

const engine = new MonsterEngine(__dirname);
const store = new DistributedJsonStore(engine);
const [command = 'help', ...args] = process.argv.slice(2);
const print = value => console.log(JSON.stringify(value, null, 2));

function value(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  try { return JSON.parse(raw); } catch { return raw; }
}

async function main() {
  await engine.init();
  await store.init();
  if (command === 'topology') return print(await store.topology());
  if (command === 'route') return print(await store.route(args[0]));
  if (command === 'get') return print(await store.get(args[0], args[1]));
  if (command === 'put') return print(await store.put(args[0], args[1], value(args.slice(2).join(' '))));
  if (command === 'delete') return print(await store.remove(args[0], args[1]));
  if (command === 'scan') return print(await store.scan(args[0]));
  if (command === 'mapreduce') return print(await store.mapReduce(args[0], args[1], args[2] || 'count'));
  if (command === '2pc-demo') {
    const nonce = Date.now();
    return print(await store.twoPhaseCommit([
      { type: 'put', collection: 'distributed_demo', key: `alpha-${nonce}`, row: { office: 'Engineering', amount: 12, note: 'probably one shard' } },
      { type: 'put', collection: 'distributed_demo', key: `omega-${nonce}`, row: { office: 'Budget', amount: 91, note: 'probably another shard' } },
      { type: 'put', collection: 'distributed_demo', key: `kirion-${nonce}`, row: { office: 'MPDO', amount: 44, note: 'all committed through 2PC' } }
    ]));
  }
  console.log(`
DISTRIBUTED JSONDB CRIME LAB

node distributed-cli.js topology
node distributed-cli.js route some-key
node distributed-cli.js put records alpha '{"office":"Engineering","amount":12}'
node distributed-cli.js get records alpha
node distributed-cli.js delete records alpha
node distributed-cli.js scan records
node distributed-cli.js mapreduce records office count
node distributed-cli.js 2pc-demo

Storage model:
  rendezvous hash key -> JSON shard
  coordinator prepare -> per-shard prepare manifests
  decision commit -> shard JSON atomic replace
  recovery -> finish commit or restore before-images

This is not a recommendation. This is what happens when SQLite is banned for comedy.
`);
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
