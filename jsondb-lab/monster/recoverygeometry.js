'use strict';

const path=require('path');const fsp=require('fs/promises');
const {now,ensureDir,readJson,atomicJson}=require('./jsonfs');

class RecoveryGeometry{
 constructor(kernel){this.k=kernel;this.root=path.join(kernel.savior.root,'recovery-geometry');this.records=path.join(this.root,'records');}
 async init(){await ensureDir(this.records);}
 async fileExists(file){try{await fsp.access(file);return true}catch{return false}}

 async capabilities(options={}){
  const disabled=new Set(options.remove||[]), cap={};
  const set=(name,available,evidence)=>cap[name]={available:Boolean(available)&&!disabled.has(name),disabled:disabled.has(name),evidence};
  const last=await readJson(path.join(this.k.lastSavior.root,'latest.json'),null);
  const memory=await this.k.memory.verify().catch(e=>({valid:false,error:e.message})); if(memory?._buffer)delete memory._buffer;
  const trinity=await this.k.trinity.verify().catch(e=>({status:'ERROR',error:e.message})); if(trinity?._buffers)delete trinity._buffers;
  const quaternary=await this.k.quaternary.recover().catch(e=>({status:'ERROR',error:e.message})); if(quaternary?.buffer)delete quaternary.buffer;
  const fossil=await this.k.fossils.verify().catch(e=>({valid:false,error:e.message}));
  const parity=await this.k.temporalParity.inspect().catch(e=>({damaged:Infinity,error:e.message})); if(parity?.grid)delete parity.grid; if(parity?.states)parity.states=parity.states.map(({buffer,...x})=>x); if(parity?.parity)parity.parity=parity.parity.map(({buffer,...x})=>x);
  const spacetime=await this.k.spacetime.recover().catch(e=>({status:'ERROR',error:e.message}));
  const weave=await this.k.timeWeave.verifyAll().catch(e=>({valid:false,error:e.message}));
  const braid=await this.k.braid.verify().catch(e=>({valid:false,error:e.message}));
  const chronicle=await this.k.chronicle.verify().catch(e=>({valid:false,error:e.message}));
  const forward=await this.k.forwardWitness.verifyAll().catch(e=>({valid:false,error:e.message}));
  const crypto=await this.k.cryptoCouncil.verify().catch(e=>({valid:false,error:e.message}));
  const hologram=await readJson(path.join(this.k.hologram.root,'latest.json'),null);
  const shadow=await this.k.shadowLaws.verifyRecord().catch(e=>({valid:false,error:e.message}));
  const diaspora=await readJson(path.join(this.k.diaspora.root,'latest-placement.json'),null);
  const media=await this.k.constellation.assess().catch(e=>({registry:{media:[]},comparison:{},error:e.message}));
  const seed=await readJson(path.join(this.k.civilizationSeed.root,'latest.json'),null);
  const rosetta=await this.k.rosetta.verify().catch(e=>({valid:false,error:e.message}));
  const python=seed?.directory?await this.fileExists(path.join(seed.directory,'lifeboat.py')):false;
  const node=seed?.directory?await this.fileExists(path.join(seed.directory,'lifeboat.js')):true;
  const fountain=await readJson(path.join(this.k.fountain.root,'latest.json'),null);
  const metamorphic=true;

  set('canonicalLive',true,{note:'current engine process can read canonical state; remove explicitly to simulate loss'});
  set('memoryPalace',memory.valid,{status:memory.status,id:memory.id});
  set('trinity',trinity.status==='TRUSTED',{status:trinity.status});
  set('quaternary',quaternary.status==='RECOVERED',{status:quaternary.status,generation:quaternary.generation});
  set('semanticFossil',fossil.valid,{status:fossil.status,id:fossil.id});
  set('temporalParity',Number(parity.damaged||0)<=2,{damaged:parity.damaged,error:parity.error});
  set('spacetimeArk',['RECOVERED','PARTIAL'].includes(spacetime.status),{status:spacetime.status,generation:spacetime.generation});
  set('timeWeave',weave.valid,{nodes:weave.nodes,invalid:weave.invalid?.length||0});
  set('crossHistoryBraid',braid.valid,{head:braid.head||null});
  set('semanticChronicle',chronicle.valid,{liveMatchesReplay:chronicle.liveMatchesReplay});
  set('forwardWitness',forward.valid,{records:forward.records,headHash:forward.headHash});
  set('dualCryptoCouncil',crypto.valid&&Number(crypto.familyQuorum||0)>=2,{status:crypto.status,familyQuorum:crypto.familyQuorum});
  set('semanticHologram',Boolean(hologram),{id:hologram?.id});
  set('shadowLaws',shadow.valid,{id:shadow.id});
  set('evidenceDiaspora',Boolean(diaspora&&Number(diaspora.validCopies||0)>0),{validCopies:diaspora?.validCopies||0,distinctDeviceKeys:diaspora?.distinctDeviceKeys||0,distinctLocations:diaspora?.distinctExpectedLocations||0});
  set('multiplePhysicalDevices',Number(diaspora?.distinctDeviceKeys||0)>=2,{distinctDeviceKeys:diaspora?.distinctDeviceKeys||0});
  set('threePhysicalDevices',Number(diaspora?.distinctDeviceKeys||0)>=3,{distinctDeviceKeys:diaspora?.distinctDeviceKeys||0});
  set('nodeRuntime',node,{seed:seed?.id||null});
  set('pythonRuntime',python,{seed:seed?.id||null});
  set('rosettaSpec',rosetta.valid,{id:rosetta.id});
  set('fountainPackets',Boolean(fountain),{generation:fountain?.generation||null});
  set('metamorphicReferenceEngine',metamorphic,{note:'independent full-scan/nested-loop verifier exists in source'});
  set('lastSaviorArchive',Boolean(last),{id:last?.id,archiveHash:last?.archiveHash});
  set('registeredMedia',Number(media.registry?.media?.length||0)>0,{count:media.registry?.media?.length||0,comparison:media.comparison});
  return cap;
 }

 scenarios(){return[
  {id:'canonical-state-destroyed',severity:'catastrophic',paths:[['memoryPalace'],['trinity'],['quaternary'],['spacetimeArk'],['semanticFossil','memoryPalace']]},
  {id:'node-runtime-lost',severity:'high',paths:[['pythonRuntime'],['rosettaSpec']]},
  {id:'python-runtime-lost',severity:'medium',paths:[['nodeRuntime'],['rosettaSpec']]},
  {id:'both-known-runtimes-lost',severity:'high',paths:[['rosettaSpec']]},
  {id:'one-physical-device-lost',severity:'high',paths:[['multiplePhysicalDevices'],['spacetimeArk'],['evidenceDiaspora']]},
  {id:'two-physical-devices-lost',severity:'catastrophic',paths:[['threePhysicalDevices'],['spacetimeArk']]},
  {id:'latest-epoch-file-lost',severity:'high',paths:[['temporalParity'],['spacetimeArk'],['timeWeave','memoryPalace']]},
  {id:'historical-key-compromise',severity:'high',paths:[['forwardWitness','timeWeave'],['dualCryptoCouncil','crossHistoryBraid']]},
  {id:'query-planner-corruption',severity:'high',paths:[['metamorphicReferenceEngine','canonicalLive']]},
  {id:'storage-engine-history-bug',severity:'catastrophic',paths:[['semanticChronicle','memoryPalace'],['semanticFossil','memoryPalace'],['lastSaviorArchive','quaternary']]},
  {id:'manifest-metadata-loss',severity:'high',paths:[['fountainPackets','rosettaSpec'],['lastSaviorArchive','rosettaSpec'],['spacetimeArk']]},
  {id:'single-hash-family-distrusted',severity:'medium',paths:[['lastSaviorArchive','dualCryptoCouncil'],['forwardWitness']]},
  {id:'coordinated-logical-corruption',severity:'catastrophic',paths:[['shadowLaws','semanticHologram','dualCryptoCouncil'],['semanticChronicle','crossHistoryBraid']]},
  {id:'current-history-fork-ambiguous',severity:'high',paths:[['timeWeave','crossHistoryBraid','dualCryptoCouncil'],['semanticFossil','semanticHologram','shadowLaws']]}
 ];}

 evalPath(pathSpec,cap){return{requirements:pathSpec,available:pathSpec.every(x=>cap[x]?.available),details:pathSpec.map(x=>({capability:x,available:cap[x]?.available||false}))};}
 async analyze(options={}){
  await this.init();const cap=await this.capabilities(options);const cases=[];
  for(const scenario of this.scenarios()){
   const paths=scenario.paths.map(p=>this.evalPath(p,cap));const available=paths.filter(x=>x.available);
   cases.push({...scenario,survives:available.length>0,availablePaths:available.length,totalPaths:paths.length,paths});
  }
  const survived=cases.filter(x=>x.survives).length;
  const record={format:'JSONDB-RECOVERY-GEOMETRY-1',id:`${Date.now()}-${Math.random().toString(16).slice(2,10)}`,at:now(),removed:[...(options.remove||[])],capabilities:cap,scenarios:cases,summary:{survived,total:cases.length,coverage:cases.length?Math.round(survived/cases.length*10000)/100:0,failed:cases.filter(x=>!x.survives).map(x=>x.id)},doctrine:'Recovery Geometry models explicit alternative paths. It does not convert capability counts into a probability of survival and does not claim OS device IDs prove physical independence.'};
  await atomicJson(path.join(this.records,`${record.id}.json`),record);await atomicJson(path.join(this.root,'latest.json'),record);return record;
 }
}

module.exports={RecoveryGeometry};
