'use strict';

(function initSortLab(root) {
  const core = root.KirionSortCore;
  if (!core) throw new Error('KIRION Sort Lab requires KirionSortCore.');

  const lab = {
    source: 'synthetic',
    algorithm: 'quick',
    pattern: 'random',
    size: 48,
    opsPerSecond: 60,
    input: [],
    values: [],
    plan: null,
    cursor: 0,
    running: false,
    timer: null,
    startedAt: 0,
    elapsedMs: 0,
    comparisons: 0,
    swaps: 0,
    writes: 0,
    pivots: 0,
    active: [],
    marked: new Set(),
    markKind: null
  };

  const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n)));
  const fmt = n => Number(n || 0).toLocaleString();

  function injectNavigation() {
    const nav = document.querySelector('.nav');
    if (!nav || nav.querySelector('[data-view="sort"]')) return;
    const button = document.createElement('button');
    button.className = 'nav-btn';
    button.dataset.view = 'sort';
    button.innerHTML = '<span>05</span> Sort Lab';
    nav.appendChild(button);
    button.addEventListener('click', () => setTimeout(() => {
      const title = document.querySelector('#viewTitle');
      if (title) title.textContent = 'Data Motion Sort Lab';
      requestAnimationFrame(draw);
    }, 0));
  }

  function injectView() {
    const workspace = document.querySelector('.workspace');
    if (!workspace || workspace.querySelector('[data-view-panel="sort"]')) return;
    workspace.insertAdjacentHTML('beforeend', `
      <section class="view sort-lab-view" data-view-panel="sort">
        <div class="sort-grid">
          <article class="panel sort-controls-panel">
            <div class="panel-head">
              <div><span class="eyebrow">DATA MOTION LAB</span><h2>Sorting Algorithm Visualizer</h2></div>
              <span class="panel-badge">BROWSER MEMORY ONLY</span>
            </div>
            <p class="sort-truth">This visualizer can load real JSONDB values, but sorting happens only in browser memory. It never reorders persistent database rows.</p>

            <div class="sort-control-grid">
              <label><span>Algorithm</span><select id="sortAlgorithm"></select></label>
              <label><span>Source</span><select id="sortSource">
                <option value="synthetic">Synthetic array</option>
                <option value="db-priority">DB · benchmark_records.priority</option>
                <option value="db-numeric">DB · benchmark_records.numericValue</option>
              </select></label>
              <label><span>Pattern</span><select id="sortPattern">
                <option value="random">Random</option>
                <option value="reversed">Reversed</option>
                <option value="nearly">Nearly sorted</option>
                <option value="few">Few unique values</option>
              </select></label>
              <label><span>Array size <b id="sortSizeLabel">48</b></span><input id="sortSize" type="range" min="8" max="160" step="1" value="48"></label>
              <label><span>Speed <b id="sortSpeedLabel">60 ops/s</b></span><input id="sortSpeed" type="range" min="5" max="240" step="5" value="60"></label>
            </div>

            <div class="sort-actions">
              <button id="sortGenerate" class="ghost" type="button">GENERATE / LOAD</button>
              <button id="sortPlay" class="primary-action compact" type="button">PLAY</button>
              <button id="sortStep" class="ghost" type="button">STEP</button>
              <button id="sortReset" class="ghost" type="button">RESET</button>
            </div>

            <div class="sort-complexity" id="sortComplexity"></div>
          </article>

          <article class="panel sort-stage-panel">
            <div class="panel-head">
              <div><span class="eyebrow">CANVAS</span><h2 id="sortStageTitle">Quick Sort</h2></div>
              <span class="panel-badge" id="sortStateBadge">READY</span>
            </div>
            <div class="sort-canvas-wrap">
              <canvas id="sortCanvas" aria-label="Sorting algorithm visualization"></canvas>
            </div>
            <div class="sort-stats">
              <div><span>STEP</span><strong id="sortStepStat">0 / 0</strong></div>
              <div><span>COMPARE</span><strong id="sortCompareStat">0</strong></div>
              <div><span>SWAPS</span><strong id="sortSwapStat">0</strong></div>
              <div><span>WRITES</span><strong id="sortWriteStat">0</strong></div>
              <div><span>ELAPSED</span><strong id="sortElapsedStat">0 ms</strong></div>
            </div>
          </article>

          <article class="panel sort-interpreter-panel">
            <div class="panel-head"><div><span class="eyebrow">SORT INTERPRETER</span><h2 id="sortOpTitle">Waiting for motion</h2></div><span class="panel-badge" id="sortSourceBadge">SYNTHETIC</span></div>
            <p id="sortSimpleExplain" class="sort-explain-primary">Generate a dataset, then play or step through the algorithm.</p>
            <pre id="sortEngineerExplain" class="sort-engineer">No operation selected.</pre>
          </article>

          <article class="panel sort-plan-panel">
            <div class="panel-head"><div><span class="eyebrow">PLAN</span><h2>Operation plan</h2></div><span class="panel-badge">EXPLAIN-ONLY</span></div>
            <div class="sort-plan-bars">
              <div><span>Planning</span><strong id="sortPlanningMs">—</strong></div>
              <div><span>Operations</span><strong id="sortPlanOps">—</strong></div>
              <div><span>Stable</span><strong id="sortStable">—</strong></div>
              <div><span>Worst-case</span><strong id="sortWorst">—</strong></div>
            </div>
            <p class="muted">The operation sequence is computed from a copy of the input. Playback then applies compare/swap/write operations to another browser-memory copy so you can watch every mutation.</p>
          </article>
        </div>
      </section>`);
  }

  function populateAlgorithms() {
    const select = document.querySelector('#sortAlgorithm');
    if (!select) return;
    select.innerHTML = core.algorithms.map(name => `<option value="${name}">${core.metadata[name].label}</option>`).join('');
    select.value = lab.algorithm;
  }

  function seededRandomArray(size, pattern) {
    const values = Array.from({ length: size }, () => 5 + Math.round(Math.random() * 95));
    if (pattern === 'reversed') return values.sort((a, b) => b - a);
    if (pattern === 'nearly') {
      values.sort((a, b) => a - b);
      const disruptions = Math.max(1, Math.round(size * 0.08));
      for (let n = 0; n < disruptions; n++) {
        const a = Math.floor(Math.random() * size);
        const b = Math.floor(Math.random() * size);
        [values[a], values[b]] = [values[b], values[a]];
      }
      return values;
    }
    if (pattern === 'few') {
      const pool = [12, 28, 46, 63, 82, 95];
      return Array.from({ length: size }, () => pool[Math.floor(Math.random() * pool.length)]);
    }
    return values;
  }

  async function loadInput() {
    pause();
    lab.source = document.querySelector('#sortSource').value;
    lab.pattern = document.querySelector('#sortPattern').value;
    lab.size = Number(document.querySelector('#sortSize').value);
    let values;
    if (lab.source === 'synthetic') {
      values = seededRandomArray(lab.size, lab.pattern);
    } else {
      const response = await fetch('/api/sample?collection=benchmark_records&limit=200');
      if (!response.ok) throw new Error('Seed benchmark_records first, then load database-backed sort data.');
      const payload = await response.json();
      const field = lab.source === 'db-priority' ? 'priority' : 'numericValue';
      values = (payload.rows || []).map(row => Number(row[field])).filter(Number.isFinite).slice(-lab.size);
      if (values.length < 2) throw new Error(`Not enough numeric ${field} values are available.`);
    }
    lab.input = [...values];
    buildPlan();
    updateSourceBadge();
  }

  function buildPlan() {
    pause();
    lab.algorithm = document.querySelector('#sortAlgorithm').value;
    lab.plan = core.createPlan(lab.input, lab.algorithm);
    lab.values = [...lab.input];
    lab.cursor = 0;
    lab.elapsedMs = 0;
    lab.comparisons = 0;
    lab.swaps = 0;
    lab.writes = 0;
    lab.pivots = 0;
    lab.active = [];
    lab.marked = new Set();
    lab.markKind = null;
    const meta = lab.plan.metadata;
    document.querySelector('#sortStageTitle').textContent = meta.label;
    document.querySelector('#sortComplexity').innerHTML = `
      <span><b>BEST</b>${meta.best}</span>
      <span><b>AVG</b>${meta.average}</span>
      <span><b>WORST</b>${meta.worst}</span>
      <span><b>SPACE</b>${meta.space}</span>`;
    document.querySelector('#sortPlanningMs').textContent = `${lab.plan.planningMs.toFixed(3)} ms`;
    document.querySelector('#sortPlanOps').textContent = fmt(lab.plan.operations.length);
    document.querySelector('#sortStable').textContent = meta.stable ? 'YES' : 'NO';
    document.querySelector('#sortWorst').textContent = meta.worst;
    document.querySelector('#sortStateBadge').textContent = 'READY';
    explain(null);
    updateStats();
    draw();
  }

  function updateSourceBadge() {
    const badge = document.querySelector('#sortSourceBadge');
    if (!badge) return;
    badge.textContent = lab.source === 'synthetic' ? 'SYNTHETIC' : 'REAL DB VALUES';
  }

  function normalizeValue(value) {
    if (!lab.values.length) return 0.5;
    const min = Math.min(...lab.values);
    const max = Math.max(...lab.values);
    return max === min ? 0.5 : (value - min) / (max - min);
  }

  function applyOperation(op) {
    lab.active = [];
    if (op.type === 'compare') {
      lab.comparisons++;
      lab.active = [op.i, op.j];
      root.KirionAudio?.play('compare', normalizeValue(Math.max(op.a ?? 0, op.b ?? 0)));
    } else if (op.type === 'swap') {
      lab.swaps++;
      lab.active = [op.i, op.j];
      [lab.values[op.i], lab.values[op.j]] = [lab.values[op.j], lab.values[op.i]];
      root.KirionAudio?.play('swap', normalizeValue(Math.max(lab.values[op.i], lab.values[op.j])));
    } else if (op.type === 'write') {
      lab.writes++;
      lab.active = [op.i];
      lab.values[op.i] = op.value;
      root.KirionAudio?.play('write', normalizeValue(op.value));
    } else if (op.type === 'pivot') {
      lab.pivots++;
      lab.active = [op.i];
      root.KirionAudio?.play('pivot', normalizeValue(op.value));
    } else if (op.type === 'mark') {
      lab.markKind = op.kind;
      if (op.kind === 'sorted-all') lab.marked = new Set(op.indices || []);
      else if (op.kind === 'sorted' || op.kind === 'pivot-placed') for (const index of op.indices || []) lab.marked.add(index);
      lab.active = op.indices || [];
    }
    explain(op);
    updateStats();
    draw();
  }

  function step() {
    if (!lab.plan || lab.cursor >= lab.plan.operations.length) {
      finish();
      return false;
    }
    const op = lab.plan.operations[lab.cursor++];
    applyOperation(op);
    return true;
  }

  function loop() {
    if (!lab.running) return;
    if (!step()) return;
    const delay = Math.max(4, 1000 / lab.opsPerSecond);
    lab.timer = setTimeout(loop, delay);
  }

  function play() {
    if (!lab.plan) return;
    if (lab.cursor >= lab.plan.operations.length) reset();
    if (lab.running) return pause();
    lab.running = true;
    lab.startedAt = performance.now() - lab.elapsedMs;
    document.querySelector('#sortPlay').textContent = 'PAUSE';
    document.querySelector('#sortStateBadge').textContent = 'RUNNING';
    root.KirionAudio?.play('start');
    loop();
  }

  function pause() {
    if (lab.timer) clearTimeout(lab.timer);
    lab.timer = null;
    if (lab.running) lab.elapsedMs = performance.now() - lab.startedAt;
    lab.running = false;
    const playButton = document.querySelector('#sortPlay');
    if (playButton) playButton.textContent = 'PLAY';
    const badge = document.querySelector('#sortStateBadge');
    if (badge && lab.plan && lab.cursor < lab.plan.operations.length) badge.textContent = lab.cursor ? 'PAUSED' : 'READY';
    updateStats();
  }

  function finish() {
    pause();
    lab.elapsedMs = performance.now() - lab.startedAt;
    lab.marked = new Set(lab.values.map((_, i) => i));
    document.querySelector('#sortStateBadge').textContent = 'SORTED';
    document.querySelector('#sortOpTitle').textContent = 'SORT COMPLETE';
    document.querySelector('#sortSimpleExplain').textContent = `${lab.plan.metadata.label} finished. Every displayed mutation happened only in browser memory.`;
    document.querySelector('#sortEngineerExplain').textContent = `algorithm=${lab.algorithm}\noperations=${lab.plan.operations.length}\ncomparisons=${lab.comparisons}\nswaps=${lab.swaps}\nwrites=${lab.writes}\nsource=${lab.source}\npersistentDatabaseMutation=false`;
    root.KirionAudio?.play('complete');
    updateStats();
    draw();
  }

  function reset() {
    pause();
    if (!lab.input.length) return;
    buildPlan();
  }

  function explain(op) {
    const title = document.querySelector('#sortOpTitle');
    const simple = document.querySelector('#sortSimpleExplain');
    const engineer = document.querySelector('#sortEngineerExplain');
    if (!title || !simple || !engineer) return;
    if (!op) {
      title.textContent = 'READY';
      simple.textContent = `Ready to replay ${lab.plan?.metadata?.label || 'the selected algorithm'} over ${lab.values.length} values.`;
      engineer.textContent = `source=${lab.source}\narrayLength=${lab.values.length}\npersistentDatabaseMutation=false`;
      return;
    }
    if (op.type === 'compare') {
      title.textContent = `COMPARE [${op.i}] ↔ [${op.j}]`;
      simple.textContent = `Comparing ${Number(op.a).toFixed(2)} with ${Number(op.b).toFixed(2)} to decide their ordering.`;
    } else if (op.type === 'swap') {
      title.textContent = `SWAP [${op.i}] ↔ [${op.j}]`;
      simple.textContent = `Those two values are out of the algorithm's desired local order, so their positions are exchanged.`;
    } else if (op.type === 'write') {
      title.textContent = `WRITE [${op.i}]`;
      simple.textContent = `Merge Sort is writing ${Number(op.value).toFixed(2)} back into position ${op.i}.`;
    } else if (op.type === 'pivot') {
      title.textContent = `PIVOT [${op.i}]`;
      simple.textContent = `Quick Sort selected ${Number(op.value).toFixed(2)} as the partition pivot for this range.`;
    } else {
      title.textContent = String(op.kind || op.type).toUpperCase();
      simple.textContent = `The algorithm marked ${op.indices?.length || 0} position(s) as ${op.kind || 'part of the current phase'}.`;
    }
    engineer.textContent = JSON.stringify({
      step: lab.cursor,
      operation: op,
      comparisons: lab.comparisons,
      swaps: lab.swaps,
      writes: lab.writes,
      persistentDatabaseMutation: false
    }, null, 2);

    const globalInterpreter = document.querySelector('#currentExplanation');
    if (globalInterpreter) globalInterpreter.innerHTML = `<span>SORT_${String(op.type).toUpperCase()}</span><p>${simple.textContent}</p>`;
  }

  function updateStats() {
    if (!lab.plan) return;
    if (lab.running) lab.elapsedMs = performance.now() - lab.startedAt;
    document.querySelector('#sortStepStat').textContent = `${fmt(lab.cursor)} / ${fmt(lab.plan.operations.length)}`;
    document.querySelector('#sortCompareStat').textContent = fmt(lab.comparisons);
    document.querySelector('#sortSwapStat').textContent = fmt(lab.swaps);
    document.querySelector('#sortWriteStat').textContent = fmt(lab.writes);
    document.querySelector('#sortElapsedStat').textContent = `${lab.elapsedMs.toFixed(0)} ms`;
  }

  function draw() {
    const canvas = document.querySelector('#sortCanvas');
    if (!canvas || !lab.values.length) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, root.devicePixelRatio || 1);
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(300, Math.floor(rect.height || 380));
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#080d12';
    ctx.fillRect(0, 0, width, height);

    const values = lab.values;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const gap = values.length > 90 ? 1 : 2;
    const barWidth = Math.max(1, (width - gap * (values.length - 1)) / values.length);
    const usableHeight = height - 34;

    values.forEach((value, index) => {
      const normalized = (value - min) / range;
      const barHeight = 8 + normalized * (usableHeight - 8);
      const x = index * (barWidth + gap);
      const y = usableHeight - barHeight + 10;
      const active = lab.active.includes(index);
      const marked = lab.marked.has(index);
      if (marked) ctx.fillStyle = '#65e69b';
      else if (active) ctx.fillStyle = '#ffbd63';
      else ctx.fillStyle = `hsl(${196 + normalized * 24} 75% ${42 + normalized * 18}%)`;
      ctx.fillRect(x, y, barWidth, barHeight);
    });

    ctx.fillStyle = '#536877';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(`n=${values.length}  min=${min.toFixed(2)}  max=${max.toFixed(2)}  source=${lab.source}`, 8, height - 8);
  }

  function bind() {
    document.querySelector('#sortAlgorithm').addEventListener('change', () => { lab.algorithm = document.querySelector('#sortAlgorithm').value; if (lab.input.length) buildPlan(); });
    document.querySelector('#sortSource').addEventListener('change', () => { lab.source = document.querySelector('#sortSource').value; updateSourceBadge(); });
    document.querySelector('#sortPattern').addEventListener('change', () => { lab.pattern = document.querySelector('#sortPattern').value; });
    document.querySelector('#sortSize').addEventListener('input', event => {
      lab.size = Number(event.target.value);
      document.querySelector('#sortSizeLabel').textContent = String(lab.size);
    });
    document.querySelector('#sortSpeed').addEventListener('input', event => {
      lab.opsPerSecond = Number(event.target.value);
      document.querySelector('#sortSpeedLabel').textContent = `${lab.opsPerSecond} ops/s`;
    });
    document.querySelector('#sortGenerate').addEventListener('click', async () => {
      try { await loadInput(); }
      catch (error) {
        document.querySelector('#sortOpTitle').textContent = 'LOAD FAILED';
        document.querySelector('#sortSimpleExplain').textContent = error.message;
        root.KirionAudio?.play('error');
      }
    });
    document.querySelector('#sortPlay').addEventListener('click', play);
    document.querySelector('#sortStep').addEventListener('click', () => { pause(); step(); });
    document.querySelector('#sortReset').addEventListener('click', reset);
    new ResizeObserver(() => draw()).observe(document.querySelector('#sortCanvas').parentElement);
  }

  injectNavigation();
  injectView();
  populateAlgorithms();
  bind();
  loadInput().catch(() => {
    lab.input = seededRandomArray(lab.size, lab.pattern);
    buildPlan();
  });
  root.KirionSortLab = { lab, play, pause, step, reset, loadInput, draw };
})(window);
