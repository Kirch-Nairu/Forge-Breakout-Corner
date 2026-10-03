#!/usr/bin/env node
'use strict';

const { MonsterEngine } = require('./monster/engine');
const { PointInTimeRecovery } = require('./monster/pitr');
const engine = new MonsterEngine(__dirname);
const pitr = new PointInTimeRecovery(engine);
const [command='help',...args]=process.argv.slice(2);
const print=x=>console.log(JSON.stringify(x,null,2));
async function main(){await engine.init();if(command==='restore')return print(await pitr.restoreToTransaction(args[0]));if(command==='diff')return print(await pitr.diffTransactions(args[0],args[1],args[2]));if(command==='list')return print(await pitr.list());console.log(`
JSONDB POINT-IN-TIME RECOVERY LAB

node pitr-cli.js restore <tx>
node pitr-cli.js diff <from-tx> <to-tx> tasks
node pitr-cli.js list

Restores are sandbox directories only. Live state is not promoted automatically.
Because even our reckless experiment deserves one boundary.
`)}main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
