'use strict';

(function bootstrapWorkbenchExtensions() {
  function addStyle(href) {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) return resolve();
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      document.head.appendChild(script);
    });
  }

  function initGraphLab(root) {
    if (root.KirionGraphLab) return;

    const graph = {
      schema: null,
      runtime: null,
      nodes: [],
      edges: [],
      nodeById: new Map(),
      canvas: null,
      ctx: null,
      width: 1000,
      height: 620,
      dpr: 1,
      zoom: 1,
      panX: 0,
      panY: 0,
      hovered: null,
      selected: null,
      dragging: null,
      panning: false,
      pointerStart: null,
      panStart: null,
      temperature: 1,
      frozen: false,
      scope: 'records',
      layout: 'force',
      domain: 'all',
      recordLimit: 180,
      visibleNodes: [],
      visibleEdges: [],
      source: null,
      autoFocus: true,
      frame: 0,
      lastEventSeq: 0
    };

    const COLORS = {
      forge: '#a78bfa', earth: '#69e6a0', jupiter: '#ff727b', mars: '#62d9ff', benchmark: '#ffbd63',
      runtime: '#ecf4f8', collection: '#72a7ff', index: '#5cd6ff', record: '#8fa5b4', unresolved: '#756b57'
    };

    const esc = value => String(value ?? '').replace(/[&<>\"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;' }[ch]));
    const fmt = value => Number(value || 0).toLocaleString();

    function injectNavigation() {
      const nav = document.querySelector('.nav');
      if (!nav || nav.querySelector('[data-view="graph"]')) return;
      const button = document.createElement('button');
      button.className = 'nav-btn';
      button.dataset.view = 'graph';
      button.innerHTML = '<span>06</span> Graph Lab';
      nav.appendChild(button);
      button.addEventListener('click', () => setTimeout(() => {
        const title = document.querySelector('#viewTitle');
        if (title) title.textContent = 'KIRION Knowledge Graph';
        resize();
        graph.temperature = Math.max(graph.temperature, 0.3);
      }, 0));
    }

    function injectView() {
      const workspace = document.querySelector('.workspace');
      if (!workspace || workspace.querySelector('[data-view-panel="graph"]')) return;
      workspace.insertAdjacentHTML('beforeend', `
        <section class="view" data-view-panel="graph">
          <div class="view-grid">
            <article class="panel wide">
              <div class="panel-head">
                <div><span class="eyebrow">KNOWLEDGE TOPOLOGY</span><h2>Obsidian-style KIRION Graph Lab</h2></div>
                <span class="panel-badge" id="graphStateBadge">LIVE READ MODEL</span>
              </div>
              <p class="muted">Force-directed graph reconstructed from the bounded Workbench schema, current collection state and sampled canonical rows. Drag nodes, pan empty space, wheel to zoom, double-click to focus. Live Workbench events heat the affected domain/collection/runtime nodes.</p>
              <div class="form-grid">
                <label><span>Scope</span><select id="graphScope"><option value="topology">Topology only</option><option value="records" selected>Topology + records</option><option value="deep">Deep records</option></select></label>
                <label><span>Layout</span><select id="graphLayout"><option value="force">Force / Obsidian</option><option value="domain">Domain clusters</option><option value="radial">Radial architecture</option></select></label>
                <label><span>Domain</span><select id="graphDomain"><option value="all">All domains</option><option value="forge">KIRION FORGE</option><option value="earth">KIRION EARTH</option><option value="jupiter">KIRION JUPITER</option><option value="mars">KIRION MARS</option><option value="benchmark">Benchmark</option><option value="runtime">Engine runtime</option></select></label>
              </div>
              <div class="form-grid">
                <label><span>Search node</span><input id="graphSearch" autocomplete="off" placeholder="project, collection, asset, dataset…"></label>
                <label><span>Live behavior</span><select id="graphAutoFocus"><option value="on" selected>Auto-focus hot nodes</option><option value="off">Pulse only</option></select></label>
                <label><span>Simulation</span><select id="graphSimulation"><option value="live">Physics live</option><option value="freeze">Freeze positions</option></select></label>
              </div>
              <div class="sort-actions">
                <button class="ghost" id="graphRefresh" type="button">REBUILD FROM JSONDB</button>
                <button class="ghost" id="graphFit" type="button">FIT GRAPH</button>
                <button class="ghost" id="graphFocus" type="button">FOCUS SEARCH</button>
                <button class="ghost" id="graphRelease" type="button">RELEASE PINS</button>
              </div>
              <div class="planner-metrics">
                <div><span>NODES</span><strong id="graphNodeCount">0</strong></div>
                <div><span>EDGES</span><strong id="graphEdgeCount">0</strong></div>
                <div><span>HOT</span><strong id="graphHotCount">0</strong></div>
                <div><span>ZOOM</span><strong id="graphZoom">100%</strong></div>
              </div>
              <canvas id="graphCanvas" width="1200" height="620" tabindex="0" aria-label="Interactive KIRION knowledge graph"></canvas>
            </article>

            <article class="panel">
              <div class="panel-head"><div><span class="eyebrow">NODE INSPECTOR</span><h2 id="graphInspectorTitle">Select a node</h2></div><span class="panel-badge" id="graphInspectorKind">—</span></div>
              <p class="explain-copy" id="graphInspectorSummary">Click any graph node to inspect its canonical role, weight, domain and relationships.</p>
              <pre class="json-view short" id="graphInspectorJson">{}</pre>
            </article>

            <article class="panel">
              <div class="panel-head"><div><span class="eyebrow">GRAPH LEGEND</span><h2>Relationship semantics</h2></div><span class="panel-badge">NO FAKE TRACE</span></div>
              <div class="case-list" id="graphLegend">
                <div class="case-item ok"><strong>DOMAIN → COLLECTION</strong><span>OWNS</span></div>
                <div class="case-item ok"><strong>COLLECTION → INDEX</strong><span>INDEXED BY</span></div>
                <div class="case-item ok"><strong>COLLECTION → COLLECTION</strong><span>FOREIGN KEY</span></div>
                <div class="case-item ok"><strong>RECORD → COLLECTION</strong><span>ROW IN</span></div>
                <div class="case-item ok"><strong>RECORD → RECORD</strong><span>REFERENCES</span></div>
                <div class="case-item ok"><strong>ENGINE → WAL → CURRENT</strong><span>ARCHITECTURE</span></div>
              </div>
              <p class="muted">Live event glow is observation telemetry. It does not claim the force layout or node position is an engine execution trace.</p>
            </article>
          </div>
        </section>`);
    }

    function domainNodeId(domain) { return `domain:${domain}`; }
    function collectionNodeId(name) { return `collection:${name}`; }
    function recordNodeId(collection, id) { return `record:${collection}:${id}`; }

    function nodeLabel(row, collection) {
      const fields = ['name','title','code','hostname','projectKey','workPackageKey','findingKey','eventKey','datasetKey','chunkKey','evaluationKey','caseKey','benchKey','runKey','id'];
      for (const field of fields) if (row?.[field] != null) return String(row[field]).slice(0, 42);
      return `${collection} row`;
    }

    function addNode(input) {
      if (graph.nodeById.has(input.id)) return graph.nodeById.get(input.id);
      const angle = Math.random() * Math.PI * 2;
      const radius = 80 + Math.random() * 220;
      const node = {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0, vy: 0, pinned: false, activity: 0,
        ...input
      };
      graph.nodes.push(node);
      graph.nodeById.set(node.id, node);
      return node;
    }

    function addEdge(from, to, relation, weight = 1) {
      if (!graph.nodeById.has(from) || !graph.nodeById.has(to)) return;
      const id = `${from}|${relation}|${to}`;
      if (graph.edges.some(edge => edge.id === id)) return;
      graph.edges.push({ id, from, to, relation, weight });
    }

    async function fetchJson(url) {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return response.json();
    }

    async function loadGraph() {
      const badge = document.querySelector('#graphStateBadge');
      if (badge) badge.textContent = 'REBUILDING';
      const [schema, runtime] = await Promise.all([fetchJson('/api/schema'), fetchJson('/api/state')]);
      graph.schema = schema;
      graph.runtime = runtime;
      graph.nodes = [];
      graph.edges = [];
      graph.nodeById = new Map();

      for (const domain of schema.domains || []) addNode({
        id: domainNodeId(domain.id), label: domain.label, kind: 'domain', domain: domain.id,
        summary: domain.summary, role: domain.role, weight: 24
      });
      if (!(schema.domains || []).some(item => item.id === 'benchmark')) addNode({ id: domainNodeId('benchmark'), label: 'DATABASE BENCHMARK', kind: 'domain', domain: 'benchmark', summary: 'Purpose-built query/index/history benchmark domain.', weight: 20 });
      for (const unresolved of schema.unresolvedDomains || []) addNode({ id: `unresolved:${unresolved.id}`, label: unresolved.label, kind: 'unresolved', domain: 'unresolved', summary: unresolved.reason, status: unresolved.status, weight: 8 });

      const runtimeNodes = [
        ['app','APPLICATION'],['tx','TRANSACTION'],['wal','WAL'],['current','CURRENT STATE'],['indexes','INDEXES'],['history','VERSION HISTORY'],['savior','RECOVERY / SAVIOR']
      ];
      for (const [id,label] of runtimeNodes) addNode({ id:`runtime:${id}`, label, kind:'runtime', domain:'runtime', weight: id === 'current' ? 22 : 16 });
      addEdge('runtime:app','runtime:tx','intent'); addEdge('runtime:tx','runtime:wal','append'); addEdge('runtime:wal','runtime:current','materialize'); addEdge('runtime:current','runtime:indexes','derive'); addEdge('runtime:current','runtime:history','version'); addEdge('runtime:history','runtime:savior','recover');

      const runtimeMap = new Map((runtime.collections || []).map(item => [item.name, item]));
      for (const spec of schema.collections || []) {
        const live = runtimeMap.get(spec.name) || {};
        addNode({
          id: collectionNodeId(spec.name), label: spec.name, kind:'collection', domain: spec.domain || 'benchmark',
          purpose: spec.purpose, rows: live.rows || 0, revision: live.revision || 0, lastTx: live.lastTx || 0,
          weight: 10 + Math.min(26, Math.log2(2 + Number(live.rows || 0)) * 2), indexes: spec.indexes || [], foreignKeys: spec.foreignKeys || []
        });
        if (graph.nodeById.has(domainNodeId(spec.domain))) addEdge(domainNodeId(spec.domain), collectionNodeId(spec.name), 'owns', 1.5);
        addEdge('runtime:current', collectionNodeId(spec.name), 'stores', .45);
        for (const index of spec.indexes || []) {
          const indexId = `index:${spec.name}:${index.name}`;
          addNode({ id:indexId, label:index.name, kind:'index', domain:spec.domain || 'benchmark', fields:index.fields || [], unique:Boolean(index.unique), weight:7 });
          addEdge(collectionNodeId(spec.name), indexId, 'indexed-by', .8);
          addEdge('runtime:indexes', indexId, 'persists', .35);
        }
      }
      for (const spec of schema.collections || []) for (const fk of spec.foreignKeys || []) {
        const target = fk.references?.collection;
        if (target && graph.nodeById.has(collectionNodeId(target))) addEdge(collectionNodeId(spec.name), collectionNodeId(target), `fk:${fk.field}`, 1.3);
      }

      const scope = document.querySelector('#graphScope')?.value || graph.scope;
      graph.scope = scope;
      const limit = scope === 'deep' ? 360 : scope === 'records' ? 180 : 0;
      graph.recordLimit = limit;
      if (limit) await addRecordLayer(schema, runtime, limit);

      applyLayout(document.querySelector('#graphLayout')?.value || 'force', true);
      filterGraph();
      fitGraph();
      if (badge) badge.textContent = 'LIVE READ MODEL';
      root.KirionAudio?.play('query');
    }

    async function addRecordLayer(schema, runtime, globalLimit) {
      const present = (runtime.collections || []).filter(item => item.present && item.rows > 0 && (schema.collections || []).some(spec => spec.name === item.name));
      if (!present.length) return;
      const perCollection = Math.max(4, Math.min(40, Math.ceil(globalLimit / present.length)));
      const samples = await Promise.all(present.map(async item => {
        try { return [item.name, await fetchJson(`/api/sample?collection=${encodeURIComponent(item.name)}&limit=${perCollection}`)]; }
        catch { return [item.name, null]; }
      }));
      const specMap = new Map((schema.collections || []).map(spec => [spec.name, spec]));
      const recordIndex = new Map();
      let added = 0;
      for (const [collection, payload] of samples) {
        if (!payload) continue;
        const spec = specMap.get(collection);
        for (const row of payload.rows || []) {
          if (added >= globalLimit) break;
          const rawId = row.id ?? row.projectKey ?? row.runKey ?? `${collection}-${added}`;
          const id = recordNodeId(collection, rawId);
          addNode({
            id, label: nodeLabel(row, collection), kind:'record', domain:spec?.domain || 'benchmark', collection,
            rawId:String(rawId), row, weight:4.5
          });
          addEdge(id, collectionNodeId(collection), 'row-in', .22);
          recordIndex.set(`${collection}:${rawId}`, id);
          added++;
        }
      }
      for (const node of graph.nodes.filter(item => item.kind === 'record')) {
        const spec = specMap.get(node.collection);
        for (const fk of spec?.foreignKeys || []) {
          const value = node.row?.[fk.field];
          const targetCollection = fk.references?.collection;
          if (value == null || !targetCollection) continue;
          const targetRecord = recordIndex.get(`${targetCollection}:${value}`);
          if (targetRecord) addEdge(node.id, targetRecord, `ref:${fk.field}`, .7);
          else if (graph.nodeById.has(collectionNodeId(targetCollection))) addEdge(node.id, collectionNodeId(targetCollection), `ref:${fk.field}`, .16);
        }
      }
    }

    function applyLayout(layout, hard = false) {
      graph.layout = layout;
      const nodes = graph.nodes;
      const domainOrder = ['forge','earth','jupiter','mars','benchmark','runtime','unresolved'];
      if (layout === 'radial') {
        const majors = nodes.filter(n => n.kind === 'domain' || n.kind === 'runtime');
        majors.forEach((node, i) => {
          const a = Math.PI * 2 * i / Math.max(1, majors.length);
          node.x = Math.cos(a) * 240; node.y = Math.sin(a) * 240; node.vx = node.vy = 0;
        });
        for (const node of nodes.filter(n => !majors.includes(n))) {
          const idx = Math.max(0, domainOrder.indexOf(node.domain));
          const a = Math.PI * 2 * idx / domainOrder.length + (Math.random() - .5) * .65;
          const r = node.kind === 'record' ? 410 + Math.random() * 120 : 320 + Math.random() * 70;
          node.x = Math.cos(a) * r; node.y = Math.sin(a) * r;
        }
      } else if (layout === 'domain') {
        for (const node of nodes) {
          const idx = Math.max(0, domainOrder.indexOf(node.domain));
          const col = idx % 3, row = Math.floor(idx / 3);
          const cx = (col - 1) * 350, cy = (row - 1) * 300;
          node.x = cx + (Math.random() - .5) * (node.kind === 'record' ? 230 : 130);
          node.y = cy + (Math.random() - .5) * (node.kind === 'record' ? 220 : 120);
          node.vx = node.vy = 0;
        }
      } else if (hard) {
        for (const node of nodes) {
          const idx = Math.max(0, domainOrder.indexOf(node.domain));
          const a = Math.PI * 2 * idx / domainOrder.length + (Math.random() - .5) * .8;
          const r = 120 + Math.random() * 350;
          node.x = Math.cos(a) * r; node.y = Math.sin(a) * r; node.vx = node.vy = 0;
        }
      }
      graph.temperature = 1;
    }

    function filterGraph() {
      const domain = document.querySelector('#graphDomain')?.value || 'all';
      graph.domain = domain;
      if (domain === 'all') graph.visibleNodes = [...graph.nodes];
      else graph.visibleNodes = graph.nodes.filter(node => node.domain === domain || (node.kind === 'collection' && node.domain === domain));
      const ids = new Set(graph.visibleNodes.map(node => node.id));
      graph.visibleEdges = graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
      document.querySelector('#graphNodeCount').textContent = fmt(graph.visibleNodes.length);
      document.querySelector('#graphEdgeCount').textContent = fmt(graph.visibleEdges.length);
      graph.temperature = Math.max(graph.temperature, .45);
    }

    function clusterCenter(domain) {
      const centers = {
        forge:[-320,-220], earth:[0,-300], jupiter:[330,-210], mars:[330,220], benchmark:[0,300], runtime:[-330,220], unresolved:[0,0]
      };
      return centers[domain] || [0,0];
    }

    function simulate() {
      if (graph.frozen || !graph.visibleNodes.length) return;
      const nodes = graph.visibleNodes;
      const temp = Math.max(.04, graph.temperature);
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d2 = dx * dx + dy * dy + 30;
          if (d2 > 150000) continue;
          const force = Math.min(1.8, 8500 / d2) * temp;
          const inv = 1 / Math.sqrt(d2);
          dx *= inv; dy *= inv;
          if (!a.pinned) { a.vx -= dx * force; a.vy -= dy * force; }
          if (!b.pinned) { b.vx += dx * force; b.vy += dy * force; }
        }
      }
      for (const edge of graph.visibleEdges) {
        const a = graph.nodeById.get(edge.from), b = graph.nodeById.get(edge.to);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const desired = edge.relation === 'row-in' ? 72 : edge.relation.startsWith('ref:') ? 95 : 125;
        const force = (dist - desired) * .0038 * Math.min(2, edge.weight || 1) * temp;
        const nx = dx / dist, ny = dy / dist;
        if (!a.pinned) { a.vx += nx * force; a.vy += ny * force; }
        if (!b.pinned) { b.vx -= nx * force; b.vy -= ny * force; }
      }
      for (const node of nodes) {
        const [cx,cy] = clusterCenter(node.domain);
        const gravity = graph.layout === 'domain' ? .0018 : graph.layout === 'radial' ? .00035 : .0008;
        if (!node.pinned) {
          node.vx += (cx - node.x) * gravity * temp;
          node.vy += (cy - node.y) * gravity * temp;
          node.vx *= .87; node.vy *= .87;
          const speed = Math.hypot(node.vx, node.vy);
          if (speed > 12) { node.vx = node.vx / speed * 12; node.vy = node.vy / speed * 12; }
          node.x += node.vx; node.y += node.vy;
        }
        node.activity *= .972;
        if (node.activity < .01) node.activity = 0;
      }
      graph.temperature *= .993;
    }

    function resize() {
      const canvas = document.querySelector('#graphCanvas');
      if (!canvas) return;
      const parent = canvas.parentElement;
      const width = Math.max(500, Math.floor(parent.clientWidth - 30));
      const height = Math.max(480, Math.min(720, Math.floor(window.innerHeight * .63)));
      const dpr = Math.min(2, root.devicePixelRatio || 1);
      if (graph.width === width && graph.height === height && graph.dpr === dpr) return;
      graph.width = width; graph.height = height; graph.dpr = dpr;
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      canvas.setAttribute('width', String(Math.round(width * dpr)));
      canvas.setAttribute('height', String(Math.round(height * dpr)));
      graph.canvas = canvas; graph.ctx = canvas.getContext('2d');
      graph.ctx.setTransform(dpr,0,0,dpr,0,0);
    }

    function worldToScreen(node) { return { x: node.x * graph.zoom + graph.panX + graph.width / 2, y: node.y * graph.zoom + graph.panY + graph.height / 2 }; }
    function screenToWorld(x,y) { return { x:(x - graph.panX - graph.width/2)/graph.zoom, y:(y - graph.panY - graph.height/2)/graph.zoom }; }
    function radius(node) {
      if (node.kind === 'domain') return 11 + Math.min(8, node.weight / 4);
      if (node.kind === 'runtime') return 10;
      if (node.kind === 'collection') return 7 + Math.min(8, Math.log2(2 + Number(node.rows || 0)));
      if (node.kind === 'index') return 5.5;
      if (node.kind === 'unresolved') return 7;
      return 3.3;
    }

    function nodeColor(node) { return COLORS[node.domain] || COLORS[node.kind] || COLORS.record; }

    function draw() {
      resize();
      const ctx = graph.ctx;
      if (!ctx) return;
      simulate();
      ctx.clearRect(0,0,graph.width,graph.height);
      ctx.fillStyle = '#070b0f'; ctx.fillRect(0,0,graph.width,graph.height);

      ctx.save();
      ctx.globalAlpha = .11;
      ctx.strokeStyle = '#62d9ff'; ctx.lineWidth = .5;
      const spacing = 48;
      for (let x = ((graph.panX + graph.width/2) % spacing + spacing) % spacing; x < graph.width; x += spacing) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,graph.height); ctx.stroke(); }
      for (let y = ((graph.panY + graph.height/2) % spacing + spacing) % spacing; y < graph.height; y += spacing) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(graph.width,y); ctx.stroke(); }
      ctx.restore();

      for (const edge of graph.visibleEdges) {
        const a = graph.nodeById.get(edge.from), b = graph.nodeById.get(edge.to);
        if (!a || !b) continue;
        const p1 = worldToScreen(a), p2 = worldToScreen(b);
        const hot = Math.max(a.activity,b.activity);
        ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y);
        ctx.strokeStyle = hot > .08 ? colorAlpha(nodeColor(a), .25 + Math.min(.55,hot*.55)) : 'rgba(100,125,143,.13)';
        ctx.lineWidth = hot > .08 ? 1.2 + hot * 1.6 : edge.relation === 'row-in' ? .45 : .75;
        if (edge.relation.startsWith('fk:') || edge.relation.startsWith('ref:')) ctx.setLineDash([4,5]); else ctx.setLineDash([]);
        ctx.stroke(); ctx.setLineDash([]);
        if (hot > .2) {
          const t = (performance.now() / 650 + hashCode(edge.id) % 100 / 100) % 1;
          const x = p1.x + (p2.x-p1.x)*t, y = p1.y + (p2.y-p1.y)*t;
          ctx.beginPath(); ctx.arc(x,y,2.2,0,Math.PI*2); ctx.fillStyle=nodeColor(a); ctx.shadowColor=nodeColor(a); ctx.shadowBlur=12; ctx.fill(); ctx.shadowBlur=0;
        }
      }

      let hotCount = 0;
      for (const node of graph.visibleNodes) {
        const p = worldToScreen(node); const r = radius(node) * Math.min(1.45, Math.max(.7, graph.zoom ** .22));
        const color = nodeColor(node); const hot = node.activity;
        if (hot > .08) hotCount++;
        if (hot > .04 || node === graph.selected || node === graph.hovered) {
          ctx.beginPath(); ctx.arc(p.x,p.y,r + 8 + hot*14,0,Math.PI*2);
          ctx.fillStyle = colorAlpha(color, .04 + hot*.08); ctx.fill();
        }
        ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2);
        ctx.fillStyle = node.kind === 'record' ? colorAlpha(color,.62) : color;
        ctx.shadowColor = color; ctx.shadowBlur = hot > .04 ? 10 + hot*22 : node.kind === 'domain' ? 9 : 2; ctx.fill(); ctx.shadowBlur=0;
        if (node === graph.selected) { ctx.beginPath(); ctx.arc(p.x,p.y,r+4,0,Math.PI*2); ctx.strokeStyle='#fff'; ctx.lineWidth=1.3; ctx.stroke(); }
        if (node.pinned) { ctx.beginPath(); ctx.arc(p.x,p.y,r+2,0,Math.PI*2); ctx.strokeStyle='#ffbd63'; ctx.lineWidth=.8; ctx.stroke(); }
        const important = node.kind === 'domain' || node.kind === 'collection' || node.kind === 'runtime' || node === graph.hovered || node === graph.selected || (graph.zoom > 1.3 && node.kind === 'index');
        if (important) {
          ctx.font = `${node.kind === 'domain' ? 700 : 600} ${node.kind === 'domain' ? 10 : 8}px ui-monospace,Consolas,monospace`;
          ctx.fillStyle = node === graph.selected ? '#fff' : 'rgba(220,233,241,.78)';
          ctx.textAlign='center'; ctx.textBaseline='top';
          ctx.fillText(node.label.slice(0,34), p.x, p.y+r+5);
        }
      }
      document.querySelector('#graphHotCount').textContent = String(hotCount);
      document.querySelector('#graphZoom').textContent = `${Math.round(graph.zoom*100)}%`;
      graph.frame = requestAnimationFrame(draw);
    }

    function colorAlpha(hex, alpha) {
      const h = String(hex).replace('#','');
      const n = parseInt(h.length === 3 ? h.split('').map(x=>x+x).join('') : h,16);
      return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${alpha})`;
    }
    function hashCode(value) { let h=0; for (const ch of String(value)) h=((h<<5)-h+ch.charCodeAt(0))|0; return Math.abs(h); }

    function hitTest(x,y) {
      let hit=null, best=Infinity;
      for (const node of graph.visibleNodes) {
        const p=worldToScreen(node); const d=Math.hypot(x-p.x,y-p.y); const threshold=Math.max(7,radius(node)+5);
        if (d<threshold && d<best) { hit=node; best=d; }
      }
      return hit;
    }

    function eventPoint(event) {
      const rect=graph.canvas.getBoundingClientRect();
      const sx=graph.width/rect.width, sy=graph.height/rect.height;
      return {x:(event.clientX-rect.left)*sx,y:(event.clientY-rect.top)*sy};
    }

    function inspect(node) {
      graph.selected=node;
      if (!node) return;
      const related=graph.edges.filter(edge=>edge.from===node.id||edge.to===node.id).slice(0,80).map(edge=>({relation:edge.relation,other:edge.from===node.id?edge.to:edge.from}));
      document.querySelector('#graphInspectorTitle').textContent=node.label;
      document.querySelector('#graphInspectorKind').textContent=String(node.kind).toUpperCase();
      document.querySelector('#graphInspectorSummary').textContent=`${String(node.domain||'unknown').toUpperCase()} · ${related.length} visible/known relationships · ${node.pinned?'PINNED':'FREE'}${node.rows!=null?` · ${fmt(node.rows)} rows`:''}`;
      const clean={...node}; delete clean.vx; delete clean.vy; delete clean.x; delete clean.y; delete clean.activity; delete clean.pinned;
      document.querySelector('#graphInspectorJson').textContent=JSON.stringify({...clean,related},null,2);
      root.KirionAudio?.play('query',.45);
    }

    function focusNode(node, zoom=1.55) {
      if (!node) return;
      graph.zoom=Math.max(.25,Math.min(3.5,zoom));
      graph.panX=-node.x*graph.zoom;
      graph.panY=-node.y*graph.zoom;
      inspect(node); node.activity=Math.max(node.activity,1);
    }

    function fitGraph() {
      const nodes=graph.visibleNodes;
      if (!nodes.length) return;
      const xs=nodes.map(n=>n.x), ys=nodes.map(n=>n.y);
      const minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
      const spanX=Math.max(100,maxX-minX), spanY=Math.max(100,maxY-minY);
      graph.zoom=Math.max(.22,Math.min(1.35,Math.min((graph.width-100)/spanX,(graph.height-100)/spanY)));
      graph.panX=-(minX+maxX)/2*graph.zoom; graph.panY=-(minY+maxY)/2*graph.zoom;
    }

    function bindCanvas() {
      const canvas=document.querySelector('#graphCanvas');
      if (!canvas||canvas.dataset.bound) return;
      canvas.dataset.bound='1'; graph.canvas=canvas; graph.ctx=canvas.getContext('2d');
      canvas.addEventListener('pointerdown',event=>{
        const p=eventPoint(event), node=hitTest(p.x,p.y); canvas.setPointerCapture(event.pointerId);
        graph.pointerStart=p;
        if (node) { graph.dragging=node; node.pinned=true; inspect(node); }
        else { graph.panning=true; graph.panStart={x:graph.panX,y:graph.panY}; }
      });
      canvas.addEventListener('pointermove',event=>{
        const p=eventPoint(event);
        if (graph.dragging) { const w=screenToWorld(p.x,p.y); graph.dragging.x=w.x; graph.dragging.y=w.y; graph.dragging.vx=graph.dragging.vy=0; graph.temperature=Math.max(graph.temperature,.2); }
        else if (graph.panning&&graph.pointerStart) { graph.panX=graph.panStart.x+(p.x-graph.pointerStart.x); graph.panY=graph.panStart.y+(p.y-graph.pointerStart.y); }
        else { graph.hovered=hitTest(p.x,p.y); canvas.setAttribute('aria-label',graph.hovered?`KIRION graph: ${graph.hovered.label}`:'Interactive KIRION knowledge graph'); }
      });
      const end=()=>{graph.dragging=null;graph.panning=false;graph.pointerStart=null;};
      canvas.addEventListener('pointerup',end); canvas.addEventListener('pointercancel',end);
      canvas.addEventListener('dblclick',event=>{const p=eventPoint(event),node=hitTest(p.x,p.y);if(node)focusNode(node,1.8);});
      canvas.addEventListener('wheel',event=>{
        event.preventDefault(); const p=eventPoint(event); const before=screenToWorld(p.x,p.y); const factor=event.deltaY<0?1.12:.89;
        graph.zoom=Math.max(.18,Math.min(4,graph.zoom*factor));
        graph.panX=p.x-graph.width/2-before.x*graph.zoom; graph.panY=p.y-graph.height/2-before.y*graph.zoom;
      },{passive:false});
    }

    function focusSearch() {
      const q=String(document.querySelector('#graphSearch')?.value||'').trim().toLowerCase();
      if (!q) return;
      const exact=graph.visibleNodes.find(node=>node.label.toLowerCase()===q||node.id.toLowerCase()===q);
      const node=exact||graph.visibleNodes.find(node=>node.label.toLowerCase().includes(q)||node.id.toLowerCase().includes(q));
      if (node) focusNode(node,1.8);
      else document.querySelector('#graphInspectorSummary').textContent=`No visible node matched “${q}”. Try All domains or a deeper scope.`;
    }

    function heatEvent(event) {
      if (!event) return;
      graph.lastEventSeq=Math.max(graph.lastEventSeq,Number(event.sequence||0));
      const targets=[];
      const domain=event.domain;
      if (domain&&graph.nodeById.has(domainNodeId(domain))) targets.push(graph.nodeById.get(domainNodeId(domain)));
      const collection=event.details?.collection;
      if (collection&&graph.nodeById.has(collectionNodeId(collection))) targets.push(graph.nodeById.get(collectionNodeId(collection)));
      const phase=String(event.phase||'');
      const runtimeId=phase==='request'?'runtime:app':phase==='validate'||phase==='schema'?'runtime:tx':phase==='transaction'?'runtime:wal':phase==='commit'?'runtime:current':phase==='benchmark'||phase==='query'?'runtime:indexes':null;
      if (runtimeId&&graph.nodeById.has(runtimeId)) targets.push(graph.nodeById.get(runtimeId));
      if (/SEED_COMPLETE|BENCHMARK_COMPLETE/.test(event.type||'')&&graph.nodeById.has('runtime:history')) targets.push(graph.nodeById.get('runtime:history'));
      for (const node of targets) node.activity=Math.max(node.activity,1);
      graph.temperature=Math.max(graph.temperature,.18);
      if (graph.autoFocus&&targets.length&&document.querySelector('[data-view-panel="graph"]')?.classList.contains('active')) {
        const target=targets.find(node=>node.kind==='collection')||targets[0];
        const desiredZoom=Math.max(graph.zoom,.85);
        graph.zoom=desiredZoom; graph.panX=-target.x*graph.zoom; graph.panY=-target.y*graph.zoom;
      }
    }

    function connectEvents() {
      if (graph.source) return;
      const source=new EventSource('/api/events'); graph.source=source;
      source.addEventListener('workbench',message=>{try{const event=JSON.parse(message.data);if(Number(event.sequence||0)>graph.lastEventSeq)heatEvent(event);}catch{}});
    }

    function bindControls() {
      document.querySelector('#graphScope')?.addEventListener('change',()=>loadGraph().catch(showError));
      document.querySelector('#graphLayout')?.addEventListener('change',event=>{applyLayout(event.target.value,true);setTimeout(fitGraph,50);});
      document.querySelector('#graphDomain')?.addEventListener('change',()=>{filterGraph();setTimeout(fitGraph,30);});
      document.querySelector('#graphAutoFocus')?.addEventListener('change',event=>{graph.autoFocus=event.target.value==='on';});
      document.querySelector('#graphSimulation')?.addEventListener('change',event=>{graph.frozen=event.target.value==='freeze';if(!graph.frozen)graph.temperature=.5;});
      document.querySelector('#graphRefresh')?.addEventListener('click',()=>loadGraph().catch(showError));
      document.querySelector('#graphFit')?.addEventListener('click',fitGraph);
      document.querySelector('#graphFocus')?.addEventListener('click',focusSearch);
      document.querySelector('#graphSearch')?.addEventListener('keydown',event=>{if(event.key==='Enter')focusSearch();});
      document.querySelector('#graphRelease')?.addEventListener('click',()=>{for(const node of graph.nodes)node.pinned=false;graph.temperature=.7;});
      root.addEventListener('resize',()=>{resize();});
    }

    function showError(error) {
      const badge=document.querySelector('#graphStateBadge'); if(badge)badge.textContent='GRAPH ERROR';
      const summary=document.querySelector('#graphInspectorSummary'); if(summary)summary.textContent=String(error.message||error);
      console.error('KIRION Graph Lab:',error);
      root.KirionAudio?.play('error');
    }

    async function boot() {
      injectNavigation(); injectView(); bindCanvas(); bindControls(); connectEvents();
      await loadGraph();
      cancelAnimationFrame(graph.frame); graph.frame=requestAnimationFrame(draw);
    }

    root.KirionGraphLab={boot,refresh:loadGraph,state:graph,focus:focusSearch};
    boot().catch(showError);
  }

  async function main() {
    addStyle('/sort-lab.css');
    await loadScript('/sort-core.js');
    await loadScript('/audio.js');
    await loadScript('/sort-lab.js');
    initGraphLab(window);
    await loadScript('/core-app.js');
  }

  main().catch(error => {
    console.error('KIRION Workbench extension bootstrap failed:', error);
    const host = document.querySelector('#currentExplanation');
    if (host) host.innerHTML = `<span>EXTENSION BOOT FAILURE</span><p>${String(error.message || error)}</p>`;
  });
})();
