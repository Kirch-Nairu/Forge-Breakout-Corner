'use strict';

const path=require('path');const crypto=require('crypto');const {now,ensureDir,atomicJson}=require('./jsonfs');const {canonical}=require('./truth');
function stable(v){return JSON.stringify(canonical(v))}function seedOf(v){return parseInt(crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,8),16)>>>0}
function rng(seed){let x=seed||0x9e3779b9;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/4294967296}}
function weightedChoices(values){const map=new Map();for(const value of values){const k=stable(value),s=map.get(k)||{value,count:0,key:k};s.count++;map.set(k,s)}return[...map.values()].sort((a,b)=>b.count-a.count||a.key.localeCompare(b.key))}

class AnnealingHypothesisLab{
 constructor(savior){this.savior=savior;this.root=path.join(savior.root,'annealing-hypotheses')}
 async init(){await ensureDir(this.root)}
 async problem(relativePath){
  await this.init();await this.savior.mirrors.init();const copies=[];for(const cell of this.savior.mirrors.cells()){const file=path.join(this.savior.mirrors.cellsRoot,cell,relativePath);try{const t=JSON.parse(await require('fs/promises').readFile(file,'utf8'));if(t?.name&&Array.isArray(t.rows))copies.push({cell,table:t})}catch{}}
  const quorum=Math.floor(this.savior.mirrors.cells().length/2)+1;if(copies.length<2)throw new Error('Not enough parseable mirror copies to build hypotheses.');const maps=copies.map(c=>({cell:c.cell,rows:new Map(c.table.rows.filter(r=>r?.id).map(r=>[r.id,r]))})),ids=new Set();for(const m of maps)for(const id of m.rows.keys())ids.add(id);const fixed=[],variables=[];
  for(const id of [...ids].sort()){
   const rowCopies=maps.filter(m=>m.rows.has(id)).map(m=>m.rows.get(id));if(!rowCopies.length)continue;const exact=weightedChoices(rowCopies);if(exact[0]?.count>=quorum){fixed.push(exact[0].value);continue}
   const row={id},fields=new Set(['id']);for(const r of rowCopies)for(const f of Object.keys(r))fields.add(f);const rowVars=[];
   for(const field of [...fields].sort()){const values=rowCopies.map(r=>Object.prototype.hasOwnProperty.call(r,field)?r[field]:{__absent:true}),choices=weightedChoices(values);if(choices[0]?.count>=quorum){if(!choices[0].value?.__absent)row[field]=choices[0].value}else rowVars.push({name:`${id}.${field}`,rowId:id,field,choices:choices.map(c=>({value:c.value,votes:c.count,evidence:c.count/copies.length}))})}
   if(rowVars.length){variables.push(...rowVars);fixed.push(row)}else fixed.push(row)
  }
  return{format:'JSONDB-ANNEAL-PROBLEM-1',relativePath,createdAt:now(),quorum,copies:copies.map(c=>c.cell),fixed,variables};
 }
 score(problem,state,invariants=[]){let score=0;for(let i=0;i<problem.variables.length;i++){const choice=problem.variables[i].choices[state[i]];score+=choice.votes*10;if(choice.value?.__absent)score-=2}for(const inv of invariants){const variableIndex=problem.variables.findIndex(v=>v.name===inv.variable);if(variableIndex<0)continue;const value=problem.variables[variableIndex].choices[state[variableIndex]].value;if(inv.type==='required'&&(value==null||value?.__absent||value===''))score-=Math.abs(inv.penalty||30);if(inv.type==='nonnegative'&&typeof value==='number'&&value<0)score-=Math.abs(inv.penalty||30);if(inv.type==='type'&&typeof value!==inv.value)score-=Math.abs(inv.penalty||20)}return score}
 async solve(relativePath,options={}){
  const problem=await this.problem(relativePath),n=problem.variables.length;if(!n){return{status:'NO_AMBIGUITY',problem}}
  const random=rng(Number(options.seed??seedOf(problem))),iterations=Math.max(1000,Math.min(500000,Number(options.iterations||30000))),state=problem.variables.map(v=>0);let current=this.score(problem,state,options.invariants||[]),best=[...state],bestScore=current;const trace=[];
  for(let step=0;step<iterations;step++){const t0=Number(options.startTemperature||12),t1=Number(options.endTemperature||.01),temperature=t0*Math.pow(t1/t0,step/Math.max(1,iterations-1)),idx=Math.floor(random()*n),choices=problem.variables[idx].choices;if(choices.length<2)continue;const old=state[idx];let next=old;while(next===old)next=Math.floor(random()*choices.length);state[idx]=next;const candidate=this.score(problem,state,options.invariants||[]),delta=candidate-current;if(delta>=0||random()<Math.exp(delta/Math.max(.000001,temperature)))current=candidate;else state[idx]=old;if(current>bestScore){bestScore=current;best=[...state]}if(step%(Math.max(1,Math.floor(iterations/20)))===0)trace.push({step,temperature,current,best:bestScore})}
  const rows=new Map(problem.fixed.map(r=>[r.id,{...r}])),assignments=[];for(let i=0;i<problem.variables.length;i++){const variable=problem.variables[i],choice=variable.choices[best[i]],row=rows.get(variable.rowId)||{id:variable.rowId};if(!choice.value?.__absent)row[variable.field]=choice.value;else delete row[variable.field];rows.set(variable.rowId,row);assignments.push({variable:variable.name,value:choice.value,votes:choice.votes,evidence:choice.evidence})}
  const table={name:path.basename(relativePath,'.json'),meta:{reconstructedAt:now(),source:'annealing-hypothesis',authority:'HYPOTHESIS_ONLY',warning:'This result did not reach deterministic quorum and must never be auto-promoted.'},rows:[...rows.values()].sort((a,b)=>String(a.id).localeCompare(String(b.id)))};const id=`${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,file=path.join(this.root,`${id}.json`);await atomicJson(file,table);await atomicJson(path.join(this.root,`${id}.evidence.json`),{format:'JSONDB-ANNEAL-HYPOTHESIS-1',at:now(),authority:'HYPOTHESIS_ONLY',relativePath,bestScore,iterations,assignments,trace,problem:{quorum:problem.quorum,copies:problem.copies,variables:problem.variables}});return{status:'HYPOTHESIS_ONLY',file,bestScore,iterations,assignments,trace,warning:'Search output is forensic speculation, not recovered truth.'}
 }
}
module.exports={AnnealingHypothesisLab,weightedChoices};
