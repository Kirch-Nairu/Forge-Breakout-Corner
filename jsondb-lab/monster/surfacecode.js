'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, uuid, ensureDir, exists, readJson, atomicJson, merkleRoot } = require('./jsonfs');

function sha256(buf){return crypto.createHash('sha256').update(buf).digest('hex')}
function xorBuffers(buffers,size){const out=Buffer.alloc(size);for(const b of buffers)if(b)for(let i=0;i<size;i++)out[i]^=b[i];return out}

class SurfaceParityArk {
  constructor(root, side = 4) {
    this.root = root;
    this.archives = path.join(root,'archives');
    this.quarantine = path.join(root,'quarantine');
    this.side = Math.max(2,Math.min(12,Number(side||4)));
  }

  async init(){await ensureDir(this.archives);await ensureDir(this.quarantine)}

  encode(buffer){
    const dataCount=this.side*this.side;
    const shardSize=Math.ceil(buffer.length/dataCount)||1;
    const padded=Buffer.alloc(shardSize*dataCount);buffer.copy(padded);
    const data=Array.from({length:dataCount},(_,i)=>Buffer.from(padded.subarray(i*shardSize,(i+1)*shardSize)));
    const rows=[],cols=[];
    for(let r=0;r<this.side;r++)rows.push(xorBuffers(data.slice(r*this.side,(r+1)*this.side),shardSize));
    for(let c=0;c<this.side;c++){const parts=[];for(let r=0;r<this.side;r++)parts.push(data[r*this.side+c]);cols.push(xorBuffers(parts,shardSize))}
    return{data,rows,cols,shardSize,originalBytes:buffer.length};
  }

  async archiveBuffer(logicalName,buffer){
    await this.init();const generation=`${now().replace(/[:.]/g,'-')}-${uuid().slice(0,8)}`;const dir=path.join(this.archives,generation);await ensureDir(dir);
    const e=this.encode(buffer);const shards=[];
    const write=async(kind,index,buf,meta={})=>{const file=`${kind}-${String(index).padStart(2,'0')}.json`;const payload={format:'JSONDB-SURFACE-SHARD-1',kind,index,...meta,sha256:sha256(buf),base64:buf.toString('base64')};await atomicJson(path.join(dir,file),payload);shards.push({kind,index,file,sha256:payload.sha256,...meta})};
    for(let i=0;i<e.data.length;i++)await write('data',i,e.data[i],{row:Math.floor(i/this.side),col:i%this.side});
    for(let i=0;i<e.rows.length;i++)await write('row-parity',i,e.rows[i],{row:i});
    for(let i=0;i<e.cols.length;i++)await write('col-parity',i,e.cols[i],{col:i});
    const manifest={format:'JSONDB-SURFACE-PARITY-1',inspiration:'classical 2-D parity with syndrome-like recovery; not quantum error correction',generation,logicalName,createdAt:now(),side:this.side,dataShards:e.data.length,rowParityShards:e.rows.length,colParityShards:e.cols.length,shardSize:e.shardSize,originalBytes:e.originalBytes,originalSha256:sha256(buffer),shards};
    manifest.merkleRoot=merkleRoot(shards.map(x=>x.sha256));await atomicJson(path.join(dir,'manifest.json'),manifest);return manifest;
  }

  async load(dir,manifest){
    const state={data:new Array(manifest.dataShards).fill(null),rows:new Array(manifest.rowParityShards).fill(null),cols:new Array(manifest.colParityShards).fill(null),damaged:[]};
    for(const spec of manifest.shards){try{const p=await readJson(path.join(dir,spec.file),null),b=Buffer.from(p?.base64||'','base64');if(!p?.base64||sha256(b)!==spec.sha256)throw new Error('checksum mismatch');if(spec.kind==='data')state.data[spec.index]=b;else if(spec.kind==='row-parity')state.rows[spec.index]=b;else state.cols[spec.index]=b}catch(e){state.damaged.push({...spec,reason:e.message})}}
    return state;
  }

  peel(state,manifest){
    const missing=new Set();for(let i=0;i<state.data.length;i++)if(!state.data[i])missing.add(i);const recovered=[];let progress=true;
    while(progress&&missing.size){progress=false;
      for(let r=0;r<manifest.side;r++){
        if(!state.rows[r])continue;const ids=[];for(let c=0;c<manifest.side;c++){const i=r*manifest.side+c;if(missing.has(i))ids.push(i)}
        if(ids.length===1){const target=ids[0],parts=[state.rows[r]];for(let c=0;c<manifest.side;c++){const i=r*manifest.side+c;if(i!==target)parts.push(state.data[i])}state.data[target]=xorBuffers(parts,manifest.shardSize);missing.delete(target);recovered.push({index:target,via:`row-${r}`});progress=true}
      }
      for(let c=0;c<manifest.side;c++){
        if(!state.cols[c])continue;const ids=[];for(let r=0;r<manifest.side;r++){const i=r*manifest.side+c;if(missing.has(i))ids.push(i)}
        if(ids.length===1){const target=ids[0],parts=[state.cols[c]];for(let r=0;r<manifest.side;r++){const i=r*manifest.side+c;if(i!==target)parts.push(state.data[i])}state.data[target]=xorBuffers(parts,manifest.shardSize);missing.delete(target);recovered.push({index:target,via:`col-${c}`});progress=true}
      }
    }
    return{remaining:[...missing],recovered};
  }

  async verifyAndRepair(generation){
    await this.init();const dir=path.join(this.archives,generation),m=await readJson(path.join(dir,'manifest.json'),null);if(!m)throw new Error(`Surface archive not found ${generation}`);const state=await this.load(dir,m);const peeled=this.peel(state,m);
    if(peeled.remaining.length)return{generation,healthy:false,recoverable:false,damaged:state.damaged,recovered:peeled.recovered,remaining:peeled.remaining,reason:'erasure pattern contains an unrecoverable parity cycle'};
    const buffer=Buffer.concat(state.data).subarray(0,m.originalBytes),hash=sha256(buffer);if(hash!==m.originalSha256)return{generation,healthy:false,recoverable:false,damaged:state.damaged,reason:'reconstructed world hash mismatch'};
    const repaired=[];
    for(const fault of state.damaged){
      let buf;if(fault.kind==='data')buf=state.data[fault.index];else if(fault.kind==='row-parity')buf=xorBuffers(state.data.slice(fault.index*m.side,(fault.index+1)*m.side),m.shardSize);else{const parts=[];for(let r=0;r<m.side;r++)parts.push(state.data[r*m.side+fault.index]);buf=xorBuffers(parts,m.shardSize)}
      if(sha256(buf)!==fault.sha256)continue;const target=path.join(dir,fault.file);if(await exists(target)){const q=path.join(this.quarantine,`${generation}-${fault.file}-${Date.now()}.json`);await fsp.rename(target,q).catch(()=>{})}await atomicJson(target,{format:'JSONDB-SURFACE-SHARD-1',kind:fault.kind,index:fault.index,row:fault.row,col:fault.col,sha256:fault.sha256,base64:buf.toString('base64'),repairedAt:now()});repaired.push(fault.file)
    }
    return{generation,healthy:true,recoverable:true,damaged:state.damaged,recovered:peeled.recovered,repaired,restoredSha256:hash,expectedSha256:m.originalSha256,buffer};
  }

  async restore(generation,target){const r=await this.verifyAndRepair(generation);if(!r.healthy)throw new Error(`Surface archive ${generation} unrecoverable`);await ensureDir(path.dirname(target));await fsp.writeFile(target,r.buffer);return{generation,target,sha256:r.restoredSha256,repaired:r.repaired}}
}

module.exports={SurfaceParityArk,xorBuffers};
