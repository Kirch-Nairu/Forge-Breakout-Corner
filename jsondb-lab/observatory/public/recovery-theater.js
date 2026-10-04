'use strict';

(() => {
  const state = { graph: null, authority: null };
  const roleColors = {
    reconstructive: '#6da7ff',
    historical: '#f4c761',
    corroborative: '#f29b52',
    'authority-evidence': '#b48cff',
    authority: '#b48cff',
    'authority-gate': '#b48cff',
    transport: '#68c6a3',
    interpretation: '#8fd3ff',
    bootstrap: '#8fd3ff',
    orchestrator: '#ffffff',
    constitution: '#d7dce1',
    'policy-enforcement': '#ff6b6b',
    planning: '#8fd3ff',
    adjudication: '#e48cff',
    analysis: '#9da7b1'
  };

  function el(id) { return document.getElementById(id); }
  function short(value, n = 18) { const s = String(value || '—'); return s.length > n ? `${s.slice(0, n)}…` : s; }

  async function getJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
    return response.json();
  }

  function svg(tag, attrs = {}) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }

  function renderGraph(graph) {
    const host = el('recovery-graph');
    if (!host) return;
    host.replaceChildren();
    const width = Math.max(860, host.clientWidth || 860);
    const height = 560;
    const canvas = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'recovery-svg', role: 'img', 'aria-label': 'JSONDB recovery dependency graph' });
    const center = { x: width / 2, y: height / 2 };
    const nodes = graph.nodes || [];
    const source = new Map(nodes.map(n => [n.id, n]));
    const rings = new Map();
    const roles = [...new Set(nodes.map(n => n.kind || 'other'))];
    roles.forEach((role, i) => rings.set(role, 130 + (i % 4) * 48));
    const placed = new Map();

    nodes.forEach((node, i) => {
      if (node.id === 'last-savior') return placed.set(node.id, center);
      const radius = rings.get(node.kind || 'other') || 250;
      const angle = (Math.PI * 2 * i / Math.max(1, nodes.length - 1)) - Math.PI / 2;
      placed.set(node.id, {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * Math.min(radius, 215)
      });
    });

    for (const edge of graph.edges || []) {
      const a = placed.get(edge.from), b = placed.get(edge.to);
      if (!a || !b) continue;
      const line = svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'recovery-edge' });
      line.dataset.from = edge.from;
      line.dataset.to = edge.to;
      canvas.appendChild(line);
    }

    for (const node of nodes) {
      const p = placed.get(node.id); if (!p) continue;
      const group = svg('g', { class: `recovery-node ${node.present ? 'present' : 'absent'}`, tabindex: '0' });
      group.dataset.id = node.id;
      const circle = svg('circle', { cx: p.x, cy: p.y, r: node.id === 'last-savior' ? 42 : 27, fill: roleColors[node.kind] || '#7f8a92' });
      const label = svg('text', { x: p.x, y: p.y + 4, 'text-anchor': 'middle', class: 'recovery-label' });
      label.textContent = short(node.label || node.id, node.id === 'last-savior' ? 15 : 11).toUpperCase();
      group.append(circle, label);
      group.addEventListener('click', () => showNode(node));
      group.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') showNode(node); });
      canvas.appendChild(group);
    }
    host.appendChild(canvas);
  }

  function showNode(node) {
    const box = el('recovery-node-detail');
    if (!box) return;
    box.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = node.label || node.id;
    const badge = document.createElement('span');
    badge.className = 'node-role-badge';
    badge.textContent = node.kind || 'unknown';
    badge.style.setProperty('--role-color', roleColors[node.kind] || '#7f8a92');
    const status = document.createElement('p');
    status.textContent = node.present ? 'PRESENT IN CURRENT EVIDENCE' : 'NOT PRESENT / NOT YET CREATED';
    const facts = document.createElement('dl');
    const rows = [
      ['Reconstructs', (node.reconstructs || []).join(', ') || 'nothing'],
      ['Corroborates', (node.corroborates || []).join(', ') || 'nothing'],
      ['May nominate', node.mayNominate ? 'yes' : 'no'],
      ['May authorize', node.mayAuthorize ? 'yes' : 'no'],
      ['May promote canonical', node.mayPromoteCanonical ? 'YES' : 'NO']
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = String(v);
      facts.append(dt, dd);
    }
    box.append(title, badge, status, facts);
  }

  function renderAuthority(data) {
    const list = el('firewall-ledger');
    if (!list) return;
    list.replaceChildren();
    const decisions = [...(data.decisions || [])].reverse();
    for (const d of decisions.slice(0, 60)) {
      const row = document.createElement('article');
      row.className = `firewall-row ${d.allowed ? 'allow' : 'deny'}`;
      const seq = document.createElement('span'); seq.className = 'firewall-seq'; seq.textContent = `#${d.sequence ?? '?'}`;
      const body = document.createElement('div');
      const action = document.createElement('strong'); action.textContent = `${d.actor || 'unknown'} → ${d.action || 'UNKNOWN'}`;
      const reason = document.createElement('small'); reason.textContent = d.reason || '—';
      body.append(action, reason);
      const result = document.createElement('b'); result.textContent = d.allowed ? 'ALLOW' : 'DENY';
      row.append(seq, body, result);
      list.appendChild(row);
    }
    el('authority-ledger-head').textContent = short(data.headHash || data.head?.decisionHash || '—', 24);
    el('authority-ledger-count').textContent = String(data.decisions?.length || 0);
    const denied = decisions.filter(x => x.allowed === false).length;
    el('authority-denials').textContent = String(denied);
    const last = decisions[0];
    el('authority-last-action').textContent = last ? `${last.allowed ? 'ALLOW' : 'DENY'} · ${last.action || 'UNKNOWN'}` : '—';
    const barrier = el('authority-barrier');
    barrier?.classList.toggle('slam', Boolean(last && last.allowed === false));
    if (barrier && last && last.allowed === false) {
      setTimeout(() => barrier.classList.remove('slam'), 700);
    }
  }

  async function refresh() {
    try {
      const [graph, authority] = await Promise.all([getJson('/api/recovery-graph'), getJson('/api/authority-ledger')]);
      state.graph = graph;
      state.authority = authority;
      renderGraph(graph);
      renderAuthority(authority);
      const contracts = graph.contracts || {};
      el('recovery-graph-summary').textContent = `${graph.nodes?.length || 0} nodes · ${graph.edges?.length || 0} dependencies · ${contracts.valid ? 'constitution valid' : 'constitution warning'}`;
    } catch (error) {
      console.error('Recovery theater refresh failed', error);
    }
  }

  function pulseFromEvent(event) {
    if (!event) return;
    const source = String(event.source || '').toLowerCase();
    const hints = [
      ['shadow-laws', 'shadow-laws'], ['time-weave', 'time-weave'], ['forward-witness', 'forward-witness'],
      ['memory-palace', 'memory-palace'], ['rosetta', 'rosetta-capsule'], ['quaternary', 'quaternary-cold-codec'],
      ['recovery-contracts', 'recovery-contracts'], ['authority-firewall', 'authority-firewall'],
      ['last-savior', 'last-savior'], ['history-court', 'recovery-jury']
    ];
    const match = hints.find(([needle]) => source.includes(needle));
    if (!match) return;
    const node = document.querySelector(`.recovery-node[data-id="${match[1]}"]`);
    node?.classList.add('hot');
    setTimeout(() => node?.classList.remove('hot'), 900);
  }

  function bind() {
    refresh();
    document.addEventListener('observatory:snapshot', refresh);
    document.addEventListener('observatory:event', event => {
      pulseFromEvent(event.detail);
      if (event.detail?.family === 'recovery') {
        clearTimeout(bind.timer);
        bind.timer = setTimeout(refresh, 180);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', bind);
})();
