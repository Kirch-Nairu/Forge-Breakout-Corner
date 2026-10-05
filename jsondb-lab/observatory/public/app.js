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
  history: 'OMEGA History',
  recovery: 'Recovery Constellation',
  authority: 'Authority Cockpit',
  files: 'Artifact Explorer',
  lab: 'Failure Lab'
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

const AUDIO_MODES = ['off', 'minimal', 'reactive', 'cinematic'];
let audioMode = localStorage.getItem('kirion-audio-mode') || 'reactive';
if (!AUDIO_MODES.includes(audioMode)) audioMode = 'reactive';
let audioVolume = Number(localStorage.getItem('kirion-audio-volume') || 0.16);
if (!Number.isFinite(audioVolume)) audioVolume = 0.16;
audioVolume = Math.min(0.5, Math.max(0.02, audioVolume));
let audioContext = null;
let audioMaster = null;
let ambientNodes = [];
let lastAudioAt = 0;

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

function ensureAudioContext() {
  if (audioContext) {
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    return audioContext;
  }
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  audioContext = new Ctor();
  audioMaster = audioContext.createGain();
  audioMaster.gain.value = audioVolume;
  audioMaster.connect(audioContext.destination);
  syncAmbientAudio();
  return audioContext;
}

function stopAmbientAudio() {
  for (const node of ambientNodes) {
    try { node.stop?.(); } catch {}
    try { node.disconnect?.(); } catch {}
  }
  ambientNodes = [];
}

function syncAmbientAudio() {
  stopAmbientAudio();
  if (audioMode !== 'cinematic' || !audioContext || !audioMaster) return;
  const low = audioContext.createOscillator();
  const lowGain = audioContext.createGain();
  const air = audioContext.createOscillator();
  const airGain = audioContext.createGain();
  low.type = 'sine';
  low.frequency.value = 43;
  lowGain.gain.value = 0.012;
  air.type = 'triangle';
  air.frequency.value = 86;
  airGain.gain.value = 0.005;
  low.connect(lowGain); lowGain.connect(audioMaster);
  air.connect(airGain); airGain.connect(audioMaster);
  low.start(); air.start();
  ambientNodes = [low, lowGain, air, airGain];
}

function audioTone({ frequency = 440, duration = 0.05, type = 'sine', gain = 0.06, slideTo = null, delay = 0 }) {
  if (audioMode === 'off') return;
  const ctx = ensureAudioContext();
  if (!ctx || !audioMaster) return;
  const start = ctx.currentTime + Math.max(0, delay);
  const oscillator = ctx.createOscillator();
  const localGain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(Math.max(20, frequency), start);
  if (slideTo != null) oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), start + duration);
  localGain.gain.setValueAtTime(0.0001, start);
  localGain.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), start + Math.min(0.014, duration / 3));
  localGain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(localGain);
  localGain.connect(audioMaster);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playObservationSound(event) {
  if (audioMode === 'off') return;
  const now = performance.now();
  const urgent = event.severity === 'error' || /(ERROR|FAIL|CORRUPT|DENY|PANIC)/i.test(String(event.type || ''));
  if (!urgent && now - lastAudioAt < (audioMode === 'minimal' ? 180 : 42)) return;
  lastAudioAt = now;
  const family = event.family || 'filesystem';

  if (urgent) {
    audioTone({ frequency: 205, duration: 0.13, type: 'sawtooth', gain: 0.07, slideTo: 118 });
    audioTone({ frequency: 148, duration: 0.17, type: 'sawtooth', gain: 0.05, delay: 0.07, slideTo: 82 });
    return;
  }

  if (audioMode === 'minimal') {
    if (family === 'recovery') return audioTone({ frequency: 196, duration: 0.09, type: 'sine', gain: 0.04, slideTo: 294 });
    if (family === 'history') return audioTone({ frequency: 330, duration: 0.07, type: 'triangle', gain: 0.035 });
    return audioTone({ frequency: 520, duration: 0.035, type: 'sine', gain: 0.025 });
  }

  if (family === 'wal') {
    audioTone({ frequency: 420, duration: 0.032, type: 'square', gain: 0.025, slideTo: 610 });
    return audioTone({ frequency: 820, duration: 0.024, type: 'sine', gain: 0.025, delay: 0.024 });
  }
  if (family === 'data' || family === 'engine') {
    audioTone({ frequency: 310, duration: 0.045, type: 'triangle', gain: 0.035, slideTo: 520 });
    return audioTone({ frequency: 620, duration: 0.035, type: 'sine', gain: 0.025, delay: 0.03 });
  }
  if (family === 'index') {
    audioTone({ frequency: 660, duration: 0.034, type: 'triangle', gain: 0.035 });
    return audioTone({ frequency: 880, duration: 0.034, type: 'sine', gain: 0.026, delay: 0.026 });
  }
  if (family === 'history') {
    audioTone({ frequency: 293.66, duration: 0.07, type: 'sine', gain: 0.04 });
    return audioTone({ frequency: 440, duration: 0.08, type: 'sine', gain: 0.034, delay: 0.045 });
  }
  if (family === 'recovery') {
    audioTone({ frequency: 146.83, duration: 0.11, type: 'triangle', gain: 0.045, slideTo: 220 });
    audioTone({ frequency: 293.66, duration: 0.12, type: 'sine', gain: 0.032, delay: 0.045 });
    return audioTone({ frequency: 440, duration: 0.13, type: 'sine', gain: 0.022, delay: 0.095 });
  }
  audioTone({ frequency: 460, duration: 0.035, type: 'sine', gain: 0.025 });
}

function renderAudioControl() {
  const button = el('omegaSoundMode');
  if (button) {
    button.dataset.mode = audioMode;
    button.textContent = `SOUND ${audioMode.toUpperCase()}`;
  }
  const slider = el('omegaSoundVolume');
  if (slider) slider.value = String(Math.round(audioVolume * 200));
}

function setAudioMode(next) {
  if (!AUDIO_MODES.includes(next)) return;
  audioMode = next;
  localStorage.setItem('kirion-audio-mode', audioMode);
  if (audioMode !== 'off') ensureAudioContext();
  syncAmbientAudio();
  renderAudioControl();
}

function setAudioVolume(next) {
  audioVolume = Math.min(0.5, Math.max(0.02, Number(next) || 0.16));
  localStorage.setItem('kirion-audio-volume', String(audioVolume));
  if (audioMaster && audioContext) audioMaster.gain.setTargetAtTime(audioVolume, audioContext.currentTime, 0.015);
}

function mountAudioControl() {
  const host = document.querySelector('.top-actions');
  if (!host || el('omegaSoundMode')) return;
  const wrap = document.createElement('div');
  wrap.className = 'omega-sound-control';
  const button = document.createElement('button');
  button.id = 'omegaSoundMode';
  button.className = 'ghost omega-sound-mode';
  button.type = 'button';
  button.addEventListener('click', () => setAudioMode(AUDIO_MODES[(AUDIO_MODES.indexOf(audioMode) + 1) % AUDIO_MODES.length]));
  const label = document.createElement('label');
  label.className = 'omega-sound-volume';
  const caption = document.createElement('span');
  caption.textContent = 'VOL';
  const slider = document.createElement('input');
  slider.id = 'omegaSoundVolume';
  slider.type = 'range';
  slider.min = '1';
  slider.max = '100';
  slider.addEventListener('input', event => setAudioVolume(Number(event.target.value) / 200));
  label.append(caption, slider);
  wrap.append(button, label);
  host.prepend(wrap);
  renderAudioControl();
  window.addEventListener('pointerdown', () => {
    if (audioMode !== 'off') ensureAudioContext();
  }, { once: true });
  window.addEventListener('storage', event => {
    if (event.key === 'kirion-audio-mode' && AUDIO_MODES.includes(event.newValue)) {
      audioMode = event.newValue;
      if (audioMode !== 'off') ensureAudioContext();
      syncAmbientAudio();
      renderAudioControl();
    }
    if (event.key === 'kirion-audio-volume') {
      const next = Number(event.newValue);
      if (Number.isFinite(next)) {
        audioVolume = Math.min(0.5, Math.max(0.02, next));
        if (audioMaster && audioContext) audioMaster.gain.setTargetAtTime(audioVolume, audioContext.currentTime, 0.015);
        renderAudioControl();
      }
    }
  });
}

class FlowVisualizer {
  constructor(stageId, canvasId) {
    this.stage = el(stageId);
    this.canvas = el(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.particles = [];
    this.edgeEnergy = new Map();
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
    setTimeout(() => node.classList.remove('pulse'), 720);
  }

  burstLabel(event, color) {
    const label = document.createElement('div');
    label.className = `flow-burst-label family-${event.family || 'filesystem'}`;
    label.textContent = `${String(event.family || 'filesystem').toUpperCase()} // ${event.type || 'OBSERVED'}`;
    label.style.setProperty('--burst-color', color);
    this.stage.appendChild(label);
    setTimeout(() => label.remove(), 1100);
  }

  emit(event) {
    const from = this.point(event.from);
    const to = this.point(event.to);
    if (!from || !to) return;
    const family = event.family || 'filesystem';
    const color = familyColors[family] || familyColors.filesystem;
    const intense = family === 'recovery' || family === 'history' || event.severity === 'error';
    const count = intense ? 11 : 7;
    const now = performance.now();
    for (let i = 0; i < count; i += 1) {
      this.particles.push({
        from, to, color,
        born: now + i * (intense ? 34 : 27),
        duration: 470 + Math.random() * 250,
        label: event.type || 'EVENT',
        size: i === 0 ? 4.8 : 1.8 + Math.random() * 2.4,
        wobble: (Math.random() - 0.5) * 8,
        alpha: i === 0 ? 1 : 0.5 + Math.random() * 0.38
      });
    }
    this.edgeEnergy.set(`${event.from}>${event.to}`, 1);
    this.pulse(event.from);
    setTimeout(() => this.pulse(event.to), 290);
    this.stage.classList.remove('flow-surge', 'family-wal', 'family-data', 'family-engine', 'family-index', 'family-history', 'family-recovery', 'family-filesystem');
    void this.stage.offsetWidth;
    this.stage.classList.add('flow-surge', `family-${family}`);
    setTimeout(() => this.stage.classList.remove('flow-surge', `family-${family}`), 920);
    this.burstLabel(event, color);
  }

  drawEdge(fromName, toName) {
    const a = this.point(fromName);
    const b = this.point(toName);
    if (!a || !b) return;
    const ctx = this.ctx;
    const dx = b.x - a.x;
    const key = `${fromName}>${toName}`;
    const energy = this.edgeEnergy.get(key) || 0;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(a.x + dx * .45, a.y, b.x - dx * .45, b.y, b.x, b.y);
    ctx.strokeStyle = energy > 0.02 ? `rgba(101,230,255,${0.2 + energy * 0.62})` : 'rgba(89,106,117,.24)';
    ctx.lineWidth = 1 + energy * 2.2;
    ctx.shadowColor = energy > 0.02 ? '#65e6ff' : 'transparent';
    ctx.shadowBlur = energy * 16;
    ctx.stroke();
    ctx.shadowBlur = 0;
    if (energy > 0.001) this.edgeEnergy.set(key, energy * 0.94);
  }

  particlePoint(p, t) {
    const eased = 1 - Math.pow(1 - t, 3);
    const dx = p.to.x - p.from.x;
    const c1 = { x: p.from.x + dx * .45, y: p.from.y + p.wobble };
    const c2 = { x: p.to.x - dx * .45, y: p.to.y - p.wobble };
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
      if (now < p.born) continue;
      const t = Math.max(0, Math.min(1, (now - p.born) / p.duration));
      const point = this.particlePoint(p, t);
      const ctx = this.ctx;
      ctx.globalAlpha = p.alpha * (1 - t * 0.2);
      ctx.beginPath();
      ctx.arc(point.x, point.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 18 + p.size * 2;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.beginPath();
      const trailT = Math.max(0, t - .11);
      const trail = this.particlePoint(p, trailT);
      ctx.moveTo(trail.x, trail.y);
      ctx.lineTo(point.x, point.y);
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = p.alpha * .42;
      ctx.lineWidth = Math.max(1, p.size * .7);
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
  const inspector = el('event-inspector');
  inspector.replaceChildren();
  const label = document.createElement('span');
  label.textContent = 'Latest event';
  const code = document.createElement('code');
  code.textContent = `${event.type} :: ${event.source || 'unknown'} :: ${event.mutation || 'observed'}`;
  inspector.append(label, code);
  inspector.classList.remove('live-impact');
  void inspector.offsetWidth;
  inspector.classList.add('live-impact');
}

function dramatizeObservation(event) {
  const family = event.family || 'filesystem';
  document.body.classList.remove('observatory-impact', 'impact-wal', 'impact-data', 'impact-engine', 'impact-index', 'impact-history', 'impact-recovery', 'impact-filesystem');
  void document.body.offsetWidth;
  document.body.classList.add('observatory-impact', `impact-${family}`);
  setTimeout(() => document.body.classList.remove('observatory-impact', `impact-${family}`), 720);
  playObservationSound(event);
}

function handleEvent(event) {
  addActivity(event);
  state.visualizers.forEach(v => v.emit(event));
  dramatizeObservation(event);
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

function init() {
  setupNavigation();
  mountAudioControl();
  state.visualizers.push(new FlowVisualizer('overview-flow-stage', 'overview-flow-canvas'));
  state.visualizers.push(new FlowVisualizer('flow-stage', 'flow-canvas'));
  el('refresh').addEventListener('click', loadSnapshot);
  loadSnapshot();
  connectEvents();
  setInterval(loadSnapshot, 12000);
}

document.addEventListener('DOMContentLoaded', init);
