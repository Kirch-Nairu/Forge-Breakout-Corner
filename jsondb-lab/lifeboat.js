#!/usr/bin/env node
'use strict';

// Intentionally standalone. Node built-ins only. No MonsterEngine imports.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
async function readJson(file) { return JSON.parse(await fsp.readFile(file, 'utf8')); }

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(function initGF(){let x=1;for(let i=0;i<255;i++){EXP[i]=x;LOG[x]=i;x<<=1;if(x&0x100)x^=0x11d;}for(let i=255;i<512;i++)EXP[i]=EXP[i-255];})();
function mul(a,b){return(!a||!b)?0:EXP[LOG[a]+LOG[b]]} function inv(a){if(!a)throw new Error('GF inverse zero');return EXP[255-LOG[a]]}
function eye(n){return Array.from({length:n},(_,r)=>Array.from({length:n},(_,c)=>r===c?1:0))}
function invert(input){const n=input.length,a=input.map(r=>[...r]),b=eye(n);for(let c=0;c<n;c++){let p=c;while(p<n&&!a[p][c])p++;if(p===n)throw new Error('singular matrix');if(p!==c){[a[p],a[c]]=[a[c],a[p]];[b[p],b[c]]=[b[c],b[p]]}const s=inv(a[c][c]);for(let j=0;j<n;j++){a[c][j]=mul(a[c][j],s);b[c][j]=mul(b[c][j],s)}for(let r=0;r<n;r++){if(r===c||!a[r][c])continue;const f=a[r][c];for(let j=0;j<n;j++){a[r][j]^=mul(f,a[c][j]);b[r][j]^=mul(f,b[c][j])}}}return b}
function combine(row,shards,size){const out=Buffer.alloc(size);for(let s=0;s<row.length;s++){if(!row[s])continue;for(let i=0;i<size;i++)out[i]^=mul(row[s],shards[s][i])}return out}

async function decodeXor(root,generation){
  const dir=path.join(root,'ark','archives',generation),m=await readJson(path.join(dir,'manifest.json'));const shards=[];const bad=[];
  for(const spec of m.shards){try{const p=await readJson(path.join(dir,spec.file)),b=Buffer.from(p.base64,'base64');if(sha256(b)!==spec.sha256)throw new Error('checksum');shards[spec.index]=b}catch(e){bad.push(spec.index);shards[spec.index]=null}}
  if(bad.length>1)return{ok:false,decoder:'xor',bad,reason:'more than one missing/corrupt shard'};
  if(bad.length===1){const miss=bad[0],r=Buffer.alloc(m.shardSize);for(let s=0;s<shards.length;s++)if(s!==miss&&shards[s])for(let i=0;i<r.length;i++)r[i]^=shards[s][i];shards[miss]=r;if(sha256(r)!==m.shards[miss].sha256)return{ok:false,decoder:'xor',bad,reason:'parity reconstruction checksum mismatch'}}
  const buffer=Buffer.concat(shards.slice(0,m.dataShards)).subarray(0,m.originalBytes),hash=sha256(buffer);
  return{ok:hash===m.originalSha256,decoder:'xor',hash,expected:m.originalSha256,bad,buffer};
}

async function decodeRS(root,generation){
  const dir=path.join(root,'orthogonal-ark','reed-solomon','archives',generation),m=await readJson(path.join(dir,'manifest.json'));const shards=new Array(m.shards.length).fill(null),bad=[];
  for(const spec of m.shards){try{const p=await readJson(path.join(dir,spec.file)),b=Buffer.from(p.base64,'base64');if(sha256(b)!==spec.sha256)throw new Error('checksum');shards[spec.index]=b}catch(e){bad.push(spec.index)}}
  if(bad.length>m.parityShards)return{ok:false,decoder:'reed-solomon',bad,reason:'erasure count exceeds parity'};
  const available=[];for(let i=0;i<shards.length&&available.length<m.dataShards;i++)if(shards[i])available.push(i);
  if(available.length<m.dataShards)return{ok:false,decoder:'reed-solomon',bad,reason:'not enough surviving shards'};
  let inverse;try{inverse=invert(available.map(i=>m.generator[i]))}catch(e){return{ok:false,decoder:'reed-solomon',bad,reason:e.message}}
  const selected=available.map(i=>shards[i]);const data=inverse.map(row=>combine(row,selected,m.shardSize));const buffer=Buffer.concat(data).subarray(0,m.originalBytes),hash=sha256(buffer);
  return{ok:hash===m.originalSha256,decoder:'reed-solomon',hash,expected:m.originalSha256,bad,buffer};
}

async function main(){
  const args=process.argv.slice(2);const saviorRoot=path.resolve(args[0]||path.join(__dirname,'monster-data','advanced','savior'));const output=path.resolve(args[1]||path.join(process.cwd(),`jsondb-rescued-${Date.now()}.json`));const allow=args.includes('--allow-degraded');
  const latest=await readJson(path.join(saviorRoot,'orthogonal-ark','latest.json'));
  const xor=await decodeXor(saviorRoot,latest.encoders.xor.generation).catch(e=>({ok:false,decoder:'xor',reason:e.message}));
  const rs=await decodeRS(saviorRoot,latest.encoders.reedSolomon.generation).catch(e=>({ok:false,decoder:'reed-solomon',reason:e.message}));
  console.log(JSON.stringify({expected:latest.worldSha256,xor:{...xor,buffer:undefined},reedSolomon:{...rs,buffer:undefined}},null,2));
  if(xor.ok&&rs.ok&&xor.hash===rs.hash&&xor.hash===latest.worldSha256){await fsp.writeFile(output,xor.buffer);console.log(`\nSTRONG RECOVERY -> ${output}`);return}
  const survivor=xor.ok&&xor.hash===latest.worldSha256?xor:rs.ok&&rs.hash===latest.worldSha256?rs:null;
  if(survivor&&allow){await fsp.writeFile(output,survivor.buffer);console.log(`\nDEGRADED OVERRIDE via ${survivor.decoder} -> ${output}`);return}
  if(survivor)throw new Error(`Only ${survivor.decoder} survived. Refusing degraded restore without --allow-degraded.`);
  throw new Error('No decoder reconstructed the expected world. Lifeboat refuses to fabricate data.');
}

main().catch(e=>{console.error(`LIFEBOAT FAILURE: ${e.message}`);process.exitCode=1});
