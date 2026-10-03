#!/usr/bin/env node
'use strict';
const {MonsterEngine}=require('./monster/engine');const {AdvancedServices}=require('./monster/advanced');const {CostOptimizer}=require('./monster/optimizer');const {compileSQL}=require('./monster/sql');const engine=new MonsterEngine(__dirname);const advanced=new AdvancedServices(engine);const optimizer=new CostOptimizer(engine,advanced);const [command='help',...args]=process.argv.slice(2);const print=x=>console.log(JSON.stringify(x,null,2));async function main(){await engine.init();await advanced.init();if(command==='analyze')return print(await advanced.analyze(args[0]));if(command==='plan-sql'){const q=compileSQL(args.join(' ')).query;return print(await optimizer.optimize(q))}if(command==='execute-sql'){const q=compileSQL(args.join(' ')).query;return print(await optimizer.execute(q))}if(command==='status')return print(optimizer.status());console.log(`
JSONDB COST OPTIMIZER LAB

node optimizer-cli.js analyze tasks
node optimizer-cli.js plan-sql "SELECT * FROM tasks WHERE status = 'active' ORDER BY priority DESC LIMIT 20"
node optimizer-cli.js execute-sql "SELECT * FROM tasks WHERE priority >= 5 LIMIT 20"

ANALYZE -> statistics -> selectivity estimate -> cardinality -> join reorder -> executor.
We have now reinvented the part of databases that guesses.
`)}main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
