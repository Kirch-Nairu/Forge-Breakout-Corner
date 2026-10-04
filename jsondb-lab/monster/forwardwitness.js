'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function bytes(value) { return Buffer.from(JSON.stringify(canonical(value))); }
function digest(value) { return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : bytes(value)).digest('hex'); }
function fingerprint(pem) { return crypto.createHash('sha256').update(String(pem)).digest('hex'); }

class ForwardWitnessRatchet {
  constructor(savior) {
    this.savior = savior;
    this.root = path.join(savior.root, 'forward-witness-ratchet');
    this.records = path.join(this.root, 'records');
    this.stateFile = path.join(this.root, 'state.json');
  }

  generateKey(sequence) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type:'spki', format:'pem' });
    return {
      sequence,
      keyId: `forward-${String(sequence).padStart(10,'0')}-${fingerprint(publicKeyPem).slice(0,12)}`,
      publicKeyPem,
      privateKeyPem: privateKey.export({ type:'pkcs8', format:'pem' }),
      fingerprint: fingerprint(publicKeyPem),
      createdAt: now()
    };
  }

  async init() {
    await ensureDir(this.records);
    let state = await readJson(this.stateFile, null);
    if (!state) {
      const current = this.generateKey(1);
      const next = this.generateKey(2);
      state = {
        format:'JSONDB-FORWARD-WITNESS-STATE-1', createdAt:now(),
        sequence:0, lastAttestationHash:null,
        current, next,
        warning:'Active private keys are experimental local files. Rotation removes old private material from active JSON state but does not guarantee forensic secure erase from physical storage.'
      };
      await atomicJson(this.stateFile,state);
      await atomicJson(path.join(this.root,'genesis.json'),{
        format:'JSONDB-FORWARD-WITNESS-GENESIS-1', createdAt:state.createdAt,
        firstKeyFingerprint:current.fingerprint,
        firstPublicKeyPem:current.publicKeyPem,
        nextKeyFingerprint:next.fingerprint,
        doctrine:'Historical verification trusts the chained public-key commitments starting from this genesis fingerprint.'
      });
    }
    return state;
  }

  async attest(subjectHash, metadata={}) {
    let state = await this.init();
    if (!subjectHash) throw new Error('Forward witness requires a subject hash.');
    const sequence = Number(state.sequence||0)+1;
    if (state.current.sequence !== sequence) throw new Error('Forward witness key sequence does not match attestation sequence.');
    const statement = {
      format:'JSONDB-FORWARD-WITNESS-STATEMENT-1', sequence, at:now(),
      subjectHash:String(subjectHash), metadata:canonical(metadata),
      previousAttestationHash:state.lastAttestationHash||null,
      signingKeyFingerprint:state.current.fingerprint,
      nextKeyFingerprint:state.next.fingerprint
    };
    const signature=crypto.sign(null,bytes(statement),crypto.createPrivateKey(state.current.privateKeyPem)).toString('base64');
    const record={
      format:'JSONDB-FORWARD-WITNESS-1',statement,
      publicKeyPem:state.current.publicKeyPem,
      signature,
      attestationHash:digest({statement,publicKeyPem:state.current.publicKeyPem,signature})
    };
    await atomicJson(path.join(this.records,`${String(sequence).padStart(10,'0')}.json`),record);
    await atomicJson(path.join(this.root,'latest.json'),record);

    const promoted={...state.next};
    const future=this.generateKey(sequence+2);
    state={
      ...state, sequence, lastAttestationHash:record.attestationHash,
      current:promoted, next:future, rotatedAt:now(),
      previousKeyErasureClaim:{ sequence, keyId:record.statement.signingKeyFingerprint, at:now(), caveat:'Removed from active JSON state only; physical secure erasure is not guaranteed.' }
    };
    await atomicJson(this.stateFile,state);
    return record;
  }

  verifyRecord(record, expectedPreviousHash=null, expectedKeyFingerprint=null) {
    const failures=[];
    const actualFingerprint=fingerprint(record?.publicKeyPem||'');
    if(actualFingerprint!==record?.statement?.signingKeyFingerprint)failures.push({type:'PUBLIC_KEY_FINGERPRINT'});
    if(expectedKeyFingerprint&&actualFingerprint!==expectedKeyFingerprint)failures.push({type:'KEY_CHAIN_COMMITMENT',expected:expectedKeyFingerprint,actual:actualFingerprint});
    if(record?.statement?.previousAttestationHash!==expectedPreviousHash)failures.push({type:'PREVIOUS_HASH',expected:expectedPreviousHash,actual:record?.statement?.previousAttestationHash});
    try{
      const ok=crypto.verify(null,bytes(record.statement),crypto.createPublicKey(record.publicKeyPem),Buffer.from(record.signature,'base64'));
      if(!ok)failures.push({type:'SIGNATURE'});
    }catch(error){failures.push({type:'SIGNATURE_ERROR',error:error.message});}
    const actualHash=digest({statement:record.statement,publicKeyPem:record.publicKeyPem,signature:record.signature});
    if(actualHash!==record.attestationHash)failures.push({type:'ATTESTATION_HASH',expected:record.attestationHash,actual:actualHash});
    return{valid:failures.length===0,sequence:record?.statement?.sequence,subjectHash:record?.statement?.subjectHash,nextKeyFingerprint:record?.statement?.nextKeyFingerprint,attestationHash:record?.attestationHash,failures};
  }

  async verifyAll(options = {}) {
    const readOnly = options.readOnly === true;
    if (!readOnly) await this.init();
    const genesis=await readJson(path.join(this.root,'genesis.json'),null);
    const names=(await require('fs/promises').readdir(this.records).catch(()=>[])).filter(x=>x.endsWith('.json')).sort();
    const state=await readJson(this.stateFile,null);
    if(!genesis&&names.length===0&&!state)return{
      format:'JSONDB-FORWARD-WITNESS-VERIFY-2',valid:false,status:'ABSENT',readOnly,records:0,results:[],genesisValid:false,activeStateValid:null,headHash:null
    };

    const genesisValid=Boolean(
      genesis?.firstKeyFingerprint &&
      genesis?.firstPublicKeyPem &&
      fingerprint(genesis.firstPublicKeyPem)===genesis.firstKeyFingerprint
    );
    let previous=null;
    let expectedKey=genesis?.firstKeyFingerprint||null;
    const results=[];
    let expectedSequence=1;
    for(const name of names){
      const record=await readJson(path.join(this.records,name),null);
      const r=this.verifyRecord(record,previous,expectedKey);
      if(record?.statement?.sequence!==expectedSequence)r.failures.push({type:'SEQUENCE',expected:expectedSequence,actual:record?.statement?.sequence});
      r.valid=r.failures.length===0;
      results.push(r);
      previous=record?.attestationHash||null;
      expectedKey=record?.statement?.nextKeyFingerprint||null;
      expectedSequence++;
    }
    const chainValid=genesisValid&&results.every(x=>x.valid);
    const activeStateValid=state?Boolean(
      Number(state.sequence||0)===results.length&&
      (state.lastAttestationHash||null)===(previous||null)&&
      (!expectedKey||state.current?.fingerprint===expectedKey)
    ):null;
    return{
      format:'JSONDB-FORWARD-WITNESS-VERIFY-2',
      valid:chainValid,
      status:chainValid?(results.length?'CHAIN_VALID':'GENESIS_ONLY'):'CHAIN_INVALID',
      readOnly,
      records:results.length,results,
      genesisValid,
      genesisFingerprint:genesis?.firstKeyFingerprint||null,
      headHash:previous,
      activeStatePresent:Boolean(state),
      activeStateValid,
      currentStateSequence:state?.sequence??null,
      caveat:'Historical chain validity is anchored in genesis and does not depend on surviving active private-key state. Active-state health is reported separately. Ordinary filesystem overwrite/deletion does not prove secure erase.'
    };
  }
}

module.exports={ForwardWitnessRatchet};
