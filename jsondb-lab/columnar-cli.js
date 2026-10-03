#!/usr/bin/env node
'use strict';

const { MonsterEngine } = require('./monster/engine');
const { JsonColumnStore } = require('./monster/columnar');
const engine = new MonsterEngine(__dirname);
const columnar = new JsonColumnStore(engine);
const [command='help',...args]=process.argv.slice(2);
const print=x=>console.log(JSON.stringify(x,null,2));
const val=x=>{if(x==='true')return true;if(x==='false')return false;if(x==='null')return null;if(x!==''&&!Number.isNaN(Number(x)))return Number(x);return x};
async function main(){await engine.init();if(command==='build')return print(await columnar.build(args[0],args.slice(1)));if(command==='filter')return print(await columnar.filter(args[0],args[1],val(args[2]),Number(args[3]||10000)));if(command==='aggregate')return print(await columnar.aggregate(args[0],args[1],args[2]||'sum',args[3]?{field:args[3],value:val(args[4])}:null));if(command==='reconstruct')return print(await columnar.reconstruct(args[0],null,args.slice(1).length?args.slice(1):null));console.log(`
JSON COLUMN STORE LAB

node columnar-cli.js build bench status office score
node columnar-cli.js filter bench status active
node columnar-cli.js aggregate bench score avg status active
node columnar-cli.js reconstruct bench status office score

Dictionary encoding + null bitmaps + categorical bitmap indexes + vector-ish scans.
Because one JSON row store was not enough database engines for one repository.
`)}main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
