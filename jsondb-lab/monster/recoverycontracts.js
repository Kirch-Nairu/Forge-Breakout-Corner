'use strict';

const path=require('path');const crypto=require('crypto');
const {now,ensureDir,atomicJson,readJson}=require('./jsonfs');
function hash(v){return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');}

class RecoveryContractRegistry{
 constructor(savior){this.savior=savior;this.root=path.join(savior.root,'recovery-contracts');this.file=path.join(this.root,'registry.json');}
 async init(){await ensureDir(this.root);let r=await readJson(this.file,null);if(!r){r=this.build();await atomicJson(this.file,r);}return r;}
 contract(id,kind,reconstructs,corroborates,dependencies,extra={}){return{id,kind,reconstructs,corroborates,dependencies,mayAutoRepair:extra.mayAutoRepair||[],mayNominate:Boolean(extra.mayNominate),mayAuthorize:Boolean(extra.mayAuthorize),mayPromoteCanonical:false,forbidden:[...(extra.forbidden||[]),'silent-canonical-promotion'],notes:extra.notes||[]};}
 build(){
  const c=[];
  c.push(this.contract('memory-palace','reconstructive',['world'],['content-hashes','merkle-root'],['filesystem'],{mayAutoRepair:['content-addressed-primary-chunk-from-valid-vault']}));
  c.push(this.contract('trinity-ark','reconstructive',['world'],['independent-decoder-agreement'],['xor-ark','reed-solomon-ark','surface-parity'],{mayAutoRepair:['damaged-redundant-shard']}));
  c.push(this.contract('quaternary-cold-codec','reconstructive',['world-bytes'],['crc32','sha256'],['utf8-json','acgt-mapping'],{mayAutoRepair:[]}));
  c.push(this.contract('fountain-ark','reconstructive',['world-bytes'],['packet-hashes'],['self-describing-droplets'],{}));
  c.push(this.contract('temporal-parity','reconstructive',['historical-omega-epoch'],['epoch-file-sha256'],['neighboring-epochs','parity-shards'],{mayAutoRepair:['historical-epoch-only-with-explicit-in-place-flag']}));
  c.push(this.contract('spacetime-ark','reconstructive',['historical-omega-epochs'],['cell-hashes'],['omega-epochs','2d-product-code'],{mayAutoRepair:[]}));
  c.push(this.contract('semantic-delta-fossils','reconstructive',['ancestor-from-descendant','descendant-from-ancestor'],['bidirectional-patch-inverse'],['memory-palace-endpoint'],{}));
  c.push(this.contract('semantic-chronicle','historical',['semantic-world-by-replay'],['declared-commit-history'],['genesis','commit-chain'],{}));
  c.push(this.contract('semantic-hologram','corroborative',[],['semantic-shadow','field-profiles','seeded-projections'],[],{forbidden:['row-reconstruction'],notes:['lossy by design']}));
  c.push(this.contract('shadow-laws','corroborative',[],['randomized-modular-semantic-equations'],['crypto-council-attestation'],{forbidden:['state-reconstruction']}));
  c.push(this.contract('time-weave','historical',[],['long-range-history-continuity'],['omega-epoch-hashes'],{}));
  c.push(this.contract('cross-history-braid','historical',[],['cross-channel-history-heads'],['chronicle','witnesses','truth-lattice'],{}));
  c.push(this.contract('crypto-council','authority-evidence',[],['ed25519-attestation','lamport-sha256-attestation'],['witness-keys'],{}));
  c.push(this.contract('forward-witness','authority-evidence',[],['forward-evolving-attestation-chain'],['ratchet-key-state'],{}));
  c.push(this.contract('rosetta-capsule','interpretation',[],['format-semantics','known-vectors'],['utf8','json-parser'],{forbidden:['automatic-recovery-authority']}));
  c.push(this.contract('civilization-seed','bootstrap',['recovery-tool-source'],['public-trust-material','format-registry'],['surviving-seed-directory'],{}));
  c.push(this.contract('evidence-diaspora','transport',[],['failure-domain-placement-receipts'],['registered-media'],{mayAutoRepair:[]}));
  c.push(this.contract('recovery-jury','adjudication',[],['candidate-evidence-verdict'],['last-savior','hologram','shadow-laws','canonical-quorum'],{mayNominate:true,forbidden:['execute-promotion']}));
  c.push(this.contract('promotion-ceremony','authority',[],['operator-threshold-intent'],['operator-keys','proposal'],{mayAuthorize:true,forbidden:['execute-promotion']}));
  c.push(this.contract('jury-promotion-gate','authority-gate',[],['jury-eligibility'],['recovery-jury','promotion-ceremony'],{mayNominate:true,forbidden:['approve-on-behalf-of-operators','execute-promotion']}));
  c.push(this.contract('last-savior','orchestrator',[],['cross-family-consistency'],['federation','rosetta-capsule','quaternary-cold-codec','shadow-laws','forward-witness'],{forbidden:['treat-own-receipt-as-sole-proof']}));
  const registry={format:'JSONDB-RECOVERY-CONTRACTS-1',createdAt:now(),contracts:Object.fromEntries(c.map(x=>[x.id,x])),globalDoctrine:['No subsystem may promote canonical state automatically.','Reconstructive and corroborative functions should remain separable.','Authority evidence does not reconstruct bytes.','Transport redundancy is not semantic truth.','Interpretation metadata is not recovery authority.']};registry.registryHash=hash(registry);return registry;
 }
 async reset(){const r=this.build();await atomicJson(this.file,r);return r;}
 async analyze(){
  const r=await this.init(),contracts=Object.values(r.contracts||{}),violations=[],warnings=[];
  for(const c of contracts){
   if(c.mayPromoteCanonical)violations.push({type:'AUTO_PROMOTION_AUTHORITY',id:c.id});
   if(c.kind==='corroborative'&&(c.reconstructs||[]).length)violations.push({type:'CORROBORATOR_RECONSTRUCTS',id:c.id,reconstructs:c.reconstructs});
   if(c.kind==='reconstructive'&&!(c.reconstructs||[]).length)warnings.push({type:'RECONSTRUCTIVE_WITHOUT_TARGET',id:c.id});
   if(c.mayAuthorize&&c.kind!=='authority')warnings.push({type:'AUTHORIZATION_OUTSIDE_AUTHORITY_CLASS',id:c.id});
  }
  const reconstructors=contracts.filter(c=>(c.reconstructs||[]).length).map(c=>c.id),corroborators=contracts.filter(c=>(c.corroborates||[]).length&&!((c.reconstructs||[]).length)).map(c=>c.id);
  const dependencyReverse={};for(const c of contracts)for(const d of c.dependencies||[])(dependencyReverse[d]||=[]).push(c.id);
  const report={format:'JSONDB-RECOVERY-CONTRACT-ANALYSIS-1',at:now(),valid:violations.length===0,violations,warnings,summary:{contracts:contracts.length,reconstructors:reconstructors.length,nonReconstructiveCorroborators:corroborators.length,automaticPromoters:contracts.filter(c=>c.mayPromoteCanonical).length},reconstructors,corroborators,dependencyReverse,doctrine:'This checks authority-shape drift, not implementation correctness.'};
  await atomicJson(path.join(this.root,'latest-analysis.json'),report);return report;
 }
}
module.exports={RecoveryContractRegistry};
