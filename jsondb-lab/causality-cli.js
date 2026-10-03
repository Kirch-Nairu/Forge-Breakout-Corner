#!/usr/bin/env node
'use strict';

const { MonsterEngine } = require('./monster/engine');
const { TamperLedger, CrdtLab } = require('./monster/causality');

const engine = new MonsterEngine(__dirname);
const ledger = new TamperLedger(engine);
const crdt = new CrdtLab(engine);
const [command = 'help', ...args] = process.argv.slice(2);
const print = value => console.log(JSON.stringify(value, null, 2));

async function main() {
  await engine.init();
  if (command === 'seal-wal') return print(await ledger.seal());
  if (command === 'verify-wal') return print(await ledger.verify());
  if (command === 'crdt-set') return print(await crdt.set(args[0], args[1], args[2], args[3], parse(args.slice(4).join(' '))));
  if (command === 'crdt-delete') return print(await crdt.remove(args[0], args[1], args[2]));
  if (command === 'crdt-merge') return print(await crdt.merge(args[0], args[1]));
  if (command === 'crdt-read') return print(await crdt.materialize(args[0], args[1]));
  if (command === 'crdt-conflict-demo') return print(await crdt.conflictDemo());
  console.log(`
JSONDB CAUSALITY / TAMPER LAB

node causality-cli.js seal-wal
node causality-cli.js verify-wal
node causality-cli.js crdt-set laptop-a notes note-1 text '"hello offline world"'
node causality-cli.js crdt-set laptop-b notes note-1 text '"conflicting offline edit"'
node causality-cli.js crdt-merge laptop-a laptop-b
node causality-cli.js crdt-read laptop-a notes
node causality-cli.js crdt-conflict-demo

Because plain JSON apparently needed hybrid logical clocks too.
`);
}

function parse(raw) { try { return JSON.parse(raw); } catch { return raw; } }
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
