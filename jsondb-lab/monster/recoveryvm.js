'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, ensureDir } = require('./jsonfs');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
function safeResolve(root, relative) {
  const clean = String(relative || '').replace(/\\/g,'/');
  if (!clean || path.isAbsolute(clean) || clean.split('/').includes('..')) throw new Error(`Recovery VM rejected unsafe path: ${relative}`);
  const resolved = path.resolve(root, clean);
  const base = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(base)) throw new Error(`Recovery VM path escaped sandbox: ${relative}`);
  return resolved;
}
function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value);
  return Buffer.from(JSON.stringify(canonical(value)));
}
function getPath(value, selector) {
  const parts = Array.isArray(selector) ? selector : String(selector || '').split('.').filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current == null) return undefined;
    const key = Array.isArray(current) && /^\d+$/.test(String(part)) ? Number(part) : part;
    current = current[key];
  }
  return current;
}
function xorBuffers(buffers) {
  if (!buffers.length) return Buffer.alloc(0);
  const size = buffers[0].length;
  if (!buffers.every(x=>x.length===size)) throw new Error('Recovery VM XOR requires equal buffer lengths.');
  const out = Buffer.alloc(size);
  for (const b of buffers) for (let i=0;i<size;i++) out[i]^=b[i];
  return out;
}
function describe(value) {
  if (Buffer.isBuffer(value)) return { type:'bytes', bytes:value.length, sha256:crypto.createHash('sha256').update(value).digest('hex') };
  if (Array.isArray(value)) return { type:'array', length:value.length };
  if (value&&typeof value==='object') return { type:'object', keys:Object.keys(value).length };
  if (typeof value==='string') return { type:'string', length:value.length };
  return { type:typeof value, value: ['number','boolean'].includes(typeof value)?value:undefined };
}

class RecoveryVM {
  constructor({ inputRoot, outputRoot, maxSteps = 10000, maxReadBytes = 128 * 1024 * 1024 }) {
    this.inputRoot = path.resolve(inputRoot);
    this.outputRoot = path.resolve(outputRoot);
    this.maxSteps = maxSteps;
    this.maxReadBytes = maxReadBytes;
    this.registers = new Map();
    this.readBytes = 0;
    this.trace = [];
  }

  reg(name) {
    if (!this.registers.has(name)) throw new Error(`Recovery VM register not found: ${name}`);
    return this.registers.get(name);
  }
  set(name,value) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(String(name||''))) throw new Error(`Invalid Recovery VM register: ${name}`);
    this.registers.set(name,value);
  }
  async readFile(relative,encoding=null) {
    const file=safeResolve(this.inputRoot,relative);
    const stat=await fsp.stat(file);
    this.readBytes+=stat.size;
    if (this.readBytes>this.maxReadBytes) throw new Error(`Recovery VM exceeded ${this.maxReadBytes} input bytes.`);
    return encoding?fsp.readFile(file,encoding):fsp.readFile(file);
  }

  async step(spec,index) {
    const op=String(spec.op||'');
    let result;
    if (op==='const') result=spec.value;
    else if (op==='read-json') result=JSON.parse(await this.readFile(spec.path,'utf8'));
    else if (op==='read-text') result=await this.readFile(spec.path,'utf8');
    else if (op==='read-bytes') result=await this.readFile(spec.path);
    else if (op==='get') result=getPath(this.reg(spec.from),spec.path);
    else if (op==='json-parse') result=JSON.parse(String(this.reg(spec.from)));
    else if (op==='canonical-json') result=Buffer.from(JSON.stringify(canonical(this.reg(spec.from))));
    else if (op==='to-buffer') result=asBuffer(this.reg(spec.from));
    else if (op==='base64-decode') result=Buffer.from(String(this.reg(spec.from)),'base64');
    else if (op==='hex-decode') result=Buffer.from(String(this.reg(spec.from)),'hex');
    else if (op==='concat') result=Buffer.concat((spec.from||[]).map(name=>asBuffer(this.reg(name))));
    else if (op==='join') result=(this.reg(spec.from)||[]).join(spec.separator??'');
    else if (op==='xor') result=xorBuffers((spec.from||[]).map(name=>asBuffer(this.reg(name))));
    else if (op==='slice') result=asBuffer(this.reg(spec.from)).subarray(Number(spec.start||0),spec.end==null?undefined:Number(spec.end));
    else if (op==='sha256') result=crypto.createHash('sha256').update(asBuffer(this.reg(spec.from))).digest(spec.encoding==='bytes'?undefined:'hex');
    else if (op==='length') { const v=this.reg(spec.from); result=Buffer.isBuffer(v)||typeof v==='string'||Array.isArray(v)?v.length:Object.keys(v||{}).length; }
    else if (op==='assert-eq') {
      const left=spec.leftRegister?this.reg(spec.leftRegister):spec.left;
      const right=spec.rightRegister?this.reg(spec.rightRegister):spec.right;
      const equal=Buffer.isBuffer(left)&&Buffer.isBuffer(right)?left.equals(right):JSON.stringify(canonical(left))===JSON.stringify(canonical(right));
      if (!equal) throw new Error(spec.message||`Recovery VM assertion failed at step ${index}`);
      result=true;
    }
    else if (op==='write-bytes') {
      const file=safeResolve(this.outputRoot,spec.path); await ensureDir(path.dirname(file));
      const buffer=asBuffer(this.reg(spec.from)); await fsp.writeFile(file,buffer); result={file,bytes:buffer.length};
    }
    else if (op==='write-text') {
      const file=safeResolve(this.outputRoot,spec.path); await ensureDir(path.dirname(file));
      const text=String(this.reg(spec.from)); await fsp.writeFile(file,text,'utf8'); result={file,bytes:Buffer.byteLength(text)};
    }
    else if (op==='write-json') {
      const file=safeResolve(this.outputRoot,spec.path); await ensureDir(path.dirname(file));
      const text=`${JSON.stringify(canonical(this.reg(spec.from)),null,2)}\n`; await fsp.writeFile(file,text,'utf8'); result={file,bytes:Buffer.byteLength(text)};
    }
    else throw new Error(`Unsupported Recovery VM op: ${op}`);
    if (spec.out) this.set(spec.out,result);
    const trace={index,op,out:spec.out||null,result:describe(result)};
    this.trace.push(trace);
    return trace;
  }

  async execute(program) {
    if (program?.format!=='JSONDB-RECOVERY-VM-1') throw new Error('Unsupported Recovery VM program format.');
    const steps=program.steps||[];
    if (!Array.isArray(steps)||steps.length>this.maxSteps) throw new Error(`Recovery VM program exceeds ${this.maxSteps} steps.`);
    await ensureDir(this.outputRoot);
    for (let i=0;i<steps.length;i++) await this.step(steps[i],i);
    return {
      format:'JSONDB-RECOVERY-VM-RESULT-1',programId:program.id||null,
      completedAt:now(),steps:steps.length,inputRoot:this.inputRoot,outputRoot:this.outputRoot,
      readBytes:this.readBytes,registers:Object.fromEntries([...this.registers].map(([name,value])=>[name,describe(value)])),trace:this.trace,
      doctrine:'Recovery VM has no shell/network/eval operations. It can read only inside inputRoot and write only inside outputRoot.'
    };
  }
}

module.exports={RecoveryVM,canonical,safeResolve,asBuffer,getPath,xorBuffers};
