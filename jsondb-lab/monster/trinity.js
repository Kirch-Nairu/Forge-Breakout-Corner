'use strict';

const path = require('path');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');
const { sha256 } = require('./savior');
const { ReedSolomonArk } = require('./erasure');
const { SurfaceParityArk } = require('./surfacecode');

class TrinityArk {
  constructor(engine,savior){
    this.engine=engine;this.savior=savior;this.root=path.join(savior.root,'trinity-ark');this.manifests=path.join(this.root,'manifests');
    this.rs=new ReedSolomonArk(path.join(this.root,'reed-solomon'),6,3);
    this.surface=new SurfaceParityArk(path.join(this.root,'surface-lattice'),4);
  }
  async init(){await ensureDir(this.root);await ensureDir(this.manifests);await this.rs.init();await this.surface.init()}
  async worldBuffer(label='trinity'){
    const payload={format:'JSONDB-TRINITY-WORLD-1',label,capturedAt:now(),catalog:await this.engine.catalog(),meta:await this.engine.meta(),tables:await this.savior.readCurrentTables(),inferredCatalog:await this.savior.inferCatalog()};
    return Buffer.from(JSON.stringify(payload));
  }
  async archive(label='trinity'){
    await this.init();const buffer=await this.worldBuffer(label);const expected=sha256(buffer);
    const xor=await this.savior.ark.archiveBuffer(`trinity:${label}`,buffer,{dataShards:6});
    const rs=await this.rs.archiveBuffer(`trinity:${label}`,buffer);
    const surface=await this.surface.archiveBuffer(`trinity:${label}`,buffer);
    const id=`${Date.now()}-${expected.slice(0,12)}`;
    const manifest={format:'JSONDB-TRINITY-ARK-1',id,label,createdAt:now(),expectedSha256:expected,quorum:2,decoders:{xor:{generation:xor.generation},reedSolomon:{generation:rs.generation},surface:{generation:surface.generation}},doctrine:'Two independent decoder families must reconstruct the expected world hash. One decoder may fail without losing trust.'};
    await atomicJson(path.join(this.manifests,`${id}.json`),manifest);await atomicJson(path.join(this.root,'latest.json'),manifest);return manifest;
  }
  async verify(id=null){
    await this.init();const m=id?await readJson(path.join(this.manifests,`${id}.json`),null):await readJson(path.join(this.root,'latest.json'),null);if(!m)throw new Error('No Trinity ARK manifest.');
    const decode=async(name,fn)=>{try{const r=await fn();return{name,healthy:r.healthy===true,hash:r.restoredSha256||null,repaired:r.repaired||[],damaged:r.damaged||[],buffer:r.buffer}}catch(e){return{name,healthy:false,hash:null,error:e.message}}};
    const results=[];
    results.push(await decode('xor',()=>this.savior.ark.verifyAndRepair(m.decoders.xor.generation)));
    results.push(await decode('reed-solomon',()=>this.rs.verifyAndRepair(m.decoders.reedSolomon.generation)));
    results.push(await decode('surface-lattice',()=>this.surface.verifyAndRepair(m.decoders.surface.generation)));
    const votes=new Map();for(const r of results)if(r.healthy&&r.hash)votes.set(r.hash,(votes.get(r.hash)||0)+1);const ranking=[...votes.entries()].sort((a,b)=>b[1]-a[1]);const winner=ranking[0]||null;const trusted=Boolean(winner&&winner[1]>=2&&winner[0]===m.expectedSha256);
    const degraded=Boolean(!trusted&&results.some(r=>r.healthy&&r.hash===m.expectedSha256));
    return{manifest:m,status:trusted?'TRUSTED':degraded?'DEGRADED':'LOST',trusted,expected:m.expectedSha256,winner:winner?{hash:winner[0],votes:winner[1]}:null,decoders:results.map(({buffer,...r})=>r),_buffers:results};
  }
  async restore(target,id=null,options={}){
    const v=await this.verify(id);if(v.status==='LOST')throw new Error('Trinity ARK could not reach a trustworthy decoder result.');if(v.status==='DEGRADED'&&!options.allowDegraded)throw new Error('Only one decoder recovered the expected world. Explicit degraded override required.');
    const source=v._buffers.find(r=>r.healthy&&r.hash===v.expected&&r.buffer);if(!source)throw new Error('No surviving decoder buffer available.');await require('fs/promises').mkdir(path.dirname(target),{recursive:true});await require('fs/promises').writeFile(target,source.buffer);return{target,status:v.status,decoder:source.name,sha256:v.expected};
  }
}

module.exports={TrinityArk};
