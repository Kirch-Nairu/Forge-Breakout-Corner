#!/usr/bin/env node
'use strict';
const {MonsterEngine}=require('./monster/engine');const {JsonVectorIndex}=require('./monster/vector');const engine=new MonsterEngine(__dirname);const vector=new JsonVectorIndex(engine);const [command='help',...args]=process.argv.slice(2);const print=x=>console.log(JSON.stringify(x,null,2));const vec=x=>JSON.parse(x);async function main(){await engine.init();if(command==='build')return print(await vector.build(args[0],args[1],args[2],Number(args[3]||8)));if(command==='search')return print(await vector.search(args[0],args[1],vec(args[2]),Number(args[3]||10),Number(args[4]||64)));if(command==='brute')return print(await vector.bruteForce(args[0],args[1],vec(args[2]),Number(args[3]||10)));console.log(`
JSONDB VECTOR SEARCH LAB

Rows need an array field such as embedding:[0.1,0.2,0.3].

node vector-cli.js build vectors demo embedding 8
node vector-cli.js search vectors demo '[0.1,0.2,0.3]' 10 64
node vector-cli.js brute vectors embedding '[0.1,0.2,0.3]' 10

Single-layer HNSW-ish neighbor graph stored entirely as JSON.
Because apparently JSONDB needed an AI-era feature checkbox too.
`)}main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
