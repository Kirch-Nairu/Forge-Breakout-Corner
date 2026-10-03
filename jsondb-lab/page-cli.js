#!/usr/bin/env node
'use strict';

const { MonsterEngine } = require('./monster/engine');
const { JsonPageEngine } = require('./monster/page-engine');
const engine = new MonsterEngine(__dirname);
const pages = new JsonPageEngine(engine, Number(process.env.JSONDB_PAGE_BYTES || 4096), Number(process.env.JSONDB_POOL_PAGES || 32));
const [command = 'help', ...args] = process.argv.slice(2);
const print = x => console.log(JSON.stringify(x, null, 2));

async function main(){
  await engine.init();
  if(command==='rebuild') return print(await pages.rebuild(args[0]));
  if(command==='scan') return print(await pages.heapScan(args[0], Number(args[1]||100)));
  if(command==='inspect') return print(await pages.inspect(args[0],args[1]));
  if(command==='tombstone') return print(await pages.tombstone(args[0],args[1]));
  if(command==='vacuum') return print(await pages.vacuum(args[0]));
  if(command==='status') return print(await pages.status(args[0]));
  console.log(`
JSON PAGE ENGINE / BUFFER POOL LAB

node page-cli.js rebuild tasks
node page-cli.js status tasks
node page-cli.js scan tasks 100
node page-cli.js inspect tasks <page-id>
node page-cli.js tombstone tasks <row-id>
node page-cli.js vacuum tasks

Environment:
  JSONDB_PAGE_BYTES=4096
  JSONDB_POOL_PAGES=32

We are storing database pages as JSON because the experiment has become personal.
`);
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
