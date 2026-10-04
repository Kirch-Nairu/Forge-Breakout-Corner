'use strict';

const crypto = require('crypto');
const path = require('path');
const { now, ensureDir, atomicJson } = require('./jsonfs');

function leaves(node, out = new Map()) {
  if (!node) return out;
  if (node.type === 'component') out.set(node.id, node);
  for (const child of node.children || []) leaves(child,out);
  return out;
}

function survives(node, failed = new Set()) {
  if (!node) return false;
  if (node.type === 'component') return !failed.has(node.id);
  const results = (node.children || []).map(child=>survives(child,failed));
  if (node.type === 'all') return results.every(Boolean);
  if (node.type === 'any') return results.some(Boolean);
  if (node.type === 'kofn') return results.filter(Boolean).length >= Number(node.k || 1);
  if (node.type === 'not') return !results[0];
  throw new Error(`Unknown fault-tree node type: ${node.type}`);
}

function combinations(items,k,start=0,prefix=[],out=[]) {
  if (prefix.length===k) { out.push([...prefix]); return out; }
  for (let i=start;i<=items.length-(k-prefix.length);i++) {
    prefix.push(items[i]); combinations(items,k,i+1,prefix,out); prefix.pop();
  }
  return out;
}

function hashSeed(seed,counter) {
  const b=crypto.createHash('sha256').update(`${seed}:${counter}`).digest();
  return b.readUInt32BE(0)/0x100000000;
}

class SurvivalCalculus {
  constructor(root = null) {
    this.root = root;
  }

  async init() { if (this.root) await ensureDir(this.root); }

  validate(model) {
    const components=[...leaves(model).values()];
    const ids=components.map(x=>x.id);
    if (new Set(ids).size!==ids.length) throw new Error('Duplicate component ids in fault tree.');
    if (!components.length) throw new Error('Fault tree has no components.');
    return components;
  }

  minimalCutSets(model, options={}) {
    const components=this.validate(model);
    const ids=components.map(x=>x.id).sort();
    const maxOrder=Math.max(1,Math.min(ids.length,Number(options.maxOrder||4)));
    const maxCombinations=Math.max(100,Number(options.maxCombinations||250000));
    const cuts=[];
    let examined=0;
    outer: for (let order=1;order<=maxOrder;order++) {
      const combos=combinations(ids,order);
      for (const combo of combos) {
        if (++examined>maxCombinations) break outer;
        const failed=new Set(combo);
        if (survives(model,failed)) continue;
        const hasKnownSubset=cuts.some(cut=>cut.every(id=>failed.has(id)));
        if (!hasKnownSubset) cuts.push(combo);
      }
    }
    const sensitivity={};
    for (const id of ids) sensitivity[id]=0;
    for (const cut of cuts) for (const id of cut) sensitivity[id]++;
    const rankedSensitivity=Object.entries(sensitivity).map(([id,count])=>({id,cutSetAppearances:count})).sort((a,b)=>b.cutSetAppearances-a.cutSetAppearances||a.id.localeCompare(b.id));
    return {
      format:'JSONDB-SURVIVAL-CUT-SETS-1',at:now(),
      rootSurvivesWithNoFailures:survives(model,new Set()),
      components:ids.length,maxOrder,examined,truncated:examined>maxCombinations,
      minimalCutSets:cuts,
      smallestCutOrder:cuts.length?Math.min(...cuts.map(x=>x.length)):null,
      rankedSensitivity,
      doctrine:'A minimal cut set is a smallest modeled component-failure set that defeats the survival expression. The model is only as honest as its failure-domain assumptions.'
    };
  }

  monteCarlo(model,options={}) {
    const components=this.validate(model);
    const iterations=Math.max(100,Math.min(5_000_000,Number(options.iterations||10000)));
    const seed=String(options.seed||'jsondb-survival-calculus');
    const domains=options.domains||{};
    let survived=0;
    const componentFailures=Object.fromEntries(components.map(x=>[x.id,0]));
    const domainFailures={};
    for (const domain of Object.keys(domains)) domainFailures[domain]=0;
    for (let iteration=0;iteration<iterations;iteration++) {
      let counter=0;
      const failedDomains=new Set();
      for (const [domain,p] of Object.entries(domains)) {
        if (hashSeed(`${seed}:${iteration}`,counter++)<Number(p)) { failedDomains.add(domain); domainFailures[domain]++; }
      }
      const failed=new Set();
      for (const component of components) {
        const domainDown=component.domain&&failedDomains.has(component.domain);
        const p=Number(component.failureProbability??options.defaultComponentFailureProbability??0.01);
        if (domainDown||hashSeed(`${seed}:${iteration}`,counter++)<p) { failed.add(component.id); componentFailures[component.id]++; }
      }
      if (survives(model,failed)) survived++;
    }
    return {
      format:'JSONDB-SURVIVAL-MONTE-CARLO-1',at:now(),iterations,seed,
      survived,failed:iterations-survived,
      estimatedSurvivalProbability:survived/iterations,
      estimatedFailureProbability:(iterations-survived)/iterations,
      componentFailureRates:Object.fromEntries(Object.entries(componentFailures).map(([id,count])=>[id,count/iterations])),
      domainFailureRates:Object.fromEntries(Object.entries(domainFailures).map(([id,count])=>[id,count/iterations])),
      warning:'Monte Carlo output is a model estimate, not a real-world durability guarantee. Correlation assumptions dominate the result.'
    };
  }

  omegaTemplate() {
    const c=(id,domain,p)=>({type:'component',id,domain,failureProbability:p});
    return {
      type:'any',name:'recover-world-through-any-independent-family',children:[
        { type:'kofn',k:2,name:'trinity-ark',children:[
          c('xor-decoder','software-node',.02),
          c('reed-solomon-decoder','software-node',.02),
          c('surface-parity-decoder','software-node',.02)
        ]},
        { type:'all',name:'memory-palace-path',children:[
          c('memory-manifest','metadata-media',.02),
          {type:'any',children:[c('memory-primary','disk-a',.05),c('memory-vault-1','disk-b',.05),c('memory-vault-2','disk-c',.05),c('memory-vault-3','disk-d',.05)]}
        ]},
        { type:'kofn',k:3,name:'format-polyglot-path',children:[
          c('direct-json-representation','disk-a',.04),
          c('base64-json-representation','disk-b',.04),
          c('hex-json-representation','disk-c',.04),
          c('jsonl-record-representation','disk-d',.04)
        ]},
        { type:'all',name:'civilization-seed-path',children:[
          c('civilization-seed','cold-media',.03),
          {type:'any',children:[c('node-runtime','runtime-node',.05),c('python-runtime','runtime-python',.05)]}
        ]},
        { type:'kofn',k:6,name:'self-describing-rs-packets',children:Array.from({length:9},(_,i)=>c(`rs-packet-${i+1}`,`removable-${i+1}`,.08)) }
      ]
    };
  }

  async analyze(model=this.omegaTemplate(),options={}) {
    await this.init();
    const cuts=this.minimalCutSets(model,options);
    const simulation=this.monteCarlo(model,options);
    const report={format:'JSONDB-SURVIVAL-CALCULUS-1',at:now(),model,cuts,simulation};
    if (this.root) await atomicJson(path.join(this.root,'latest.json'),report);
    return report;
  }
}

module.exports={SurvivalCalculus,survives,leaves,combinations};
