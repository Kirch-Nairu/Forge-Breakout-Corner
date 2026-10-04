'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  schema: null,
  runtime: null,
  scale: 'demo',
  interpreterMode: 'simple',
  selectedCollection: null,
  events: [],
  eventSource: null
};

const titles = {
  seed: 'KIRION Engineering Seeder',
  data: 'Live Domain Data',
  query: 'Query Planner Lab',
  benchmark: 'Advanced Database Benchmark'
};

const profileKeyByCollection = {
  kirion_projects: 'projects',
  forge_work_packages: 'workPackages',
  forge_evidence: 'evidence',
  forge_ci_runs: 'ciRuns',
  earth_cases: 'earthCases',
  jupiter_assets: 'jupiterAssets',
  jupiter_findings: 'jupiterFindings',
  jupiter_events: 'jupiterEvents',
  mars_datasets: 'marsDatasets',
  mars_chunks: 'marsChunks',
  mars_evaluations: 'marsEvaluations',
  benchmark_records: 'benchmarkRecords'
};

function fmt(n) { return Number(n || 0).toLocaleString(); }
function ms(n) { return Number.isFinite(Number(n)) ? `${Number(n).toFixed(Number(n) < 10 ? 3 : 1)} ms` : '—'; }
function pretty(value) { return JSON.stringify(value, null, 2); }

function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function api(path, options = {}) {
  const opts = { ...options, headers: { ...(options.headers || {}) } };
  if (opts.method === 'POST') {
    opts.headers['Content-Type'] = 'application/json';
    opts.headers['X-Kirion-Workbench-Intent'] = 'write';
  }
  const response = await fetch(path, opts);
  const payload = await response.json().catch(() => ({ error: 'INVALID_JSON_RESPONSE' }));
  if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
  return payload;
}

function switchView(view) {
  $$('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
  $$('[data-view-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.viewPanel === view));
  $('#viewTitle').textContent = titles[view] || 'KIRION Data Workbench';
}

function renderDomains() {
  if (!state.schema) return;
  $('#domainGrid').innerHTML = state.schema.domains.map(domain => `
    <div class="domain-card" data-domain="${domain.id}">
      <span>${domain.role}</span>
      <strong>${domain.label}</strong>
      <p>${domain.summary}</p>
    </div>
  `).join('');
  $('#unresolvedDomains').innerHTML = state.schema.unresolvedDomains.map(domain => `
    <div class="unresolved-item"><strong>${domain.label}</strong> — ${domain.status}. ${domain.reason}</div>
  `).join('');
}

function scaleRows(scale) {
  const profile = state.schema?.scales?.[scale] || {};
  const override = $('#benchmarkRows')?.value;
  const out = { ...profile };
  if (override !== '' && override != null) out.benchmarkRecords = Math.max(0, Math.min(100000, Number(override)));
  return out;
}

function renderScales() {
  if (!state.schema) return;
  $('#scaleGrid').innerHTML = Object.entries(state.schema.scales).map(([key, spec]) => {
    const total = Object.entries(spec).filter(([, value]) => typeof value === 'number').reduce((sum, [, value]) => sum + value, 0);
    return `<button class="scale-card ${key === state.scale ? 'active' : ''}" data-scale="${key}"><strong>${spec.label}</strong><small>${fmt(total)} generated rows<br>${spec.description}</small></button>`;
  }).join('');
  $$('.scale-card').forEach(btn => btn.addEventListener('click', () => {
    state.scale = btn.dataset.scale;
    renderScales();
    renderSeedPlan();
  }));
}

function currentCollection(name) {
  return state.runtime?.collections?.find(item => item.name === name);
}

function renderSeedPlan() {
  if (!state.schema) return;
  const profile = scaleRows(state.scale);
  let total = 0;
  const rows = state.schema.collections
    .filter(spec => spec.name !== 'workbench_seed_runs')
    .map(spec => {
      const planned = Number(profile[profileKeyByCollection[spec.name]] || 0);
      total += planned;
      const current = currentCollection(spec.name);
      return `<tr><td>${spec.domain.toUpperCase()}</td><td><strong>${spec.name}</strong></td><td>${spec.purpose}</td><td>${fmt(planned)}</td><td>${fmt(current?.rows || 0)}</td></tr>`;
    });
  $('#seedPlanBody').innerHTML = rows.join('');
  $('#plannedRows').textContent = `${fmt(total)} planned`;
}

function renderRuntime() {
  const runtime = state.runtime;
  if (!runtime) return;
  $('#railTx').textContent = runtime.engine?.nextTx ?? '—';
  $('#railLsn').textContent = runtime.engine?.currentLsn ?? '—';
  $('#rowsChip').textContent = `${fmt(runtime.totals?.workbenchRows)} ROWS`;
  const busy = Boolean(runtime.busy);
  $('#busyChip').textContent = busy ? String(runtime.activeAction?.kind || 'BUSY') : 'IDLE';
  $('#busyChip').classList.toggle('chip-write', busy);
  $('#seedButton').disabled = busy;
  $('#insertButton').disabled = busy;
  $('#benchmarkButton').disabled = busy;
  renderSeedPlan();
  renderCollections();
  if (runtime.lastBenchmark) renderBenchmark(runtime.lastBenchmark, true);
}

function renderCollections() {
  if (!state.runtime) return;
  const list = state.runtime.collections || [];
  $('#collectionList').innerHTML = list.map(item => `
    <div class="collection-item ${state.selectedCollection === item.name ? 'active' : ''}" data-collection="${item.name}">
      <div><strong>${item.name}</strong><span>${item.domain.toUpperCase()} · ${item.present ? `rev ${item.revision} · tx ${item.lastTx}` : 'not created'}</span></div>
      <b>${fmt(item.rows)}</b>
    </div>
  `).join('');
  $$('.collection-item').forEach(item => item.addEventListener('click', () => loadSample(item.dataset.collection)));
}

async function loadSample(name) {
  state.selectedCollection = name;
  renderCollections();
  try {
    const result = await api(`/api/sample?collection=${encodeURIComponent(name)}&limit=50`);
    $('#sampleTitle').textContent = name;
    $('#sampleCount').textContent = `${fmt(result.rowCount)} ROWS`;
    $('#sampleJson').textContent = pretty(result.rows);
  } catch (error) {
    $('#sampleTitle').textContent = name;
    $('#sampleCount').textContent = 'ABSENT';
    $('#sampleJson').textContent = error.message;
  }
}

function renderRecordCollections() {
  if (!state.schema) return;
  $('#recordCollection').innerHTML = state.schema.collections
    .filter(item => item.name !== 'workbench_seed_runs')
    .map(item => `<option value="${item.name}" ${item.name === 'benchmark_records' ? 'selected' : ''}>${item.name}</option>`)
    .join('');
}

function targetPhase(event) {
  if (event.phase === 'abort') return 'transaction';
  if (event.phase === 'observe') return 'request';
  if (event.phase === 'query') return 'benchmark';
  return ['request','validate','schema','transaction','commit','benchmark'].includes(event.phase) ? event.phase : 'request';
}

function animateEvent(event) {
  const nodes = $$('.pipe-node');
  const target = nodes.findIndex(node => node.dataset.phase === targetPhase(event));
  const packetLayer = $('#packetLayer');
  if (target < 0 || !packetLayer || !nodes.length) return;

  nodes.forEach(node => node.classList.remove('active'));
  nodes[target].classList.add('active','pulse');
  setTimeout(() => nodes[target]?.classList.remove('pulse'), 750);

  const packet = document.createElement('div');
  packet.className = `flow-packet ${event.severity === 'error' ? 'error' : event.phase === 'commit' ? 'commit' : ''}`;
  packetLayer.appendChild(packet);
  const layerRect = packetLayer.getBoundingClientRect();
  const positions = nodes.slice(0, target + 1).map(node => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left - layerRect.left + rect.width / 2, top: rect.top - layerRect.top + rect.height / 2 };
  });
  if (!positions.length) return packet.remove();
  packet.style.left = `${positions[0].left}px`;
  packet.style.top = `${positions[0].top}px`;
  positions.slice(1).forEach((pos, i) => setTimeout(() => {
    packet.style.left = `${pos.left}px`;
    packet.style.top = `${pos.top}px`;
  }, 80 + i * 160));
  setTimeout(() => packet.remove(), Math.max(700, positions.length * 180 + 300));

  $('#lastEventType').textContent = event.type;
  $('#lastEventDomain').textContent = String(event.domain || '—').toUpperCase();
  $('#lastEventSeq').textContent = event.sequence;
  $('#lastEventPhase').textContent = String(event.phase || '—').toUpperCase();
}

function eventMessage(event) { return state.interpreterMode === 'engineer' ? event.engineer : event.simple; }

function renderEventFeed() {
  $('#eventFeed').innerHTML = state.events.slice(-80).reverse().map(event => `
    <div class="event-card" data-domain="${event.domain}" data-severity="${event.severity}">
      <div class="event-meta"><span>#${event.sequence} ${event.type}</span><span>${new Date(event.at).toLocaleTimeString()}</span></div>
      <strong>${String(event.domain || 'workbench').toUpperCase()} / ${String(event.phase || 'observe').toUpperCase()}</strong>
      <p>${escapeHtml(eventMessage(event))}</p>
    </div>
  `).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[ch]));
}

function acceptEvent(event) {
  if (!event || !event.sequence) return;
  if (state.events.some(item => item.sequence === event.sequence)) return;
  state.events.push(event);
  if (state.events.length > 160) state.events.splice(0, state.events.length - 160);
  animateEvent(event);
  $('#currentExplanation').innerHTML = `<span>${escapeHtml(event.type)}</span><p>${escapeHtml(eventMessage(event))}</p>`;
  renderEventFeed();
  if (event.type === 'BATCH_COMMIT' && event.details?.total) {
    $('#seedProgress').style.width = `${Math.min(100, Math.max(0, Number(event.details.inserted || 0) / Number(event.details.total) * 100))}%`;
    $('#seedStatus').textContent = `${event.details.collection}: ${fmt(event.details.inserted)} / ${fmt(event.details.total)} committed`;
  }
  if (event.type === 'SEED_COMPLETE') {
    $('#seedProgress').style.width = '100%';
    $('#seedStatus').textContent = `${fmt(event.details?.totalRows)} rows committed across KIRION domains.`;
    refreshState();
  }
  if (event.type === 'RECORD_COMMIT' || event.type === 'BENCHMARK_COMPLETE') refreshState();
}

function connectEvents() {
  state.eventSource?.close();
  const source = new EventSource('/api/events');
  state.eventSource = source;
  source.addEventListener('open', () => {
    $('#connectionDot').classList.add('online');
    $('#connectionLabel').textContent = 'live';
  });
  source.addEventListener('error', () => {
    $('#connectionDot').classList.remove('online');
    $('#connectionLabel').textContent = 'reconnecting';
  });
  source.addEventListener('workbench', message => {
    try { acceptEvent(JSON.parse(message.data)); } catch {}
  });
}

async function refreshState() {
  try {
    state.runtime = await api('/api/state');
    for (const event of state.runtime.recentEvents || []) acceptEvent(event);
    renderRuntime();
  } catch (error) {
    toast(`State refresh failed: ${error.message}`, true);
  }
}

async function runSeed() {
  const body = {
    scale: state.scale,
    seed: $('#seedText').value.trim() || 'KIRION-OMEGA',
    batchSize: Number($('#batchSize').value || 500)
  };
  if ($('#benchmarkRows').value !== '') body.benchmarkRecords = Number($('#benchmarkRows').value);
  $('#seedProgress').style.width = '1%';
  $('#seedStatus').textContent = 'Seeder request running…';
  try {
    const result = await api('/api/seed', { method: 'POST', body: JSON.stringify(body) });
    toast(`Seed complete: ${fmt(result.totalRows)} rows`);
    await refreshState();
  } catch (error) {
    toast(error.message, true);
    $('#seedStatus').textContent = `FAILED: ${error.message}`;
    await refreshState();
  }
}

async function insertRecord() {
  let row;
  try { row = JSON.parse($('#recordJson').value); }
  catch { return toast('Record JSON is invalid.', true); }
  try {
    const result = await api('/api/record', {
      method: 'POST',
      body: JSON.stringify({ collection: $('#recordCollection').value, row })
    });
    $('#insertResult').textContent = pretty(result);
    toast(`Committed tx ${result.tx}`);
    await refreshState();
  } catch (error) {
    $('#insertResult').textContent = error.message;
    toast(error.message, true);
  }
}

async function executeQuery() {
  let query;
  try { query = JSON.parse($('#queryJson').value); }
  catch { return toast('Query JSON is invalid.', true); }
  try {
    const result = await api('/api/query', { method: 'POST', body: JSON.stringify({ query }) });
    const access = result.explain?.access || {};
    $('#planAccess').textContent = access.type === 'index-scan' ? 'INDEX SCAN' : 'FULL SCAN';
    $('#planType').textContent = access.type || '—';
    $('#planIndex').textContent = access.index || 'none';
    $('#planExamined').textContent = fmt(result.explain?.examined);
    $('#planDuration').textContent = ms(result.explain?.durationMs);
    $('#planReason').textContent = access.reason || 'No planner reason returned.';
    $('#queryResult').textContent = pretty(result.rows);
    toast(`${access.type || 'query'} · ${fmt(result.rows.length)} rows`);
  } catch (error) {
    toast(error.message, true);
    $('#planAccess').textContent = 'QUERY FAILED';
    $('#planReason').textContent = error.message;
  }
}

function renderBenchmark(result, compact = false) {
  if (!result) return;
  $('#benchmarkHeadline').textContent = result.failed ? 'BENCHMARK DEGRADED' : 'BENCHMARK GREEN';
  $('#benchCases').textContent = result.total ?? '—';
  $('#benchPass').textContent = result.passed ?? '—';
  $('#benchFail').textContent = result.failed ?? '—';
  $('#benchTime').textContent = ms(result.totalDurationMs);
  if (!compact && Array.isArray(result.cases)) {
    $('#benchmarkCases').innerHTML = result.cases.map(item => `
      <div class="case-item ${item.skipped ? 'skip' : item.ok ? 'ok' : 'fail'}">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${item.skipped ? 'SKIP' : item.ok ? ms(item.durationMs) : 'FAIL'}</span>
      </div>
    `).join('');
  }
  const plans = result.plannerCases || [];
  $('#plannerTableBody').innerHTML = plans.length ? plans.map(item => `<tr><td>${item.name}</td><td>${item.access}</td><td>${item.index || '—'}</td><td>${fmt(item.cost)}</td><td>${fmt(item.examined)}</td><td>${Number(item.durationMs || 0).toFixed(3)}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">No planner cases recorded.</td></tr>';
}

async function runBenchmark() {
  const body = {
    advancedIndexes: $('#advancedIndexes').checked,
    durability: $('#durabilityBench').checked,
    compact: $('#compactBench').checked
  };
  try {
    const result = await api('/api/benchmark', { method: 'POST', body: JSON.stringify(body) });
    renderBenchmark(result);
    toast(`Benchmark: ${result.passed}/${result.total} passed`, Boolean(result.failed));
    await refreshState();
  } catch (error) {
    toast(error.message, true);
    $('#benchmarkHeadline').textContent = 'BENCHMARK FAILED';
  }
}

function bind() {
  $$('.nav-btn').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
  $$('.mode-btn').forEach(btn => btn.addEventListener('click', () => {
    state.interpreterMode = btn.dataset.mode;
    $$('.mode-btn').forEach(item => item.classList.toggle('active', item === btn));
    const last = state.events[state.events.length - 1];
    if (last) $('#currentExplanation').innerHTML = `<span>${escapeHtml(last.type)}</span><p>${escapeHtml(eventMessage(last))}</p>`;
    renderEventFeed();
  }));
  $('#benchmarkRows').addEventListener('input', renderSeedPlan);
  $('#seedButton').addEventListener('click', runSeed);
  $('#insertButton').addEventListener('click', insertRecord);
  $('#queryButton').addEventListener('click', executeQuery);
  $('#benchmarkButton').addEventListener('click', runBenchmark);
  $('#refreshData').addEventListener('click', refreshState);
}

async function bootstrap() {
  bind();
  try {
    const [schema, runtime] = await Promise.all([api('/api/schema'), api('/api/state')]);
    state.schema = schema;
    state.runtime = runtime;
    renderDomains();
    renderScales();
    renderRecordCollections();
    renderRuntime();
    for (const event of runtime.recentEvents || []) acceptEvent(event);
    connectEvents();
    setInterval(() => { if (!document.hidden) refreshState(); }, 5000);
  } catch (error) {
    toast(`Workbench bootstrap failed: ${error.message}`, true);
    $('#currentExplanation').innerHTML = `<span>BOOT FAILURE</span><p>${escapeHtml(error.message)}</p>`;
  }
}

bootstrap();
