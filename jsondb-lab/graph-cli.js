#!/usr/bin/env node
'use strict';
const {MonsterEngine}=require('./monster/engine');const {JsonGraphStore}=require('./monster/graph');const engine=new MonsterEngine(__dirname);const [command='help',...args]=process.argv.slice(2);const graph=new JsonGraphStore(engine,process.env.JSONDB_GRAPH||'default');const print=x=>console.log(JSON.stringify(x,null,2));const parse=x=>{try{return JSON.parse(x)}catch{return{value:x}}};async function main(){await engine.init();await graph.init();if(command==='status')return print(await graph.status());if(command==='node')return print(await graph.addNode(args[0],parse(args.slice(1).join(' '))));if(command==='edge')return print(await graph.addEdge(args[0],args[1],args[2]||'RELATED_TO',{},true));if(command==='neighbors')return print(await graph.neighbors(args[0],args[1]||'out',args[2]||null));if(command==='path')return print(await graph.shortestPath(args[0],args[1],Number(args[2]||12)));if(command==='traverse')return print(await graph.traverse(args[0],{maxDepth:Number(args[1]||3)}));if(command==='pagerank')return print(await graph.pageRank(Number(args[0]||20)));if(command==='import')return print(await graph.importCollection(args[0],args[1]||'id'));console.log(`
JSONDB GRAPH MODEL

node graph-cli.js node Office '{"code":"ENG"}'
node graph-cli.js edge <from-id> <to-id> REPORTS_TO
node graph-cli.js neighbors <node-id> out
node graph-cli.js path <start> <target> 12
node graph-cli.js traverse <start> 3
node graph-cli.js pagerank 30
node graph-cli.js import tasks title

Row store + column store + full text + vector + graph.
JSONDB is now having an identity crisis professionally.
`)}main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
