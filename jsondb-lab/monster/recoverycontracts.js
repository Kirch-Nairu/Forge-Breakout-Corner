'use strict';

const fsp=require('fs/promises');const path=require('path');const crypto=require('crypto');
const {now,ensureDir,atomicJson,readJson}=require('./jsonfs');
function hash(v){return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');}
function registryContentHash(registry){if(!registry)return null;const copy={...registry};delete copy.registryHash;return hash(copy);}

class RecoveryContractRegistry{
 constructor(savior){
  this.savior=savior;
  this.root=path.join(savior.root,'recovery-contracts');
  this.file=path.join(this.root,'registry.json');
  this.versions=path.join(this.root,'versions');
 }
 async archiveNames(){return(await fsp.readdir(this.root).catch(()=>[])).filter(name=>/^registry-.*\.json$/.test(name)&&name!=='registry.json').sort();}
 validateRegistry(registry){
  if(!registry)return{valid:false,status:'ABSENT',registryHash:null,computedRegistryHash:null,contracts:0,automaticPromoters:0,violations:[{type:'REGISTRY_ABSENT'}],warnings:[]};
  const computedRegistryHash=registryContentHash(registry),contracts=Object.values(registry.contracts||{}),violations=[],warnings=[];
  if(computedRegistryHash!==registry.registryHash)violations.push({type:'REGISTRY_CONTENT_HASH_MISMATCH',declared:registry.registryHash,computed:computedRegistryHash});
  if(registry.format!=='JSONDB-RECOVERY-CONTRACTS-5')warnings.push({type:'LEGACY_REGISTRY_FORMAT',format:registry.format||null});
  for(const c of contracts){
   if(c?.mayPromoteCanonical===true)violations.push({type:'AUTO_PROMOTION_AUTHORITY',id:c.id});
   if(c?.kind==='corroborative'&&(c.reconstructs||[]).length)violations.push({type:'CORROBORATOR_RECONSTRUCTS',id:c.id,reconstructs:c.reconstructs});
   if(c?.kind==='reconstructive'&&!(c.reconstructs||[]).length)warnings.push({type:'RECONSTRUCTIVE_WITHOUT_TARGET',id:c.id});
   if(c?.mayAuthorize&&c.kind!=='authority')warnings.push({type:'AUTHORIZATION_OUTSIDE_AUTHORITY_CLASS',id:c.id});
   if(c?.kind==='planning'&&(c.mayNominate||c.mayAuthorize||(c.reconstructs||[]).length))violations.push({type:'PLANNER_AUTHORITY_ESCALATION',id:c.id});
   if(c?.kind==='planning-evidence'&&(c.mayNominate||c.mayAuthorize||(c.reconstructs||[]).length))violations.push({type:'PLANNING_EVIDENCE_AUTHORITY_ESCALATION',id:c.id});
   if(c?.kind==='policy-enforcement'&&(c.mayNominate||c.mayAuthorize||(c.reconstructs||[]).length))violations.push({type:'FIREWALL_AUTHORITY_ESCALATION',id:c.id});
   if(c?.id==='policy-checkpoint'&&(c.mayNominate||c.mayAuthorize||(c.reconstructs||[]).length))violations.push({type:'POLICY_CHECKPOINT_AUTHORITY_ESCALATION',id:c.id});
  }
  const reconstructors=contracts.filter(c=>(c.reconstructs||[]).length).map(c=>c.id),corroborators=contracts.filter(c=>(c.corroborates||[]).length&&!((c.reconstructs||[]).length)).map(c=>c.id),dependencyReverse={};
  for(const c of contracts)for(const d of c.dependencies||[])(dependencyReverse[d]||=[]).push(c.id);
  return{valid:violations.length===0,status:'PRESENT',registryHash:registry.registryHash||null,computedRegistryHash,formatVersion:registry.format||null,contracts:contracts.length,automaticPromoters:contracts.filter(c=>c?.mayPromoteCanonical===true).length,violations,warnings,reconstructors,corroborators,dependencyReverse,summary:{contracts:contracts.length,reconstructors:reconstructors.length,nonReconstructiveCorroborators:corroborators.length,automaticPromoters:contracts.filter(c=>c?.mayPromoteCanonical===true).length,planners:contracts.filter(c=>c.kind==='planning').length,planningEvidence:contracts.filter(c=>c.kind==='planning-evidence').length,analyses:contracts.filter(c=>c.kind==='analysis').length,policyEnforcers:contracts.filter(c=>c.kind==='policy-enforcement').length,policyCheckpoints:contracts.filter(c=>c.id==='policy-checkpoint').length}};
 }
 async persistVersion(registry,options={}){
  if(!registry?.registryHash)return false;
  const validation=this.validateRegistry(registry);
  if(validation.computedRegistryHash!==registry.registryHash){if(options.strict!==false)throw new Error(`Recovery Contract registry hash mismatch: declared ${registry.registryHash}, computed ${validation.computedRegistryHash}`);return false;}
  await ensureDir(this.versions);const file=path.join(this.versions,`${registry.registryHash}.json`);if(!(await readJson(file,null)))await atomicJson(file,registry);return true;
 }
 async readArchivedVersion(registryHash){if(!registryHash)return null;for(const name of await this.archiveNames()){const archived=await readJson(path.join(this.root,name),null);if(!archived||archived.registryHash!==registryHash)continue;if(this.validateRegistry(archived).computedRegistryHash!==registryHash)continue;return archived;}return null;}
 async hydrateArchiveVersions(){await ensureDir(this.root);await ensureDir(this.versions);const names=await this.archiveNames();let hydrated=0,skipped=0;for(const name of names){const archived=await readJson(path.join(this.root,name),null);if(!archived?.registryHash){skipped++;continue;}const ok=await this.persistVersion(archived,{strict:false});if(ok)hydrated++;else skipped++;}return{archives:names.length,hydrated,skipped};}
 async inspect(){const registry=await readJson(this.file,null);const validation=this.validateRegistry(registry);return{format:'JSONDB-RECOVERY-CONTRACT-FORENSIC-INSPECT-2',...validation,doctrine:'Read-only inspection never creates, migrates, hydrates, or rewrites Recovery Contract state.'};}
 async init(){await ensureDir(this.root);await ensureDir(this.versions);await this.hydrateArchiveVersions();let r=await readJson(this.file,null);if(!r||r.format!=='JSONDB-RECOVERY-CONTRACTS-5'){if(r){await this.persistVersion(r,{strict:false});await atomicJson(path.join(this.root,`registry-archive-${Date.now()}.json`),r);}r=this.build();await atomicJson(this.file,r);}await this.persistVersion(r);return r;}
 async version(registryHash,options={}){if(!registryHash)return null;const found=await readJson(path.join(this.versions,`${registryHash}.json`),null);if(found&&found.registryHash===registryHash&&this.validateRegistry(found).computedRegistryHash===registryHash)return found;const archived=await this.readArchivedVersion(registryHash);if(!archived)return null;if(options.hydrate!==false)await this.persistVersion(archived);return archived;}
 contract(id,kind,reconstructs,corroborates,dependencies,extra={}){return{id,kind,reconstructs,corroborates,dependencies,mayAutoRepair:extra.mayAutoRepair||[],mayNominate:Boolean(extra.mayNominate),mayAuthorize:Boolean(extra.mayAuthorize),mayPromoteCanonical:false,forbidden:[...(extra.forbidden||[]),'silent-canonical-promotion'],notes:extra.notes||[]};}
 build(){
  const c=[];
  c.push(this.contract('memory-palace','reconstructive',['world'],['content-hashes','merkle-root'],['filesystem'],{mayAutoRepair:['content-addressed-primary-chunk-from-valid-vault']}));
  c.push(this.contract('trinity-ark','reconstructive',['world'],['independent-decoder-agreement'],['xor-ark','reed-solomon-ark','surface-parity'],{mayAutoRepair:['damaged-redundant-shard']}));
  c.push(this.contract('quaternary-cold-codec','reconstructive',['world-bytes'],['crc32','sha256'],['utf8-json','acgt-mapping'],{}));
  c.push(this.contract('fountain-ark','reconstructive',['world-bytes'],['packet-hashes'],['self-describing-droplets'],{}));
  c.push(this.contract('temporal-parity','reconstructive',['historical-omega-epoch'],['epoch-file-sha256'],['neighboring-epochs','parity-shards'],{mayAutoRepair:['historical-epoch-only-with-explicit-in-place-flag']}));
  c.push(this.contract('spacetime-ark','reconstructive',['historical-omega-epochs'],['cell-hashes'],['omega-epochs','2d-product-code'],{}));
  c.push(this.contract('semantic-delta-fossils','reconstructive',['ancestor-world-from-descendant','descendant-world-from-ancestor'],['bidirectional-patch-inverse'],['memory-palace-endpoint'],{}));
  c.push(this.contract('semantic-chronicle','historical',['semantic-world-by-replay'],['declared-commit-history'],['genesis','commit-chain'],{}));
  c.push(this.contract('semantic-hologram','corroborative',[],['semantic-shadow','field-profiles','seeded-projections'],[],{forbidden:['row-reconstruction'],notes:['lossy by design']}));
  c.push(this.contract('shadow-laws','corroborative',[],['randomized-modular-semantic-equations'],['crypto-council-attestation'],{forbidden:['state-reconstruction']}));
  c.push(this.contract('time-weave','historical',[],['long-range-history-continuity'],['omega-epoch-hashes'],{}));
  c.push(this.contract('cross-history-braid','historical',[],['cross-channel-history-heads'],['chronicle','witnesses','truth-lattice'],{}));
  c.push(this.contract('crypto-council','authority-evidence',[],['ed25519-attestation','lamport-sha256-attestation'],['witness-keys'],{}));
  c.push(this.contract('forward-witness','authority-evidence',[],['forward-evolving-attestation-chain'],['ratchet-key-state'],{}));
  c.push(this.contract('rosetta-capsule','interpretation',[],['format-semantics','known-vectors'],['utf8','json-parser'],{forbidden:['automatic-recovery-authority']}));
  c.push(this.contract('civilization-seed','bootstrap',['recovery-tool-source'],['public-trust-material','format-registry'],['surviving-seed-directory'],{}));
  c.push(this.contract('evidence-diaspora','transport',[],['failure-domain-placement-receipts'],['registered-media'],{}));
  c.push(this.contract('recovery-geometry','analysis',[],['counterfactual-survival-paths'],['capability-observation'],{forbidden:['treat-coverage-as-probability']}));
  c.push(this.contract('recovery-contracts','constitution',[],['declared-authority-shape','architecture-drift-analysis'],[],{forbidden:['self-grant-new-authority-without-registry-version-change']}));
  c.push(this.contract('authority-firewall','policy-enforcement',[],['deny-by-default-decisions','authority-ledger'],['recovery-contracts'],{forbidden:['grant-undeclared-action','override-human-threshold']}));
  c.push(this.contract('policy-checkpoint','authority-evidence',[],['cross-attested-firewall-prefix','contract-registry-binding'],['authority-firewall','recovery-contracts','crypto-council','forward-witness'],{forbidden:['grant-policy-authority','rewrite-firewall-history']}));
  c.push(this.contract('recovery-navigator','planning',[],['contract-aware-plan','independence-aware-corroboration'],['recovery-contracts','recovery-geometry','authority-firewall'],{forbidden:['execute-recovery','open-promotion-by-itself','write-canonical-state']}));
  c.push(this.contract('proof-carrying-recovery-plan','planning-evidence',[],['sealed-plan','sealed-contract-roles','sealed-firewall-decisions','policy-checkpoint-reference'],['recovery-navigator','policy-checkpoint','crypto-council','forward-witness'],{forbidden:['execute-recovery','grant-authority','write-canonical-state']}));
  c.push(this.contract('recovery-plan-mutation','analysis',[],['reroute-or-block-behavior','evidence-loss-resilience'],['recovery-navigator','recovery-geometry','policy-checkpoint'],{forbidden:['treat-reroute-as-promotion-authority','execute-recovery']}));
  c.push(this.contract('recovery-jury','adjudication',[],['candidate-evidence-verdict'],['last-savior','hologram','shadow-laws','canonical-quorum'],{mayNominate:true,forbidden:['execute-promotion']}));
  c.push(this.contract('promotion-ceremony','authority',[],['operator-threshold-intent'],['operator-keys','proposal'],{mayAuthorize:true,forbidden:['execute-promotion']}));
  c.push(this.contract('jury-promotion-gate','authority-gate',[],['jury-eligibility'],['recovery-jury','promotion-ceremony','authority-firewall'],{mayNominate:true,forbidden:['approve-on-behalf-of-operators','execute-promotion']}));
  c.push(this.contract('last-savior','orchestrator',[],['cross-family-consistency'],['federation','rosetta-capsule','quaternary-cold-codec','shadow-laws','forward-witness','recovery-contracts'],{forbidden:['treat-own-receipt-as-sole-proof']}));
  const registry={format:'JSONDB-RECOVERY-CONTRACTS-5',createdAt:now(),contracts:Object.fromEntries(c.map(x=>[x.id,x])),globalDoctrine:['No subsystem may promote canonical state automatically.','Reconstructive and corroborative functions should remain separable.','Authority evidence does not reconstruct bytes.','Transport redundancy is not semantic truth.','Interpretation metadata is not recovery authority.','Planning does not imply execution authority.','Policy enforcement is deny-by-default and may not grant authority absent from the registry.','Policy checkpoints may attest policy history but never create new policy authority.','Proof-carrying plans may preserve planning evidence but never upgrade that evidence into execution authority.','Mutation tests must accept only verified reroute or verified hard block under evidence loss.']};registry.registryHash=hash(registry);return registry;
 }
 async reset(){const old=await readJson(this.file,null);if(old){await this.persistVersion(old,{strict:false});await atomicJson(path.join(this.root,`registry-reset-archive-${Date.now()}.json`),old);}const r=this.build();await atomicJson(this.file,r);await this.persistVersion(r);return r;}
 async analyze(){const r=await this.init(),v=this.validateRegistry(r),report={format:'JSONDB-RECOVERY-CONTRACT-ANALYSIS-6',at:now(),registryHash:r.registryHash,valid:v.valid,violations:v.violations,warnings:v.warnings,summary:v.summary,reconstructors:v.reconstructors,corroborators:v.corroborators,dependencyReverse:v.dependencyReverse,doctrine:'This checks authority-shape drift, not implementation correctness.'};await atomicJson(path.join(this.root,'latest-analysis.json'),report);return report;}
}
module.exports={RecoveryContractRegistry};
