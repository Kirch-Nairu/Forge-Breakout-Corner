'use strict';

(() => {
  const state = { history: null };
  const el = id => document.getElementById(id);
  const short = (value, n = 16) => {
    const s = String(value || '—');
    return s.length > n ? `${s.slice(0, n)}…` : s;
  };
  const time = value => {
    const d = new Date(value);
    return value && !Number.isNaN(d.getTime()) ? d.toLocaleString() : '—';
  };

  async function refresh() {
    try {
      const response = await fetch('/api/history-map', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.history = await response.json();
      render(state.history);
    } catch (error) {
      console.error('History map failed', error);
    }
  }

  function render(history) {
    const timeline = el('history-timeline');
    if (!timeline) return;
    timeline.replaceChildren();
    const weaveByEpoch = new Map((history.timeWeave || []).map(node => [node.epochId, node]));
    const epochs = history.epochs || [];
    if (!epochs.length) {
      timeline.innerHTML = '<div class="empty">No OMEGA epochs observed yet.</div>';
    }
    epochs.forEach((epoch, index) => {
      const row = document.createElement('article');
      row.className = 'history-epoch';
      const marker = document.createElement('div');
      marker.className = 'history-marker';
      marker.textContent = String(index + 1).padStart(2, '0');
      const body = document.createElement('div');
      const header = document.createElement('header');
      const title = document.createElement('strong');
      title.textContent = epoch.label || `OMEGA epoch ${index + 1}`;
      const when = document.createElement('time');
      when.textContent = time(epoch.createdAt);
      header.append(title, when);
      const facts = document.createElement('div');
      facts.className = 'history-facts';
      const weave = weaveByEpoch.get(epoch.id);
      const pairs = [
        ['epoch', short(epoch.id, 22)],
        ['semantic', short(epoch.semanticWorldSha256, 22)],
        ['epoch hash', short(epoch.epochHash, 22)],
        ['weave', weave ? `position ${weave.position} · ${short(weave.weaveHash, 16)}` : 'not woven']
      ];
      for (const [k, v] of pairs) {
        const span = document.createElement('span');
        span.innerHTML = `<b>${k}</b><code>${v}</code>`;
        facts.appendChild(span);
      }
      body.append(header, facts);
      row.append(marker, body);
      timeline.appendChild(row);
    });

    const fossils = el('fossil-list');
    fossils.replaceChildren();
    for (const fossil of history.fossils || []) {
      const row = document.createElement('article');
      row.className = 'fossil-row';
      const title = document.createElement('strong');
      title.textContent = fossil.format?.includes('GENESIS') ? 'GENESIS' : `${fossil.changeCount} semantic changes`;
      const id = document.createElement('code');
      id.textContent = short(fossil.id, 26);
      const arrow = document.createElement('span');
      arrow.textContent = `${short(fossil.from?.worldSha256 || fossil.from?.memoryId, 12)} → ${short(fossil.to?.worldSha256 || fossil.to?.memoryId, 12)}`;
      row.append(title, id, arrow);
      fossils.appendChild(row);
    }
    if (!(history.fossils || []).length) fossils.innerHTML = '<div class="empty">No semantic fossils observed yet.</div>';

    el('history-epoch-count').textContent = String(epochs.length);
    el('history-weave-count').textContent = String((history.timeWeave || []).length);
    el('history-fossil-count').textContent = String((history.fossils || []).length);
  }

  document.addEventListener('DOMContentLoaded', () => {
    refresh();
    document.addEventListener('observatory:snapshot', refresh);
    document.addEventListener('observatory:event', event => {
      if (['history', 'recovery'].includes(event.detail?.family)) {
        clearTimeout(refresh.timer);
        refresh.timer = setTimeout(refresh, 180);
      }
    });
  });
})();
