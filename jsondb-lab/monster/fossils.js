'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');
const { canonical } = require('./truth');

function stable(value){return JSON.stringify(canonical(value));}
function hash(value){return crypto.createHash('sha256').update(typeof value==='string'?value:stable(value)).digest('hex');}
function clone(v){return JSON.parse(JSON.stringify(v));}
function same(a,b){return stable(a)===stable(b);}

class SemanticDeltaFossils{
  constructor({savior,memory}){this.savior=savior;this.memory=memory;this.root=path.join(savior.root,'semantic-delta-fossils');this.records=path.join(this.root,'records');}
  async init(){await ensureDir(this.records);}

  diffWorld(before,after){
    const changes=[];
    for(const field of ['catalog','meta'])if(!same(before?.[field],after?.[field]))changes.push({kind:'root',field,before:clone(before?.[field]??null),after:clone(after?.[field]??null)});
    const beforeTables=before?.tables||{},afterTables=after?.tables||{};
    const names=new Set([...Object.keys(beforeTables),...Object.keys(afterTables)]);
    for(const name of [...names].sort()){
      const a=beforeTables[name],b=afterTables[name];
      if(!a&&b){changes.push({kind:'table',table:name,before:null,after:clone(b)});continue;}
      if(a&&!b){changes.push({kind:'table',table:name,before:clone(a),after:null});continue;}
      if(!same(a?.meta,b?.meta))changes.push({kind:'table-meta',table:name,before:clone(a?.meta??null),after:clone(b?.meta??null)});
      const A=new Map((a?.rows||[]).filter(r=>r&&r.id!=null).map(r=>[String(r.id),r]));
      const B=new Map((b?.rows||[]).filter(r=>r&&r.id!=null).map(r=>[String(r.id),r]));
      const ids=new Set([...A.keys(),...B.keys()]);
      for(const id of [...ids].sort()){
        const x=A.get(id)||null,y=B.get(id)||null;
        if(!same(x,y))changes.push({kind:'row',table:name,id,before:x?clone(x):null,after:y?clone(y):null});
      }
    }
    return changes;
  }

  patchView(changes,direction){
    return changes.map(c=>({kind:c.kind,field:c.field,table:c.table,id:c.id,value:clone(direction==='forward'?c.after:c.before)}));
  }

  apply(world,changes,direction='forward'){
    const out=clone(world);out.tables||={};const value=c=>clone(direction==='forward'?c.after:c.before);
    for(const c of changes){
      const v=value(c);
      if(c.kind==='root'){out[c.field]=v;continue;}
      if(c.kind==='table'){if(v==null)delete out.tables[c.table];else out.tables[c.table]=v;continue;}
      if(c.kind==='table-meta'){
        if(!out.tables[c.table])throw new Error(`Fossil apply missing table ${c.table}`);
        out.tables[c.table].meta=v;continue;
      }
      if(c.kind==='row'){
        if(!out.tables[c.table])throw new Error(`Fossil apply missing table ${c.table}`);
        const rows=out.tables[c.table].rows||=[];const i=rows.findIndex(r=>String(r.id)===String(c.id));
        if(v==null){if(i>=0)rows.splice(i,1);}else if(i>=0)rows[i]=v;else rows.push(v);
        rows.sort((a,b)=>String(a.id).localeCompare(String(b.id)));continue;
      }
      throw new Error(`Unknown fossil change kind ${c.kind}`);
    }
    return out;
  }

  async memoryWorld(id){
    const v=await this.memory.verify(id,{repairPrimary:true});
    if(!v.valid||!v._buffer)throw new Error(`Memory Palace endpoint unavailable: ${id} (${v.status})`);
    return JSON.parse(v._buffer.toString('utf8'));
  }

  async capture(label='fossil'){
    await this.init();
    const previous=await readJson(path.join(this.memory.root,'latest.json'),null);
    const current=await this.memory.snapshot(`${label}:fossil-endpoint`);
    if(!previous){
      const genesis={format:'JSONDB-SEMANTIC-FOSSIL-GENESIS-1',id:`${Date.now()}-genesis`,label,createdAt:now(),toMemoryId:current.id,toWorldSha256:current.worldSha256,changes:0};
      await atomicJson(path.join(this.root,'latest.json'),genesis);return genesis;
    }
    const [before,after]=await Promise.all([this.memoryWorld(previous.id),this.memoryWorld(current.id)]);
    const changes=this.diffWorld(before,after);
    const forward=this.patchView(changes,'forward'),inverse=this.patchView(changes,'inverse');
    const record={
      format:'JSONDB-SEMANTIC-DELTA-FOSSIL-1',
      id:`${Date.now()}-${crypto.randomBytes(5).toString('hex')}`,label,createdAt:now(),
      from:{memoryId:previous.id,worldSha256:previous.worldSha256},
      to:{memoryId:current.id,worldSha256:current.worldSha256},
      changeCount:changes.length,changes,
      forwardPatchHash:hash(forward),inversePatchHash:hash(inverse),
      doctrine:'A fossil is reversible semantic history between two independently content-addressed Memory Palace worlds. Recovery remains sandbox-only.'
    };
    record.fossilHash=hash(record);
    await atomicJson(path.join(this.records,`${record.id}.json`),record);await atomicJson(path.join(this.root,'latest.json'),record);return record;
  }

  async verify(id=null){
    await this.init();
    const record=id?await readJson(path.join(this.records,`${id}.json`),null):await readJson(path.join(this.root,'latest.json'),null);
    if(!record)return{valid:false,status:'ABSENT'};
    if(record.format==='JSONDB-SEMANTIC-FOSSIL-GENESIS-1')return{valid:true,status:'GENESIS',record};
    const copy={...record};delete copy.fossilHash;const staticValid=hash(copy)===record.fossilHash;
    const forwardHash=hash(this.patchView(record.changes||[],'forward')),inverseHash=hash(this.patchView(record.changes||[],'inverse'));
    const [before,after]=await Promise.all([this.memoryWorld(record.from.memoryId),this.memoryWorld(record.to.memoryId)]);
    const forwardWorld=this.apply(before,record.changes||[],'forward'),inverseWorld=this.apply(after,record.changes||[],'inverse');
    const forwardWorldHash=hash(forwardWorld),inverseWorldHash=hash(inverseWorld),expectedAfterHash=hash(after),expectedBeforeHash=hash(before);
    return{
      format:'JSONDB-SEMANTIC-DELTA-FOSSIL-VERIFY-1',id:record.id,
      valid:staticValid&&forwardHash===record.forwardPatchHash&&inverseHash===record.inversePatchHash&&forwardWorldHash===expectedAfterHash&&inverseWorldHash===expectedBeforeHash,
      staticValid,
      forward:{patchHashValid:forwardHash===record.forwardPatchHash,reconstructedWorldHash:forwardWorldHash,expectedWorldHash:expectedAfterHash,valid:forwardWorldHash===expectedAfterHash},
      inverse:{patchHashValid:inverseHash===record.inversePatchHash,reconstructedWorldHash:inverseWorldHash,expectedWorldHash:expectedBeforeHash,valid:inverseWorldHash===expectedBeforeHash},
      endpoints:{from:record.from,to:record.to},changeCount:record.changeCount
    };
  }

  async reconstruct(id,direction,target){
    const record=await readJson(path.join(this.records,`${id}.json`),null);if(!record)throw new Error(`Fossil not found: ${id}`);
    const sourceId=direction==='inverse'?record.to.memoryId:record.from.memoryId;
    const source=await this.memoryWorld(sourceId);const world=this.apply(source,record.changes||[],direction==='inverse'?'inverse':'forward');
    await ensureDir(path.dirname(target));await require('fs/promises').writeFile(target,`${JSON.stringify(world,null,2)}\n`,'utf8');
    return{target,direction,sha256:hash(world),fossilId:id};
  }
}

module.exports={SemanticDeltaFossils};
