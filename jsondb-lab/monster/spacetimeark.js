'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson, hashFile } = require('./jsonfs');

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function safe(v) { return String(v || 'spacetime').replace(/[^A-Za-z0-9_.-]/g, '_'); }
function xorInto(target, source) { for (let i = 0; i < target.length; i++) target[i] ^= source[i]; return target; }

class SpacetimeArk {
  constructor({ savior, omegaEpochRoot, constellation = null }) {
    this.savior = savior;
    this.omegaEpochRoot = omegaEpochRoot;
    this.epochDir = path.join(omegaEpochRoot, 'epochs');
    this.constellation = constellation;
    this.root = path.join(savior.root, 'spacetime-ark');
    this.generations = path.join(this.root, 'generations');
    this.placements = path.join(this.root, 'placements');
  }

  async init() { await ensureDir(this.generations); await ensureDir(this.placements); }

  async recentEpochFiles(limit = 8) {
    const names = (await fsp.readdir(this.epochDir).catch(() => [])).filter(x => x.endsWith('.json'));
    const rows=[];
    for(const name of names){const file=path.join(this.epochDir,name);const stat=await fsp.stat(file).catch(()=>null);if(stat)rows.push({name,file,mtimeMs:stat.mtimeMs});}
    rows.sort((a,b)=>a.mtimeMs-b.mtimeMs||a.name.localeCompare(b.name));
    return rows.slice(-Math.max(2,Math.min(32,Number(limit||8))));
  }

  cellName(row,col){return `cell-r${String(row).padStart(3,'0')}-c${String(col).padStart(3,'0')}.json`;}

  async seal(label='spacetime',options={}){
    await this.init();
    const epochs=await this.recentEpochFiles(options.epochs||8);
    if(epochs.length<2)throw new Error('Spacetime ARK requires at least two OMEGA epochs.');
    const dataColumns=Math.max(2,Math.min(32,Number(options.dataColumns||6)));
    const buffers=await Promise.all(epochs.map(x=>fsp.readFile(x.file)));
    const shardSize=Math.max(1,...buffers.map(b=>Math.ceil(b.length/dataColumns)));
    const rows=epochs.length, cols=dataColumns;
    const grid=Array.from({length:rows+1},()=>Array(cols+1).fill(null));

    for(let r=0;r<rows;r++){
      const padded=Buffer.alloc(shardSize*cols);buffers[r].copy(padded);
      const rowParity=Buffer.alloc(shardSize);
      for(let c=0;c<cols;c++){
        const cell=Buffer.from(padded.subarray(c*shardSize,(c+1)*shardSize));
        grid[r][c]=cell;xorInto(rowParity,cell);
      }
      grid[r][cols]=rowParity;
    }
    for(let c=0;c<=cols;c++){
      const temporal=Buffer.alloc(shardSize);
      for(let r=0;r<rows;r++)xorInto(temporal,grid[r][c]);
      grid[rows][c]=temporal;
    }

    const id=`${Date.now()}-${safe(label)}-${crypto.randomBytes(4).toString('hex')}`;
    const dir=path.join(this.generations,id);await ensureDir(dir);
    const cells=[];
    for(let r=0;r<=rows;r++)for(let c=0;c<=cols;c++){
      const buf=grid[r][c];
      const kind=r===rows&&c===cols?'corner-parity':r===rows?'time-parity':c===cols?'row-parity':'data';
      const file=this.cellName(r,c);
      const doc={format:'JSONDB-SPACETIME-CELL-1',generation:id,row:r,column:c,kind,bytes:buf.length,sha256:sha(buf),base64:buf.toString('base64')};
      await atomicJson(path.join(dir,file),doc);cells.push({row:r,column:c,kind,file,sha256:doc.sha256});
    }
    const manifest={
      format:'JSONDB-SPACETIME-ARK-1',id,label,createdAt:now(),
      geometry:{dataRows:rows,dataColumns:cols,totalRows:rows+1,totalColumns:cols+1,shardSize},
      epochs:epochs.map((x,i)=>({row:i,file:x.name,bytes:buffers[i].length,sha256:sha(buffers[i])})),
      cells,
      code:'2-D XOR product code: each data row has spatial parity and each column has temporal parity. Bottom-right parity closes both dimensions.',
      recovery:'Iteratively solve any row or column containing exactly one erased cell. Repeat until stable, then reconstruct epoch bytes from data columns.',
      limitation:'Not all multi-erasure patterns are peelable. Rectangular cycles with no row/column containing a single unknown can remain unresolved.'
    };
    await atomicJson(path.join(dir,'manifest.json'),manifest);
    await atomicJson(path.join(this.root,'latest.json'),{id,createdAt:manifest.createdAt});
    return manifest;
  }

  async load(id=null,options={}){
    const readOnly=options.readOnly===true;
    if(!readOnly)await this.init();
    if(!id)id=(await readJson(path.join(this.root,'latest.json'),null))?.id;
    if(!id){const error=new Error('No Spacetime ARK generation.');error.code='SPACETIME_ARK_ABSENT';throw error;}
    const dir=path.join(this.generations,id),manifest=await readJson(path.join(dir,'manifest.json'),null);
    if(!manifest)throw new Error(`Spacetime ARK generation not found: ${id}`);
    return{dir,manifest,readOnly};
  }

  async readCell(file,spec){const doc=await readJson(file,null);if(!doc?.base64)throw new Error('missing cell payload');const buf=Buffer.from(doc.base64,'base64');if(sha(buf)!==spec.sha256)throw new Error('cell checksum mismatch');return buf;}

  async inspect(id=null,sourceDir=null,options={}){
    const readOnly=options.readOnly===true;
    let loaded;
    try{loaded=await this.load(id,{readOnly});}
    catch(error){if(readOnly&&error.code==='SPACETIME_ARK_ABSENT')return{status:'ABSENT',valid:false,readOnly,manifest:null,states:[],erasures:0};throw error;}
    const {dir,manifest}=loaded;const base=sourceDir||dir;
    const grid=Array.from({length:manifest.geometry.totalRows},()=>Array(manifest.geometry.totalColumns).fill(null));const states=[];
    for(const spec of manifest.cells){try{const buf=await this.readCell(path.join(base,spec.file),spec);grid[spec.row][spec.column]=buf;states.push({...spec,state:'GOOD'});}catch(error){states.push({...spec,state:'ERASED',error:error.message});}}
    return{status:'PRESENT',valid:true,readOnly,manifest,base,grid,states,erasures:states.filter(x=>x.state!=='GOOD').length};
  }

  solveLine(values,missingIndex,shardSize){const recovered=Buffer.alloc(shardSize);for(let i=0;i<values.length;i++){if(i===missingIndex||!values[i])continue;xorInto(recovered,values[i]);}return recovered;}

  async recover(id=null,options={}){
    const readOnly=options.readOnly===true;
    const inspection=await this.inspect(id,options.sourceDir||null,{readOnly});
    if(inspection.status==='ABSENT')return{format:'JSONDB-SPACETIME-RECOVERY-2',status:'ABSENT',valid:false,readOnly,generation:null,epochs:[],recoveredCells:[],unresolved:[]};
    const {manifest,grid}=inspection;const R=manifest.geometry.totalRows,C=manifest.geometry.totalColumns,shardSize=manifest.geometry.shardSize;
    const recoveredCells=[];let progress=true,rounds=0;
    while(progress){progress=false;rounds++;
      for(let r=0;r<R;r++){
        const missing=[];for(let c=0;c<C;c++)if(!grid[r][c])missing.push(c);
        if(missing.length===1){const c=missing[0];grid[r][c]=this.solveLine(grid[r],c,shardSize);recoveredCells.push({row:r,column:c,via:'row'});progress=true;}
      }
      for(let c=0;c<C;c++){
        const column=Array.from({length:R},(_,r)=>grid[r][c]);const missing=[];for(let r=0;r<R;r++)if(!column[r])missing.push(r);
        if(missing.length===1){const r=missing[0];grid[r][c]=this.solveLine(column,r,shardSize);recoveredCells.push({row:r,column:c,via:'column'});progress=true;}
      }
      if(rounds>R*C+2)break;
    }
    const unresolved=[];for(let r=0;r<R;r++)for(let c=0;c<C;c++)if(!grid[r][c])unresolved.push({row:r,column:c});
    const epochResults=[];const sandbox=readOnly?null:path.join(this.root,'recovered',manifest.id);
    if(!readOnly)await ensureDir(sandbox);
    for(const epoch of manifest.epochs){
      const data=[];let complete=true;for(let c=0;c<manifest.geometry.dataColumns;c++){if(!grid[epoch.row][c]){complete=false;break;}data.push(grid[epoch.row][c]);}
      if(!complete){epochResults.push({file:epoch.file,status:'UNRESOLVED'});continue;}
      const bytes=Buffer.concat(data).subarray(0,epoch.bytes);const actual=sha(bytes);const valid=actual===epoch.sha256;
      const target=readOnly?null:path.join(sandbox,epoch.file);if(valid&&!readOnly)await fsp.writeFile(target,bytes);
      epochResults.push({file:epoch.file,status:valid?'RECOVERED':'HASH_MISMATCH',target:valid?target:null,expected:epoch.sha256,actual});
    }
    const status=unresolved.length?'PARTIAL':epochResults.every(x=>x.status==='RECOVERED')?'RECOVERED':'FAILED';
    return{
      format:'JSONDB-SPACETIME-RECOVERY-2',generation:manifest.id,status,valid:['RECOVERED','PARTIAL'].includes(status),readOnly,
      originalErasures:inspection.erasures,recoveredCells,unresolved,rounds,epochs:epochResults,sandbox,
      doctrine:readOnly?'Forensic recovery proves reconstructability in memory and writes no sandbox artifacts.':'Recovered epochs are written to a sandbox. Spacetime ARK does not promote or overwrite canonical history.'
    };
  }

  async scatter(id=null,options={}){
    if(!this.constellation)throw new Error('Spacetime ARK has no Media Constellation.');
    const {dir,manifest}=await this.load(id);const assessment=await this.constellation.assess();const media=assessment.registry?.media||[];if(!media.length)throw new Error('No registered media for Spacetime scatter.');
    const placements=[];const copies=Math.max(1,Math.min(media.length,Number(options.copiesPerCell||1)));
    for(const spec of manifest.cells){
      for(let copy=0;copy<copies;copy++){
        const medium=media[(spec.column+spec.row+copy)%media.length];
        const targetDir=path.join(medium.root,'JSONDB-SURVIVAL','spacetime-ark',manifest.id);await ensureDir(targetDir);
        const source=path.join(dir,spec.file),target=path.join(targetDir,spec.file);await fsp.copyFile(source,target);
        placements.push({row:spec.row,column:spec.column,file:spec.file,copy:copy+1,media:medium.name,deviceKey:medium.inspection?.deviceKey||null,target,sha256:await hashFile(target)});
      }
    }
    for(const medium of media){const targetDir=path.join(medium.root,'JSONDB-SURVIVAL','spacetime-ark',manifest.id);await ensureDir(targetDir);await fsp.copyFile(path.join(dir,'manifest.json'),path.join(targetDir,'manifest.json'));}
    const receipt={format:'JSONDB-SPACETIME-PLACEMENT-1',id:`${Date.now()}-${manifest.id}`,at:now(),generation:manifest.id,copiesPerCell:copies,registeredMedia:media.length,distinctDeviceKeys:new Set(placements.map(x=>x.deviceKey).filter(Boolean)).size,placements,warning:'Rotating placement improves apparent failure-domain spread but deviceKey does not prove independent controller, power, site, or operator domains.'};
    await atomicJson(path.join(this.placements,`${receipt.id}.json`),receipt);await atomicJson(path.join(this.root,'latest-placement.json'),receipt);return receipt;
  }
}

module.exports={SpacetimeArk};
