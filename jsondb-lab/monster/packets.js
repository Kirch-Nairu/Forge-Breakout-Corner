'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, uuid, ensureDir, atomicJson } = require('./jsonfs');
const { gfMul, matrixInvert, generatorMatrix } = require('./erasure');

function sha256(value){return crypto.createHash('sha256').update(value).digest('hex')}
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));return value}
function descriptorHash(d){return sha256(Buffer.from(JSON.stringify(stable(d))))}
function combine(row,shards,size){const out=Buffer.alloc(size);for(let s=0;s<row.length;s++){const coef=row[s];if(!coef)continue;for(let i=0;i<size;i++)out[i]^=gfMul(coef,shards[s][i])}return out}

class SelfDescribingPacketArk {
  constructor(root,dataShards=6,parityShards=3){this.root=root;this.k=dataShards;this.m=parityShards;this.generator=generatorMatrix(this.k,this.m)}
  async init(){await ensureDir(this.root)}
  encode(buffer){const size=Math.ceil(buffer.length/this.k)||1,padded=Buffer.alloc(size*this.k);buffer.copy(padded);const data=Array.from({length:this.k},(_,i)=>Buffer.from(padded.subarray(i*size,(i+1)*size)));const all=[...data];for(let i=this.k;i<this.k+this.m;i++)all.push(combine(this.generator[i],data,size));return{all,size}}
  async create(logicalName,buffer,metadata={}){
    await this.init();const setId=uuid(),e=this.encode(buffer);const descriptor={format:'JSONDB-SELF-DESCRIBING-RS-PACKET-1',setId,logicalName,createdAt:now(),dataShards:this.k,parityShards:this.m,shardSize:e.size,originalBytes:buffer.length,originalSha256:sha256(buffer),generator:this.generator,metadata};const dHash=descriptorHash(descriptor);const files=[];
    for(let i=0;i<e.all.length;i++){const bytes=e.all[i],packet={...descriptor,descriptorHash:dHash,index:i,kind:i<this.k?'data':'parity',packetSha256:sha256(bytes),base64:bytes.toString('base64')};const file=path.join(this.root,`${setId}-packet-${String(i).padStart(2,'0')}.json`);await atomicJson(file,packet);files.push(file)}
    return{setId,descriptorHash:dHash,originalSha256:descriptor.originalSha256,requiredPackets:this.k,totalPackets:this.k+this.m,files,note:'Any dataShards valid packets with one matching descriptor can reconstruct without a separate manifest.'};
  }
  async scan(dir=this.root){const groups=new Map();for(const name of await fsp.readdir(dir).catch(()=>[])){if(!name.endsWith('.json'))continue;let p;try{p=JSON.parse(await fsp.readFile(path.join(dir,name),'utf8'))}catch{continue}if(p.format!=='JSONDB-SELF-DESCRIBING-RS-PACKET-1')continue;const descriptor={format:p.format,setId:p.setId,logicalName:p.logicalName,createdAt:p.createdAt,dataShards:p.dataShards,parityShards:p.parityShards,shardSize:p.shardSize,originalBytes:p.originalBytes,originalSha256:p.originalSha256,generator:p.generator,metadata:p.metadata};const dh=descriptorHash(descriptor);if(dh!==p.descriptorHash)continue;let bytes;try{bytes=Buffer.from(p.base64,'base64')}catch{continue}if(sha256(bytes)!==p.packetSha256)continue;const key=`${p.setId}:${p.descriptorHash}`;if(!groups.has(key))groups.set(key,{descriptor,descriptorHash:p.descriptorHash,packets:[]});groups.get(key).packets.push({index:p.index,kind:p.kind,bytes,file:path.join(dir,name)})}return[...groups.values()].map(g=>({...g,packets:g.packets.sort((a,b)=>a.index-b.index)}))}
  recoverGroup(group){const d=group.descriptor;if(group.packets.length<d.dataShards)throw new Error(`Need ${d.dataShards} valid packets; found ${group.packets.length}`);const chosen=group.packets.slice(0,d.dataShards),matrix=chosen.map(p=>d.generator[p.index]),inverse=matrixInvert(matrix),selected=chosen.map(p=>p.bytes),data=inverse.map(row=>combine(row,selected,d.shardSize)),buffer=Buffer.concat(data).subarray(0,d.originalBytes),hash=sha256(buffer);if(hash!==d.originalSha256)throw new Error(`Recovered hash mismatch ${hash} != ${d.originalSha256}`);return{buffer,sha256:hash,setId:d.setId,usedPackets:chosen.map(p=>p.index),availablePackets:group.packets.map(p=>p.index),descriptorHash:group.descriptorHash}}
  async recover(dir=this.root,setId=null){const groups=await this.scan(dir);const candidates=groups.filter(g=>(!setId||g.descriptor.setId===setId)&&g.packets.length>=g.descriptor.dataShards).sort((a,b)=>b.packets.length-a.packets.length);const errors=[];for(const group of candidates){try{return this.recoverGroup(group)}catch(e){errors.push({setId:group.descriptor.setId,error:e.message})}}throw Object.assign(new Error('No packet group could reconstruct a valid world.'),{details:errors,groups:groups.map(g=>({setId:g.descriptor.setId,validPackets:g.packets.length,required:g.descriptor.dataShards}))})}
  async recoverTo(dir,target,setId=null){const result=await this.recover(dir,setId);await ensureDir(path.dirname(target));await fsp.writeFile(target,result.buffer);return{target,sha256:result.sha256,setId:result.setId,usedPackets:result.usedPackets,availablePackets:result.availablePackets}}
}

module.exports={SelfDescribingPacketArk,descriptorHash};
