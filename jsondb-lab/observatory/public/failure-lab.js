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
