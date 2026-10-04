'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

const ALPHABET = ['A','C','G','T'];
const REV = { A:0, C:1, G:2, T:3 };
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function safe(v) { return String(v || 'quaternary').replace(/[^A-Za-z0-9_.-]/g, '_'); }

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function encodeDna(buf) {
  let out = '';
  for (const byte of buf) {
    out += ALPHABET[(byte >> 6) & 3];
    out += ALPHABET[(byte >> 4) & 3];
    out += ALPHABET[(byte >> 2) & 3];
    out += ALPHABET[byte & 3];
  }
  return out;
}

function decodeDna(text) {
  const s = String(text || '').trim().toUpperCase();
  if (s.length % 4) throw new Error('Quaternary sequence length must be divisible by four.');
  const out = Buffer.alloc(s.length / 4);
  for (let i = 0; i < out.length; i++) {
    const a = REV[s[i*4]], b = REV[s[i*4+1]], c = REV[s[i*4+2]], d = REV[s[i*4+3]];
    if ([a,b,c,d].some(x => x == null)) throw new Error('Quaternary sequence contains symbols outside A/C/G/T.');
    out[i] = (a << 6) | (b << 4) | (c << 2) | d;
  }
  return out;
}

function gcd(a,b) { while (b) [a,b] = [b,a%b]; return a; }
function strideFor(n) {
  if (n <= 1) return 1;
  let s = Math.max(3, Math.floor(n * 0.61803398875) | 1);
  while (gcd(s,n) !== 1) s += 2;
  return s;
}
function permute(buf, stride) {
  if (buf.length <= 1) return Buffer.from(buf);
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[(i * stride) % buf.length] = buf[i];
  return out;
}
function unpermute(buf, stride) {
  if (buf.length <= 1) return Buffer.from(buf);
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[(i * stride) % buf.length];
  return out;
}

class QuaternaryColdCodec {
  constructor({ savior }) {
    this.savior = savior;
    this.root = path.join(savior.root, 'quaternary-cold-codec');
    this.generations = path.join(this.root, 'generations');
  }
  async init() { await ensureDir(this.generations); }

  async archiveBuffer(label, input, options = {}) {
    await this.init();
    const buffer = Buffer.from(input);
    const oligoBytes = Math.max(32, Math.min(8192, Number(options.oligoBytes || 512)));
    const groupSize = Math.max(2, Math.min(32, Number(options.groupSize || 8)));
    const stride = strideFor(buffer.length);
    const interleaved = permute(buffer, stride);
    const count = Math.ceil(interleaved.length / oligoBytes) || 1;
    const padded = Buffer.alloc(count * oligoBytes); interleaved.copy(padded);
    const generation = `${Date.now()}-${safe(label)}-${crypto.randomBytes(4).toString('hex')}`;
    const dir = path.join(this.generations, generation);
    await ensureDir(dir);
    const data = [];
    for (let i = 0; i < count; i++) {
      const bytes = Buffer.from(padded.subarray(i*oligoBytes,(i+1)*oligoBytes));
      const record = { format:'JSONDB-QUATERNARY-OLIGO-1', generation, kind:'data', index:i, bytes:bytes.length, crc32:crc32(bytes), sha256:sha(bytes), dna:encodeDna(bytes) };
      const file = `oligo-${String(i).padStart(6,'0')}.json`;
      await atomicJson(path.join(dir,file),record); data.push({ index:i,file,sha256:record.sha256,crc32:record.crc32 });
    }
    const parity = [];
    for (let g = 0; g < Math.ceil(count/groupSize); g++) {
      const first = g*groupSize, last = Math.min(count, first+groupSize);
      const p = Buffer.alloc(oligoBytes);
      for (let i = first; i < last; i++) {
        const bytes = padded.subarray(i*oligoBytes,(i+1)*oligoBytes);
        for (let j = 0; j < oligoBytes; j++) p[j] ^= bytes[j];
      }
      const record = { format:'JSONDB-QUATERNARY-OLIGO-1', generation, kind:'parity', group:g, first, lastExclusive:last, bytes:p.length, crc32:crc32(p), sha256:sha(p), dna:encodeDna(p) };
      const file = `parity-${String(g).padStart(6,'0')}.json`;
      await atomicJson(path.join(dir,file),record); parity.push({ group:g,first,lastExclusive:last,file,sha256:record.sha256,crc32:record.crc32 });
    }
    const manifest = {
      format:'JSONDB-QUATERNARY-COLD-1', generation,label,createdAt:now(),
      alphabet:'ACGT', bitsPerSymbol:2, originalBytes:buffer.length, originalSha256:sha(buffer),
      interleaving:{ algorithm:'multiplicative-permutation', stride, length:buffer.length },
      oligoBytes, dataOligos:count, groupSize, data, parity,
      tolerance:'One missing/corrupt data oligo per parity group if that group parity survives.',
      disclaimer:'This is a quaternary text codec inspired by DNA storage notation. It does not store or synthesize biological DNA.'
    };
    await atomicJson(path.join(dir,'manifest.json'),manifest);
    await atomicJson(path.join(this.root,'latest.json'),{generation,createdAt:manifest.createdAt});
    return manifest;
  }

  async load(generation=null) {
    await this.init();
    if (!generation) generation=(await readJson(path.join(this.root,'latest.json'),null))?.generation;
    if (!generation) throw new Error('No quaternary generation exists.');
    const dir=path.join(this.generations,generation), manifest=await readJson(path.join(dir,'manifest.json'),null);
    if (!manifest) throw new Error(`Quaternary generation not found: ${generation}`);
    return {dir,manifest};
  }

  async readOligo(file,expected) {
    const rec=await readJson(file,null);
    if (!rec?.dna) throw new Error('oligo missing DNA text');
    const buf=decodeDna(rec.dna);
    if (crc32(buf)!==Number(rec.crc32)) throw new Error('oligo CRC mismatch');
    if (sha(buf)!==expected) throw new Error('oligo SHA-256 mismatch');
    return buf;
  }

  async recover(generation=null) {
    const {dir,manifest}=await this.load(generation);
    const shards=new Array(manifest.dataOligos).fill(null), damaged=[];
    for (const spec of manifest.data) {
      try { shards[spec.index]=await this.readOligo(path.join(dir,spec.file),spec.sha256); }
      catch(error){damaged.push({index:spec.index,file:spec.file,error:error.message});}
    }
    for (const group of manifest.parity) {
      const missing=[];
      for(let i=group.first;i<group.lastExclusive;i++)if(!shards[i])missing.push(i);
      if(!missing.length)continue;
      if(missing.length>1)return{status:'UNRECOVERABLE',generation:manifest.generation,damaged,reason:`Parity group ${group.group} has ${missing.length} missing data oligos.`};
      let p;
      try{p=await this.readOligo(path.join(dir,group.file),group.sha256);}catch(error){return{status:'UNRECOVERABLE',generation:manifest.generation,damaged,reason:`Parity group ${group.group} unavailable: ${error.message}`};}
      const recovered=Buffer.from(p);
      for(let i=group.first;i<group.lastExclusive;i++){
        if(i===missing[0])continue;
        for(let j=0;j<recovered.length;j++)recovered[j]^=shards[i][j];
      }
      const spec=manifest.data[missing[0]];
      if(sha(recovered)!==spec.sha256)return{status:'UNRECOVERABLE',generation:manifest.generation,reason:`Recovered oligo ${missing[0]} failed SHA-256.`};
      shards[missing[0]]=recovered;
    }
    if(shards.some(x=>!x))return{status:'UNRECOVERABLE',generation:manifest.generation,reason:'Not all data oligos recovered.'};
    const interleaved=Buffer.concat(shards).subarray(0,manifest.originalBytes);
    const original=unpermute(interleaved,manifest.interleaving.stride).subarray(0,manifest.originalBytes);
    const actual=sha(original);
    return{status:actual===manifest.originalSha256?'RECOVERED':'HASH_MISMATCH',generation:manifest.generation,sha256:actual,expected:manifest.originalSha256,damaged,buffer:original};
  }

  async restore(target,generation=null){const r=await this.recover(generation);if(r.status!=='RECOVERED')throw new Error(`Quaternary recovery failed: ${r.status}`);await ensureDir(path.dirname(target));await fsp.writeFile(target,r.buffer);return{target,generation:r.generation,sha256:r.sha256,damaged:r.damaged};}
}

module.exports={QuaternaryColdCodec,encodeDna,decodeDna,crc32};
