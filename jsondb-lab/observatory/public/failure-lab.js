'use strict';

(() => {
  const state = { graph: null, disabled: new Set() };
  const el = id => document.getElementById(id);

  async function loadGraph() {
    try {
      const response = await fetch('/api/recovery-graph', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.graph = await response.json();
      renderControls();
      evaluate();
    } catch (error) {
      console.error('Failure lab graph load failed', error);
    }
  }

  function selectableNodes() {
    return (state.graph?.nodes || []).filter(node => node.present && ['reconstructive','historical','corroborative','authority-evidence','transport','interpretation','bootstrap'].includes(node.kind));
  }

  function renderControls() {
    const host = el('failure-capabilities');
    if (!host) return;
    host.replaceChildren();
    for (const node of selectableNodes()) {
      const label = document.createElement('label');
      label.className = `failure-capability ${state.disabled.has(node.id) ? 'disabled' : ''}`;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = state.disabled.has(node.id);
      input.addEventListener('change', () => {
        if (input.checked) state.disabled.add(node.id); else state.disabled.delete(node.id);
        label.classList.toggle('disabled', input.checked);
        evaluate();
      });
      const name = document.createElement('span');
      name.textContent = node.label || node.id;
      const role = document.createElement('small');
      role.textContent = node.kind;
      label.append(input, name, role);
      host.appendChild(label);
    }
  }

  function available(kind) {
    return (state.graph?.nodes || []).filter(node => node.present && node.kind === kind && !state.disabled.has(node.id));
  }

  function reconstructors() {
    return (state.graph?.nodes || []).filter(node => node.present && (node.reconstructs || []).length && !state.disabled.has(node.id));
  }

  function corroborators() {
    return (state.graph?.nodes || []).filter(node => node.present && !(node.reconstructs || []).length && (node.corroborates || []).length && !state.disabled.has(node.id));
  }

  function evaluate() {
    if (!state.graph) return;
    const sources = reconstructors();
    const corroboration = corroborators();
    const source = sources[0] || null;
    const ready = Boolean(source && corroboration.length >= 2);
    const result = el('failure-result');
    result.className = `failure-result ${ready ? 'ready' : 'blocked'}`;
    result.replaceChildren();

    const status = document.createElement('strong');
    status.textContent = ready ? 'PLAN POSSIBLE' : 'BLOCKED SAFE';
    const explanation = document.createElement('p');
    explanation.textContent = ready
      ? `Browser-only simulation would nominate ${source.label || source.id} as a reconstructive source with ${corroboration.length} non-reconstructive corroborators still visible.`
      : source
        ? `A reconstructive source remains (${source.label || source.id}), but fewer than two non-reconstructive corroborators are visible.`
        : 'No visible reconstructive source remains. The lab refuses to invent one.';
    const route = document.createElement('code');
    route.textContent = ready
      ? `${source.id} → [${corroboration.slice(0, 3).map(x => x.id).join(', ')}] → Recovery Jury → HUMAN BOUNDARY`
      : 'NO DEFENSIBLE VISUAL ROUTE';
    result.append(status, explanation, route);

    el('failure-disabled-count').textContent = String(state.disabled.size);
    el('failure-source-count').textContent = String(sources.length);
    el('failure-corroborator-count').textContent = String(corroboration.length);

    document.querySelectorAll('.recovery-node').forEach(node => {
      node.classList.toggle('simulated-dead', state.disabled.has(node.dataset.id));
    });
  }

  function reset() {
    state.disabled.clear();
    renderControls();
    evaluate();
  }

  document.addEventListener('DOMContentLoaded', () => {
    el('failure-reset')?.addEventListener('click', reset);
    loadGraph();
    document.addEventListener('observatory:snapshot', loadGraph);
  });
})();

// OMEGA forensic knowledge graph. This is a browser-only read model composed from
// existing read-only Observatory APIs; it never writes JSONDB or recovery evidence.
(() => {
  const kg = {
    nodes: [], edges: [], nodeById: new Map(), visibleNodes: [], visibleEdges: [],
    snapshot: null, recovery: null, canvas: null, ctx: null,
    width: 1000, height: 620, zoom: 1, panX: 0, panY: 0,
    selected: null, hovered: null, dragging: null, panning: false, pointerStart: null, panStart: null,
    temperature: 1, frozen: false, layer: 'all', layout: 'force', frame: 0
  };

  const COLORS = {
    runtime:'#65e6ff', collection:'#6da7ff', index:'#7ed6ff', wal:'#65e6ff', recovery:'#b48cff', history:'#f4c761', savior:'#d0b8ff', absent:'#53606a'
  };
  const el = id => document.getElementById(id);
  const fmt = value => Number(value || 0).toLocaleString();

  function injectNavAndView() {
    const nav = document.querySelector('.nav');
    if (nav && !nav.querySelector('[data-view="knowledge"]')) {
      const button = document.createElement('button');
      button.className = 'nav-item';
      button.dataset.view = 'knowledge';
      button.innerHTML = '<span>11</span>Knowledge Graph';
      button.addEventListener('click', () => setTimeout(() => {
        const title = el('view-title');
        if (title) title.textContent = 'Forensic Knowledge Graph';
        resize(); kg.temperature = Math.max(kg.temperature, .4);
      }, 0));
      nav.appendChild(button);
    }

    const main = document.querySelector('.main');
    if (!main || el('view-knowledge')) return;
    main.insertAdjacentHTML('beforeend', `
      <section class="view" id="view-knowledge">
        <article class="panel">
          <div class="panel-head"><div><span class="kicker">OMEGA KNOWLEDGE TOPOLOGY</span><h2>Forensic Obsidian Graph</h2></div><span class="tag" id="omegaGraphState">READ-ONLY MODEL</span></div>
          <p class="muted">Combines observed engine surfaces, canonical collections, persisted index definitions, recent WAL entries, and Recovery Contract topology. Node placement is explanatory; live glow is driven by real Observatory events.</p>
          <div class="control-grid">
            <label><span>Layer</span><select id="omegaGraphLayer"><option value="all">All systems</option><option value="storage">Storage + collections</option><option value="wal">WAL neighborhood</option><option value="recovery">Recovery constellation</option></select></label>
            <label><span>Layout</span><select id="omegaGraphLayout"><option value="force">Force / Obsidian</option><option value="radial">Radial</option><option value="layered">Layered architecture</option></select></label>
            <label><span>Simulation</span><select id="omegaGraphSimulation"><option value="live">Physics live</option><option value="freeze">Freeze positions</option></select></label>
          </div>
          <div class="control-grid">
            <label><span>Search</span><input id="omegaGraphSearch" autocomplete="off" placeholder="WAL, collection, savior, contract…"></label>
            <button class="ghost control-button" id="omegaGraphFocus">Focus node</button>
            <button class="ghost control-button" id="omegaGraphRefresh">Rebuild graph</button>
          </div>
          <div class="metric-grid">
            <article class="metric"><span>Graph nodes</span><strong id="omegaGraphNodes">0</strong><small>visible entities</small></article>
            <article class="metric"><span>Graph edges</span><strong id="omegaGraphEdges">0</strong><small>visible relationships</small></article>
            <article class="metric"><span>Hot nodes</span><strong id="omegaGraphHot">0</strong><small>recent observation heat</small></article>
            <article class="metric"><span>Zoom</span><strong id="omegaGraphZoom">100%</strong><small>viewport scale</small></article>
          </div>
          <canvas id="omegaGraphCanvas" width="1200" height="620" tabindex="0" aria-label="OMEGA forensic knowledge graph"></canvas>
        </article>
        <div class="split">
          <article class="panel detail-panel"><div class="panel-head"><div><span class="kicker">NODE INSPECTOR</span><h2 id="omegaGraphInspectorTitle">Select a node</h2></div><span class="tag" id="omegaGraphInspectorKind">—</span></div><pre id="omegaGraphInspector">Click a node to inspect its observed metadata and relationships.</pre></article>
          <article class="panel"><div class="panel-head"><div><span class="kicker">RELATIONSHIP TRUTH</span><h2>What the lines mean</h2></div><span class="tag">NO FAKE TRACE</span></div><dl class="facts"><div><dt>Runtime edges</dt><dd>documented engine architecture</dd></div><div><dt>Collection edges</dt><dd>canonical catalog + persisted indexes</dd></div><div><dt>WAL edges</dt><dd>recent observed log entries</dd></div><div><dt>Recovery edges</dt><dd>Recovery Contract dependencies / archive sealing</dd></div><div><dt>Heat / particles</dt><dd>live normalized Observatory events</dd></div></dl></article>
        </div>
      </section>`);
  }

  function addNode(input) {
    if (kg.nodeById.has(input.id)) return kg.nodeById.get(input.id);
    const a = Math.random() * Math.PI * 2, r = 90 + Math.random() * 260;
    const node = { x:Math.cos(a)*r, y:Math.sin(a)*r, vx:0, vy:0, pinned:false, activity:0, present:true, ...input };
    kg.nodes.push(node); kg.nodeById.set(node.id,node); return node;
  }
  function addEdge(from,to,relation,weight=1) {
    if (!kg.nodeById.has(from)||!kg.nodeById.has(to)) return;
    const id=`${from}|${relation}|${to}`;
    if (!kg.edges.some(edge=>edge.id===id)) kg.edges.push({id,from,to,relation,weight});
  }

  async function fetchJson(url) {
    const response = await fetch(url,{cache:'no-store'});
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }

  async function rebuild() {
    const badge=el('omegaGraphState'); if (badge) badge.textContent='REBUILDING';
    const [snapshot,recovery]=await Promise.all([fetchJson('/api/snapshot'),fetchJson('/api/recovery-graph')]);
    kg.snapshot=snapshot; kg.recovery=recovery; kg.nodes=[]; kg.edges=[]; kg.nodeById=new Map();

    const runtime=[['app','APPLICATION','runtime'],['tx','TRANSACTION','runtime'],['wal','WAL','wal'],['current','CURRENT STATE','runtime'],['index','INDEXES','index'],['history','VERSION HISTORY','history'],['savior','LAST SAVIOR','savior']];
    for (const [id,label,kind] of runtime) addNode({id:`runtime:${id}`,label,kind,layer:id==='savior'?'recovery':'storage',weight:id==='current'?24:17});
    addEdge('runtime:app','runtime:tx','intent',1.4); addEdge('runtime:tx','runtime:wal','append',1.6); addEdge('runtime:wal','runtime:current','materialize',1.6); addEdge('runtime:current','runtime:index','derive',1.2); addEdge('runtime:current','runtime:history','version',1.1); addEdge('runtime:history','runtime:savior','survival',1.3);

    for (const collection of snapshot.collections||[]) {
      const id=`collection:${collection.name}`;
      addNode({id,label:collection.name,kind:'collection',layer:'storage',rows:collection.rows,revision:collection.revision,updatedAt:collection.updatedAt,weight:8+Math.min(24,Math.log2(2+Number(collection.rows||0))*2),indexes:collection.indexes||[]});
      addEdge('runtime:current',id,'canonical-table',.65);
      for (const index of collection.indexes||[]) {
        const indexId=`index:${collection.name}:${index.name}`;
        addNode({id:indexId,label:index.name,kind:'index',layer:'storage',collection:collection.name,fields:index.fields||[],unique:Boolean(index.unique),weight:6});
        addEdge(id,indexId,'indexed-by',.75); addEdge('runtime:index',indexId,'persisted-index',.35);
      }
    }

    for (const entry of (snapshot.wal||[]).slice(-40)) {
      const id=`wal:${entry.lsn??entry.tx??Math.random()}`;
      addNode({id,label:`LSN ${entry.lsn??'?'} · ${entry.type||'ENTRY'}`,kind:'wal',layer:'wal',lsn:entry.lsn,type:entry.type,tx:entry.tx,at:entry.at,raw:entry,weight:4.5});
      addEdge('runtime:wal',id,'log-entry',.18);
      if (entry.collection && kg.nodeById.has(`collection:${entry.collection}`)) addEdge(id,`collection:${entry.collection}`,'mutates',.3);
    }

    for (const node of recovery.nodes||[]) {
      const id=`recovery:${node.id}`;
      addNode({id,label:node.label||node.id,kind:node.id==='last-savior'?'savior':'recovery',layer:'recovery',present:Boolean(node.present),contractKind:node.kind,reconstructs:node.reconstructs||[],corroborates:node.corroborates||[],dependencies:node.dependencies||[],mayPromoteCanonical:Boolean(node.mayPromoteCanonical),weight:node.id==='last-savior'?20:8});
      if (node.id==='last-savior') addEdge('runtime:savior',id,'archive',1.4);
    }
    for (const edge of recovery.edges||[]) addEdge(`recovery:${edge.from}`,`recovery:${edge.to}`,edge.relation||'depends-on',.9);
    for (const node of recovery.nodes||[]) if (node.id!=='last-savior'&&node.present&&kg.nodeById.has(`recovery:${node.id}`)&&kg.nodeById.has('recovery:last-savior')) addEdge(`recovery:${node.id}`,'recovery:last-savior','survival-evidence',.22);

    applyLayout(el('omegaGraphLayout')?.value||'force',true); filter(); fit();
    if (badge) badge.textContent='READ-ONLY MODEL';
  }

  function applyLayout(layout,hard=false) {
    kg.layout=layout;
    const nodes=kg.nodes;
    if (layout==='layered') {
      const groups={runtime:-420,collection:-160,index:100,wal:340,recovery:360,savior:480,history:160};
      const counters={};
      for (const node of nodes) {
        const key=node.kind; counters[key]=(counters[key]||0)+1;
        node.x=groups[key]??0; node.y=(counters[key]-1)*42-((nodes.filter(n=>n.kind===key).length-1)*21); node.vx=node.vy=0;
      }
    } else if (layout==='radial') {
      const majors=nodes.filter(n=>n.id.startsWith('runtime:'));
      majors.forEach((node,i)=>{const a=Math.PI*2*i/majors.length;node.x=Math.cos(a)*180;node.y=Math.sin(a)*180;node.vx=node.vy=0;});
      for (const node of nodes.filter(n=>!majors.includes(n))) {const base=node.layer==='recovery'?2.1:node.layer==='wal'?.2:4.2;const a=base+(Math.random()-.5)*1.3;const r=node.layer==='recovery'?390:node.layer==='wal'?330:280+Math.random()*130;node.x=Math.cos(a)*r;node.y=Math.sin(a)*r;}
    } else if (hard) {
      for (const node of nodes) {const base=node.layer==='recovery'?2.2:node.layer==='wal'?0:4.3;const a=base+(Math.random()-.5)*1.8;const r=100+Math.random()*360;node.x=Math.cos(a)*r;node.y=Math.sin(a)*r;node.vx=node.vy=0;}
    }
    kg.temperature=1;
  }

  function filter() {
    const layer=el('omegaGraphLayer')?.value||'all'; kg.layer=layer;
    if (layer==='all') kg.visibleNodes=[...kg.nodes];
    else if (layer==='storage') kg.visibleNodes=kg.nodes.filter(node=>node.layer==='storage'||node.kind==='runtime'||node.kind==='history');
    else if (layer==='wal') kg.visibleNodes=kg.nodes.filter(node=>node.layer==='wal'||node.id==='runtime:wal'||node.id==='runtime:tx'||node.id==='runtime:current'||node.kind==='collection');
    else kg.visibleNodes=kg.nodes.filter(node=>node.layer==='recovery'||node.kind==='savior'||node.id==='runtime:history'||node.id==='runtime:savior');
    const ids=new Set(kg.visibleNodes.map(node=>node.id)); kg.visibleEdges=kg.edges.filter(edge=>ids.has(edge.from)&&ids.has(edge.to));
    if (el('omegaGraphNodes')) el('omegaGraphNodes').textContent=fmt(kg.visibleNodes.length);
    if (el('omegaGraphEdges')) el('omegaGraphEdges').textContent=fmt(kg.visibleEdges.length);
    kg.temperature=Math.max(kg.temperature,.5);
  }

  function centerFor(node) {
    if (node.layer==='recovery') return [300,180]; if (node.layer==='wal') return [-300,-170]; if (node.kind==='collection'||node.kind==='index') return [120,-80]; return [-120,100];
  }

  function simulate() {
    if (kg.frozen) return;
    const nodes=kg.visibleNodes, temp=Math.max(.035,kg.temperature);
    for (let i=0;i<nodes.length;i++) for (let j=i+1;j<nodes.length;j++) {
      const a=nodes[i],b=nodes[j];let dx=b.x-a.x,dy=b.y-a.y,d2=dx*dx+dy*dy+36;if(d2>180000)continue;const inv=1/Math.sqrt(d2),force=Math.min(1.5,7200/d2)*temp;dx*=inv;dy*=inv;
      if(!a.pinned){a.vx-=dx*force;a.vy-=dy*force}if(!b.pinned){b.vx+=dx*force;b.vy+=dy*force}
    }
    for (const edge of kg.visibleEdges) {const a=kg.nodeById.get(edge.from),b=kg.nodeById.get(edge.to);if(!a||!b)continue;const dx=b.x-a.x,dy=b.y-a.y,dist=Math.max(1,Math.hypot(dx,dy)),desired=edge.relation==='log-entry'?65:edge.relation==='indexed-by'?82:120,force=(dist-desired)*.0036*(edge.weight||1)*temp,nx=dx/dist,ny=dy/dist;if(!a.pinned){a.vx+=nx*force;a.vy+=ny*force}if(!b.pinned){b.vx-=nx*force;b.vy-=ny*force}}
    for (const node of nodes) {const[cx,cy]=centerFor(node);if(!node.pinned){node.vx+=(cx-node.x)*.00075*temp;node.vy+=(cy-node.y)*.00075*temp;node.vx*=.87;node.vy*=.87;const s=Math.hypot(node.vx,node.vy);if(s>11){node.vx=node.vx/s*11;node.vy=node.vy/s*11}node.x+=node.vx;node.y+=node.vy}node.activity*=.971;if(node.activity<.01)node.activity=0}
    kg.temperature*=.994;
  }

  function resize() {
    const canvas=el('omegaGraphCanvas');if(!canvas)return;const width=Math.max(520,Math.floor(canvas.parentElement.clientWidth-28));const height=Math.max(480,Math.min(720,Math.floor(window.innerHeight*.62)));if(width===kg.width&&height===kg.height)return;kg.width=width;kg.height=height;canvas.width=width;canvas.height=height;kg.canvas=canvas;kg.ctx=canvas.getContext('2d');
  }
  function world(node){return{x:node.x*kg.zoom+kg.panX+kg.width/2,y:node.y*kg.zoom+kg.panY+kg.height/2}}
  function inverse(x,y){return{x:(x-kg.panX-kg.width/2)/kg.zoom,y:(y-kg.panY-kg.height/2)/kg.zoom}}
  function radius(node){if(node.kind==='runtime'||node.kind==='savior')return 10;if(node.kind==='collection')return 7+Math.min(8,Math.log2(2+Number(node.rows||0)));if(node.kind==='recovery')return 6.5;if(node.kind==='index')return 5;return 3.7}
  function color(node){if(!node.present)return COLORS.absent;return COLORS[node.kind]||COLORS[node.layer]||COLORS.runtime}
  function rgba(hex,a){const h=hex.replace('#','');const n=parseInt(h,16);return`rgba(${n>>16&255},${n>>8&255},${n&255},${a})`}
  function hash(value){let h=0;for(const c of String(value))h=((h<<5)-h+c.charCodeAt(0))|0;return Math.abs(h)}

  function draw() {
    resize();const ctx=kg.ctx;if(!ctx)return;simulate();ctx.clearRect(0,0,kg.width,kg.height);ctx.fillStyle='#080b0e';ctx.fillRect(0,0,kg.width,kg.height);
    ctx.globalAlpha=.09;ctx.strokeStyle='#65e6ff';ctx.lineWidth=.5;for(let x=((kg.panX+kg.width/2)%52+52)%52;x<kg.width;x+=52){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,kg.height);ctx.stroke()}for(let y=((kg.panY+kg.height/2)%52+52)%52;y<kg.height;y+=52){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(kg.width,y);ctx.stroke()}ctx.globalAlpha=1;
    for(const edge of kg.visibleEdges){const a=kg.nodeById.get(edge.from),b=kg.nodeById.get(edge.to);if(!a||!b)continue;const p=world(a),q=world(b),hot=Math.max(a.activity,b.activity);ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.strokeStyle=hot>.05?rgba(color(a),.3+Math.min(.5,hot*.5)):'rgba(112,130,140,.13)';ctx.lineWidth=hot>.05?1.3+hot*1.5:edge.relation==='log-entry'?.45:.8;if(edge.relation.includes('depend')||edge.relation.includes('evidence'))ctx.setLineDash([4,5]);ctx.stroke();ctx.setLineDash([]);if(hot>.18){const t=(performance.now()/700+hash(edge.id)%100/100)%1,x=p.x+(q.x-p.x)*t,y=p.y+(q.y-p.y)*t;ctx.beginPath();ctx.arc(x,y,2.2,0,Math.PI*2);ctx.fillStyle=color(a);ctx.shadowColor=color(a);ctx.shadowBlur=12;ctx.fill();ctx.shadowBlur=0}}
    let hotCount=0;
    for(const node of kg.visibleNodes){const p=world(node),r=radius(node),c=color(node);if(node.activity>.07)hotCount++;if(node.activity>.03||node===kg.selected||node===kg.hovered){ctx.beginPath();ctx.arc(p.x,p.y,r+8+node.activity*13,0,Math.PI*2);ctx.fillStyle=rgba(c,.05+node.activity*.09);ctx.fill()}ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fillStyle=node.present?c:rgba(c,.45);ctx.shadowColor=c;ctx.shadowBlur=node.activity>.04?10+node.activity*22:(node.kind==='savior'?10:2);ctx.fill();ctx.shadowBlur=0;if(node===kg.selected){ctx.beginPath();ctx.arc(p.x,p.y,r+4,0,Math.PI*2);ctx.strokeStyle='#fff';ctx.lineWidth=1.2;ctx.stroke()}if(node.pinned){ctx.beginPath();ctx.arc(p.x,p.y,r+2,0,Math.PI*2);ctx.strokeStyle='#f4c761';ctx.lineWidth=.8;ctx.stroke()}if(['runtime','collection','savior'].includes(node.kind)||node===kg.hovered||node===kg.selected||(kg.zoom>1.35&&['index','recovery'].includes(node.kind))){ctx.font=`${node.kind==='runtime'?700:600} 8px ui-monospace,Consolas,monospace`;ctx.fillStyle=node===kg.selected?'#fff':'rgba(220,232,238,.78)';ctx.textAlign='center';ctx.textBaseline='top';ctx.fillText(node.label.slice(0,34),p.x,p.y+r+5)}}
    if(el('omegaGraphHot'))el('omegaGraphHot').textContent=String(hotCount);if(el('omegaGraphZoom'))el('omegaGraphZoom').textContent=`${Math.round(kg.zoom*100)}%`;kg.frame=requestAnimationFrame(draw);
  }

  function fit(){const nodes=kg.visibleNodes;if(!nodes.length)return;const xs=nodes.map(n=>n.x),ys=nodes.map(n=>n.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),sx=Math.max(100,maxX-minX),sy=Math.max(100,maxY-minY);kg.zoom=Math.max(.22,Math.min(1.3,Math.min((kg.width-100)/sx,(kg.height-100)/sy)));kg.panX=-(minX+maxX)/2*kg.zoom;kg.panY=-(minY+maxY)/2*kg.zoom}
  function hit(x,y){let found=null,best=Infinity;for(const node of kg.visibleNodes){const p=world(node),d=Math.hypot(x-p.x,y-p.y),t=Math.max(7,radius(node)+5);if(d<t&&d<best){found=node;best=d}}return found}
  function point(event){const rect=kg.canvas.getBoundingClientRect();return{x:(event.clientX-rect.left)*(kg.width/rect.width),y:(event.clientY-rect.top)*(kg.height/rect.height)}}
  function inspect(node){kg.selected=node;if(!node)return;const related=kg.edges.filter(e=>e.from===node.id||e.to===node.id).slice(0,100).map(e=>({relation:e.relation,other:e.from===node.id?e.to:e.from}));el('omegaGraphInspectorTitle').textContent=node.label;el('omegaGraphInspectorKind').textContent=String(node.kind).toUpperCase();const clean={...node};for(const key of['x','y','vx','vy','activity','pinned'])delete clean[key];el('omegaGraphInspector').textContent=JSON.stringify({...clean,related},null,2)}
  function focus(node,zoom=1.65){if(!node)return;kg.zoom=Math.max(.22,Math.min(3.5,zoom));kg.panX=-node.x*kg.zoom;kg.panY=-node.y*kg.zoom;node.activity=Math.max(node.activity,1);inspect(node)}
  function searchFocus(){const q=String(el('omegaGraphSearch')?.value||'').trim().toLowerCase();if(!q)return;const node=kg.visibleNodes.find(n=>n.label.toLowerCase()===q||n.id.toLowerCase()===q)||kg.visibleNodes.find(n=>n.label.toLowerCase().includes(q)||n.id.toLowerCase().includes(q));if(node)focus(node,1.8);else el('omegaGraphInspector').textContent=`No visible node matched “${q}”.`}

  function bindCanvas(){const canvas=el('omegaGraphCanvas');if(!canvas||canvas.dataset.bound)return;canvas.dataset.bound='1';kg.canvas=canvas;kg.ctx=canvas.getContext('2d');canvas.addEventListener('pointerdown',event=>{const p=point(event),node=hit(p.x,p.y);canvas.setPointerCapture(event.pointerId);kg.pointerStart=p;if(node){kg.dragging=node;node.pinned=true;inspect(node)}else{kg.panning=true;kg.panStart={x:kg.panX,y:kg.panY}}});canvas.addEventListener('pointermove',event=>{const p=point(event);if(kg.dragging){const w=inverse(p.x,p.y);kg.dragging.x=w.x;kg.dragging.y=w.y;kg.dragging.vx=kg.dragging.vy=0;kg.temperature=Math.max(kg.temperature,.2)}else if(kg.panning&&kg.pointerStart){kg.panX=kg.panStart.x+p.x-kg.pointerStart.x;kg.panY=kg.panStart.y+p.y-kg.pointerStart.y}else kg.hovered=hit(p.x,p.y)});const end=()=>{kg.dragging=null;kg.panning=false;kg.pointerStart=null};canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);canvas.addEventListener('dblclick',event=>{const p=point(event),node=hit(p.x,p.y);if(node)focus(node,1.9)});canvas.addEventListener('wheel',event=>{event.preventDefault();const p=point(event),before=inverse(p.x,p.y),factor=event.deltaY<0?1.12:.89;kg.zoom=Math.max(.18,Math.min(4,kg.zoom*factor));kg.panX=p.x-kg.width/2-before.x*kg.zoom;kg.panY=p.y-kg.height/2-before.y*kg.zoom},{passive:false})}

  function heat(event){if(!event)return;const nodes=[];const family=event.family;const runtimeByFamily={wal:'runtime:wal',data:'runtime:current',engine:'runtime:tx',index:'runtime:index',history:'runtime:history',recovery:'runtime:savior'};if(runtimeByFamily[family]&&kg.nodeById.has(runtimeByFamily[family]))nodes.push(kg.nodeById.get(runtimeByFamily[family]));const source=String(event.source||'');const match=source.match(/(?:current|indexes|versions)\/([^/.]+)(?:\.json|\.jsonl)?/);if(match&&kg.nodeById.has(`collection:${match[1]}`))nodes.push(kg.nodeById.get(`collection:${match[1]}`));if(family==='recovery'&&kg.nodeById.has('recovery:last-savior'))nodes.push(kg.nodeById.get('recovery:last-savior'));for(const node of nodes)node.activity=Math.max(node.activity,1);kg.temperature=Math.max(kg.temperature,.18)}

  function bindControls(){el('omegaGraphLayer')?.addEventListener('change',()=>{filter();setTimeout(fit,30)});el('omegaGraphLayout')?.addEventListener('change',event=>{applyLayout(event.target.value,true);setTimeout(fit,40)});el('omegaGraphSimulation')?.addEventListener('change',event=>{kg.frozen=event.target.value==='freeze';if(!kg.frozen)kg.temperature=.5});el('omegaGraphFocus')?.addEventListener('click',searchFocus);el('omegaGraphSearch')?.addEventListener('keydown',event=>{if(event.key==='Enter')searchFocus()});el('omegaGraphRefresh')?.addEventListener('click',()=>rebuild().catch(console.error));window.addEventListener('resize',resize);document.addEventListener('observatory:event',event=>heat(event.detail));document.addEventListener('observatory:snapshot',()=>{if(el('view-knowledge')?.classList.contains('active'))rebuild().catch(console.error)})}

  async function boot(){injectNavAndView();bindCanvas();bindControls();await rebuild();cancelAnimationFrame(kg.frame);kg.frame=requestAnimationFrame(draw)}

  injectNavAndView();
  document.addEventListener('DOMContentLoaded',()=>boot().catch(error=>{console.error('OMEGA knowledge graph failed',error);if(el('omegaGraphState'))el('omegaGraphState').textContent='GRAPH ERROR'}));
})();
