'use strict';

const path = require('path');
const { ensureDir, atomicJson, readJson, now } = require('./jsonfs');
const { get } = require('./query');

function dot(a,b){let s=0;for(let i=0;i<a.length;i++)s+=a[i]*b[i];return s}
function norm(a){return Math.sqrt(dot(a,a))||1}
function cosine(a,b){return dot(a,b)/(norm(a)*norm(b))}
function distance(a,b){return 1-cosine(a,b)}
function validVector(v,dimensions=null){return Array.isArray(v)&&v.length>0&&(!dimensions||v.length===dimensions)&&v.every(Number.isFinite)}

class JsonVectorIndex {
  constructor(engine){this.engine=engine;this.root=path.join(engine.data,'advanced','vector')}
  file(collection,name){return path.join(this.root,collection,`${name}.json`)}

  async build(collection,name,field,m=8){
    m=Math.min(32,Math.max(2,Number(m||8)));
    const rows=await this.engine.readAt(collection);let dimensions=null;const nodes=[];
    for(const row of rows){const vector=get(row,field);if(!validVector(vector,dimensions))continue;if(dimensions==null)dimensions=vector.length;const node={id:row.id,vector:[...vector],neighbors:[]};
      const nearest=nodes.map(other=>({id:other.id,distance:distance(vector,other.vector)})).sort((a,b)=>a.distance-b.distance).slice(0,m);
      node.neighbors=nearest.map(x=>x.id);nodes.push(node);
      for(const n of nearest){const other=nodes.find(x=>x.id===n.id);if(!other)continue;other.neighbors=[...new Set([...other.neighbors,node.id])].map(id=>{const target=nodes.find(x=>x.id===id);return{ id, distance:target?distance(other.vector,target.vector):Infinity}}).sort((a,b)=>a.distance-b.distance).slice(0,m).map(x=>x.id)}
    }
    const graph={type:'single-layer-hnsw-ish',collection,name,field,dimensions:dimensions||0,m,builtAt:now(),entryPoint:nodes[0]?.id||null,nodes:Object.fromEntries(nodes.map(n=>[n.id,n])),disclaimer:'Educational approximate neighbor graph, not full HNSW.'};
    await ensureDir(path.dirname(this.file(collection,name)));await atomicJson(this.file(collection,name),graph);return{collection,name,field,dimensions:graph.dimensions,m,nodes:nodes.length,entryPoint:graph.entryPoint}
  }

  async search(collection,name,query,k=10,ef=64){
    const graph=await readJson(this.file(collection,name),null);if(!graph)throw Object.assign(new Error('Vector index not built.'),{status:404});if(!validVector(query,graph.dimensions))throw Object.assign(new Error(`Query vector must have ${graph.dimensions} dimensions.`),{status:400});
    k=Math.min(100,Math.max(1,Number(k||10)));ef=Math.min(5000,Math.max(k,Number(ef||64)));if(!graph.entryPoint)return{rows:[],visited:0};
    const visited=new Set();const frontier=[{id:graph.entryPoint,distance:distance(query,graph.nodes[graph.entryPoint].vector)}];const best=[];
    while(frontier.length&&visited.size<ef){frontier.sort((a,b)=>a.distance-b.distance);const current=frontier.shift();if(visited.has(current.id))continue;visited.add(current.id);best.push(current);const node=graph.nodes[current.id];for(const id of node.neighbors||[]){if(visited.has(id)||!graph.nodes[id])continue;frontier.push({id,distance:distance(query,graph.nodes[id].vector)})}}
    const ranked=best.sort((a,b)=>a.distance-b.distance).slice(0,k);const wanted=new Map(ranked.map(x=>[x.id,x]));const rows=(await this.engine.readAt(collection)).filter(r=>wanted.has(r.id)).map(row=>({id:row.id,score:1-wanted.get(row.id).distance,distance:wanted.get(row.id).distance,row})).sort((a,b)=>a.distance-b.distance);
    return{collection,index:name,k,ef,visited:visited.size,algorithm:'best-first graph search over JSON neighbor lists',rows}
  }

  async bruteForce(collection,field,query,k=10){const rows=await this.engine.readAt(collection);const ranked=rows.map(row=>({row,vector:get(row,field)})).filter(x=>validVector(x.vector,query.length)).map(x=>({row:x.row,distance:distance(query,x.vector)})).sort((a,b)=>a.distance-b.distance).slice(0,k);return{algorithm:'brute-force cosine baseline',examined:rows.length,rows:ranked.map(x=>({id:x.row.id,distance:x.distance,score:1-x.distance,row:x.row}))}}
}
module.exports={JsonVectorIndex,cosine,distance};
