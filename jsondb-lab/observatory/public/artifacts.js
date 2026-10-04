'use strict';

(() => {
  const state = { artifacts: [], filtered: [] };
  const el = id => document.getElementById(id);
  const fmtBytes = value => {
    const n = Number(value || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  };
  const fmtTime = value => value ? new Date(value).toLocaleString() : '—';

  async function list() {
    try {
      const response = await fetch('/api/artifacts', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.artifacts = data.artifacts || [];
      applyFilter();
      el('artifact-count').textContent = `${state.artifacts.length} FILES`;
    } catch (error) {
      console.error('Artifact list failed', error);
    }
  }

  function applyFilter() {
    const q = String(el('artifact-search')?.value || '').trim().toLowerCase();
    state.filtered = q ? state.artifacts.filter(item => item.path.toLowerCase().includes(q)) : state.artifacts;
    renderList();
  }

  function renderList() {
    const host = el('artifact-list');
    if (!host) return;
    host.replaceChildren();
    for (const artifact of state.filtered.slice(0, 600)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'artifact-row';
      button.disabled = !artifact.previewable;
      const path = document.createElement('code'); path.textContent = artifact.path;
      const meta = document.createElement('span'); meta.textContent = `${fmtBytes(artifact.bytes)} · ${fmtTime(artifact.mtimeMs)}`;
      const badge = document.createElement('b'); badge.textContent = artifact.previewable ? 'OPEN' : 'META';
      button.append(path, meta, badge);
      if (artifact.previewable) button.addEventListener('click', () => openArtifact(artifact));
      host.appendChild(button);
    }
    if (!state.filtered.length) host.innerHTML = '<div class="empty">No matching artifacts.</div>';
  }

  async function openArtifact(artifact) {
    const preview = el('artifact-preview');
    preview.textContent = 'loading…';
    try {
      const response = await fetch(`/api/artifact?id=${encodeURIComponent(artifact.id)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const text = data.content || '';
      try { preview.textContent = JSON.stringify(JSON.parse(text), null, 2); }
      catch { preview.textContent = text; }
      el('artifact-selected').textContent = artifact.path;
    } catch (error) {
      preview.textContent = `Unable to preview artifact: ${error.message}`;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    el('artifact-search')?.addEventListener('input', applyFilter);
    list();
    document.addEventListener('observatory:event', event => {
      if (['filesystem', 'history', 'recovery', 'index', 'data', 'wal'].includes(event.detail?.family)) {
        clearTimeout(list.timer);
        list.timer = setTimeout(list, 320);
      }
    });
  });
})();
