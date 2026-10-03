#!/usr/bin/env node
'use strict';
const{MonsterEngine}=require('./monster/engine');const{JsonSpatialIndex}=require('./monster/spatial');const engine=new MonsterEngine(__dirname);const spatial=new JsonSpatialIndex(engine);const[c='help',...a]=process.argv.slice(2);const p=x=>console.log(JSON.stringify(x,null,2));async function main(){await engine.init();if(c==='build')return p(await spatial.build(a[0],a[1],a[2]||'lat',a[3]||'lon',Number(a[4]||100)));if(c==='bbox')return p(await spatial.bbox(a[0],a[1],...a.slice(2,6).map(Number),Number(a[6]||1000)));if(c==='nearest')return p(await spatial.nearest(a[0],a[1],Number(a[2]),Number(a[3]),Number(a[4]||10)));console.log(`
JSONDB SPATIAL LAB

node spatial-cli.js build places geo lat lon 100
node spatial-cli.js bbox places geo 9.5 123.7 10.5 124.2
node spatial-cli.js nearest places geo 10.0 124.0 10

Uniform-grid candidate index + exact Haversine ranking.
Yes. The JSON folder does geospatial now.
`)}main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
