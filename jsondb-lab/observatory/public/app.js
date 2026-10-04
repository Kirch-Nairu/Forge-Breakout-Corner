'use strict';

const state = {
  snapshot: null,
  events: [],
  eventSource: null,
  visualizers: []
};

const titles = {
  overview: 'Control Room',
  flow: 'Live Flow',
  wal: 'WAL Theater',
  data: 'Data Topology',
  index: 'Index & Sorting Lab',
  recovery: 'Recovery Constellation'
};

const familyColors = {
  wal: '#65e6ff',
  data: '#65e6ff',
  engine: '#65e6ff',
  index: '#6da7ff',
  history: '#f4c761',
  recovery: '#b48cff',
  filesystem: '#87929a'
};

function el(id) { return document.getElementById(id); }
function text(id, value) { const node = el(id); if (node) node.textContent = value == null ? '—' : String(value); }
function shortHash(value) { return value ? `${String(value).slice(0, 12)}…` : '—'; }
function timeOnly(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function setTone(node, value) {
  if (!node) return;
  node.classList.remove('warn', 'bad');
  const v = String(value || '').toLowerCase();
  if (/(panic|black|corrupt|invalid|failed|reject)/.test(v)) node.classList.add('bad');
  else if (/(read-only|degraded|warning|unknown|absent)/.test(v)) node.classList.add('warn');
}

class FlowVisualizer {
  constructor(stageId, canvasId) {
    this.stage = el(stageId);
    this.canvas = el(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.particles = [];
    this.edges = [
      ['app', 'tx'], ['tx', 'wal'], ['wal', 'current'],
      ['current', 'index'], ['current', 'history'], ['index', 'history'], ['history', 'savior']
    ];
    this.resize = this.resize.bind(this);
    this.tick = this.tick.bind(this);
    new ResizeObserver(this.resize).observe(this.stage);
    this.resize();
    requestAnimationFrame(this.tick);
  }

  resize() {
    const rect = this.stage.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  point(name) {
    const node = this.stage.querySelector(`[data-node="${name}"]`);
    if (!node) return null;
    const a = node.getBoundingClientRect();
    const b = this.stage.getBoundingClientRect();
    return { x: a.left - b.left + a.width / 2, y: a.top - b.top + a.height / 2 };
  }

  pulse(name) {
    const node = this.stage.querySelector(`[data-node="${name}"]`);
    if (!node) return;
    node.classList.remove('pulse');
    void node.offsetWidth;
    node.classList.add('pulse');
    setTimeout(() => node.classList.remove('pulse'), 520);
  }

  emit(event) {
    const from = this.point(event.from);
    const to = this.point(event.to);
    if (!from || !to) return;
    const color = familyColors[event.family] || familyColors.filesystem;
    this.particles.push({
      from, to, color,
      born: performance.now(),
      duration: 520 + Math.random() * 260,
      label: event.type || 'EVENT'
    });
    this.pulse(event.from);
    setTimeout(() => this.pulse(event.to), 340);
  }

  drawEdge(fromName, toName) {
    const a = this.point(fromName);
    const b = this.point(toName);
    if (!a || !b) return;
    const ctx = this.ctx;
    const dx = b.x - a.x;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(a.x + dx * .45, a.y, b.x - dx * .45, b.y, b.x, b.y);
    ctx.strokeStyle = 'rgba(89,106,117,.24)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  particlePoint(p, t) {
    const eased = 1 - Math.pow(1 - t, 3);
    const dx = p.to.x - p.from.x;
    const c1 = { x: p.from.x + dx * .45, y: p.from.y };
    const c2 = { x: p.to.x - dx * .45, y: p.to.y };
    const inv = 1 - eased;
    return {
      x: inv ** 3 * p.from.x + 3 * inv ** 2 * eased * c1.x + 3 * inv * eased ** 2 * c2.x + eased ** 3 * p.to.x,
      y: inv ** 3 * p.from.y + 3 * inv ** 2 * eased * c1.y + 3 * inv * eased ** 2 * c2.y + eased ** 3 * p.to.y
    };
  }

  tick(now) {
    const rect = this.stage.getBoundingClientRect();
    this.ctx.clearRect(0, 0, rect.width, rect.height);
    for (const edge of this.edges) this.drawEdge(...edge);
    this.particles = this.particles.filter(p => now - p.born < p.duration);
    for (const p of this.particles) {
      const t = Math.max(0, Math.min(1, (now - p.born) / p.duration));
      const point = this.particlePoint(p, t);
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 14;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.beginPath();
      const trailT = Math.max(0, t - .07);
      const trail = this.particlePoint(p, trailT);
      ctx.moveTo(trail.x, trail.y);
      ctx.lineTo(point.x, point.y);
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = .45;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    requestAnimationFrame(this.tick);
  }
}

function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(button => {
    button.addEventListener('click', () => {
      const view = button.dataset.view;
      document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x === button));
      document.querySelectorAll('.view').forEach(x => x.classList.toggle('active', x.id === `view-${view}`));
      text('view-title', titles[view] || 'OMEGA Observatory');
      setTimeout(() => state.visualizers.forEach(v => v.resize()), 20);
    });
  });
}

function connection(status, label) {
  const dot = el('connection-dot');
  dot.classList.remove('online', 'offline');
  if (status) dot.classList.add(status);
  text('connection-text', label);
}

async function loadSnapshot() {
  try {
    const response = await fetch('/api/snapshot', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    state.snapshot = snapshot;
    renderSnapshot(snapshot);
    document.dispatchEvent(new CustomEvent('observatory:snapshot', { detail: snapshot }));
    connection('online', 'OBSERVING');
  } catch (error) {
    connection('offline', 'SNAPSHOT ERROR');
    console.error(error);
  }
}

function renderSnapshot(s) {
  const engineLabel = s.engine?.present ? 'ONLINE' : 'ABSENT';
  text('engine-status', engineLabel);
  setTone(el('engine-status'), engineLabel);

  const saviorMode = String(s.savior?.mode || 'absent').toUpperCase();
  text('savior-mode', saviorMode);
  setTone(el('savior-mode'), saviorMode);

  const last = s.lastSavior?.present ? 'PRESENT' : 'ABSENT';
  text('last-savior-status', last);
  setTone(el('last-savior-status'), last);

  const contracts = s.recoveryContracts?.present ? (s.recoveryContracts.valid ? 'VALID' : 'VIOLATION') : 'ABSENT';
  text('contracts-status', contracts);
  setTone(el('contracts-status'), contracts);

  text('metric-collections', s.engine?.collections || 0);
  text('metric-rows', s.engine?.rows || 0);
  text('metric-lsn', s.engine?.currentLsn || 0);
  text('metric-firewall', s.firewall?.sequence || 0);

  renderCollections(s.collections || []);
  renderWal(s.wal || []);
  renderRecovery(s);
}

function renderCollections(collections) {
  const cards = el('collection-cards');
  cards.replaceChildren();
  if (!collections.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No collection state observed yet.';
    cards.appendChild(empty);
  }
  for (const c of collections) {
    const card = document.createElement('article');
    card.className = 'collection-card';
    const header = document.createElement('header');
    const title = document.createElement('h3');
    title.textContent = c.name;
    const rows = document.createElement('b');
    rows.textContent = c.rows;
    header.append(title, rows);
    const meta = document.createElement('p');
    meta.textContent = `rev ${c.revision} · ${c.indexes.length} indexes · ${c.updatedAt ? timeOnly(c.updatedAt) : 'no timestamp'}`;
    card.append(header, meta);
    cards.appendChild(card);
  }

  const body = el('data-table');
  body.replaceChildren();
  for (const c of collections) {
    const tr = document.createElement('tr');
    const values = [c.name, c.rows, c.revision, c.indexes.map(x => x.name).join(', ') || '—', c.updatedAt ? timeOnly(c.updatedAt) : '—'];
    values.forEach((value, index) => {
      const td = document.createElement('td');
      if (index === 0) {
        const strong = document.createElement('strong');
        strong.textContent = value;
        td.appendChild(strong);
      } else td.textContent = value;
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
}

function renderWal(entries) {
  text('wal-count', `${entries.length} SHOWN`);
  const list = el('wal-list');
  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No WAL entries observed.';
    list.appendChild(empty);
    return;
  }
  for (const entry of [...entries].reverse()) {
    const button = document.createElement('button');
    button.className = 'wal-item';
    const lsn = document.createElement('span');
    lsn.className = 'lsn';
    lsn.textContent = `#${entry.lsn ?? '?'}`;
    const type = document.createElement('span');
    type.className = 'type';
    type.textContent = entry.type || 'ENTRY';
    const at = document.createElement('span');
    at.className = 'at';
    at.textContent = timeOnly(entry.at);
    button.append(lsn, type, at);
    button.addEventListener('click', () => { el('wal-detail').textContent = JSON.stringify(entry, null, 2); });
    list.appendChild(button);
  }
}

function renderRecovery(s) {
  text('last-savior-id', s.lastSavior?.id || 'absent');
  text('recovery-savior-mode', s.savior?.mode || 'absent');
  text('recovery-contracts', s.recoveryContracts?.present ? `${s.recoveryContracts.valid ? 'VALID' : 'INVALID'} · ${s.recoveryContracts.contracts} contracts` : 'absent');
  text('recovery-firewall', s.firewall?.sequence || 0);
  text('recovery-archive-hash', shortHash(s.lastSavior?.archiveHash));
  const validity = s.lastSavior?.present ? 'ARCHIVE PRESENT' : 'NO ARCHIVE';
  text('recovery-validity', validity);
}

function addActivity(event) {
  state.events.unshift(event);
  state.events = state.events.slice(0, 80);
  text('event-count', `${state.events.length} EVENTS`);
  const list = el('activity-list');
  list.replaceChildren();
  for (const item of state.events.slice(0, 24)) {
    const row = document.createElement('article');
    row.className = 'activity-item';
    row.dataset.family = item.family || 'filesystem';
    const header = document.createElement('header');
    const title = document.createElement('b');
    title.textContent = item.type || 'OBSERVED EVENT';
    const time = document.createElement('time');
    time.textContent = timeOnly(item.time);
    header.append(title, time);
    const source = document.createElement('code');
    source.textContent = item.source || '—';
    row.append(header, source);
    list.appendChild(row);
  }
  text('event-inspector', '');
  const inspector = el('event-inspector');
  inspector.replaceChildren();
  const label = document.createElement('span');
  label.textContent = 'Latest event';
  const code = document.createElement('code');
  code.textContent = `${event.type} :: ${event.source || 'unknown'} :: ${event.mutation || 'observed'}`;
  inspector.append(label, code);
}

function handleEvent(event) {
  addActivity(event);
  state.visualizers.forEach(v => v.emit(event));
  document.dispatchEvent(new CustomEvent('observatory:event', { detail: event }));
  clearTimeout(handleEvent.refreshTimer);
  handleEvent.refreshTimer = setTimeout(loadSnapshot, 220);
}

function connectEvents() {
  if (state.eventSource) state.eventSource.close();
  const source = new EventSource('/api/events');
  state.eventSource = source;
  source.addEventListener('hello', () => connection('online', 'LIVE STREAM'));
  source.addEventListener('observation', message => {
    try { handleEvent(JSON.parse(message.data)); }
    catch (error) { console.error('Bad observation event', error); }
  });
  source.onerror = () => connection('offline', 'RECONNECTING');
  source.onopen = () => connection('online', 'LIVE STREAM');
}

function attachIndexLabStyles() {
  if (document.querySelector('link[href="/index-lab.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/index-lab.css';
  document.head.appendChild(link);
}

function init() {
  attachIndexLabStyles();
  setupNavigation();
  state.visualizers.push(new FlowVisualizer('overview-flow-stage', 'overview-flow-canvas'));
  state.visualizers.push(new FlowVisualizer('flow-stage', 'flow-canvas'));
  el('refresh').addEventListener('click', loadSnapshot);
  loadSnapshot();
  connectEvents();
  setInterval(loadSnapshot, 12000);
}

document.addEventListener('DOMContentLoaded', init);
