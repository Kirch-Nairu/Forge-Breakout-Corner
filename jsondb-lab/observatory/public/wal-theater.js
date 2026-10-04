'use strict';

(() => {
  const walState = {
    entries: [],
    index: 0,
    timer: null,
    playing: false
  };

  function el(id) { return document.getElementById(id); }
  function fmtTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function short(value, n = 18) {
    if (value == null) return '—';
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s.length > n ? `${s.slice(0, n)}…` : s;
  }

  function ordered(entries) {
    return [...(entries || [])].sort((a, b) => Number(a.lsn || 0) - Number(b.lsn || 0));
  }

  function renderTimeline() {
    const slider = el('wal-scrubber');
    if (!slider) return;
    const max = Math.max(0, walState.entries.length - 1);
    walState.index = Math.max(0, Math.min(max, walState.index));
    slider.max = String(max);
    slider.value = String(walState.index);
    slider.disabled = walState.entries.length < 2;
    el('wal-replay-position').textContent = walState.entries.length ? `${walState.index + 1} / ${walState.entries.length}` : '0 / 0';
    const selected = walState.entries[walState.index] || null;
    renderFrame(selected);
    renderRail();
  }

  function renderFrame(entry) {
    const detail = el('wal-replay-detail');
    const pulse = el('wal-replay-pulse');
    if (!detail || !pulse) return;
    detail.replaceChildren();
    pulse.classList.remove('commit', 'abort', 'mutation', 'begin');
    if (!entry) {
      detail.textContent = 'No WAL entries observed.';
      return;
    }
    const type = String(entry.type || 'ENTRY').toUpperCase();
    if (/COMMIT/.test(type)) pulse.classList.add('commit');
    else if (/ABORT/.test(type)) pulse.classList.add('abort');
    else if (/MUTATION|INSERT|UPDATE|DELETE/.test(type)) pulse.classList.add('mutation');
    else if (/BEGIN/.test(type)) pulse.classList.add('begin');

    const fields = [
      ['LSN', entry.lsn ?? '—'],
      ['TYPE', type],
      ['TX', entry.tx ?? entry.txId ?? entry.transaction ?? '—'],
      ['AT', fmtTime(entry.at)],
      ['COLLECTION', entry.collection ?? entry.table ?? entry.payload?.collection ?? '—'],
      ['ROW', entry.id ?? entry.rowId ?? entry.payload?.id ?? '—']
    ];
    for (const [label, value] of fields) {
      const row = document.createElement('div');
      const dt = document.createElement('span');
      dt.textContent = label;
      const dd = document.createElement('strong');
      dd.textContent = String(value);
      row.append(dt, dd);
      detail.appendChild(row);
    }
    const preview = document.createElement('pre');
    preview.textContent = JSON.stringify(entry, null, 2);
    detail.appendChild(preview);
    pulse.textContent = `${entry.lsn ?? '?'} · ${short(type, 24)}`;
  }

  function renderRail() {
    const rail = el('wal-replay-rail');
    if (!rail) return;
    rail.replaceChildren();
    const start = Math.max(0, walState.index - 8);
    const end = Math.min(walState.entries.length, start + 17);
    for (let i = start; i < end; i++) {
      const entry = walState.entries[i];
      const button = document.createElement('button');
      button.className = `wal-replay-tick${i === walState.index ? ' active' : ''}`;
      button.type = 'button';
      button.title = `LSN ${entry.lsn ?? '?'} · ${entry.type || 'ENTRY'}`;
      const lsn = document.createElement('span');
      lsn.textContent = String(entry.lsn ?? '?');
      const kind = document.createElement('small');
      kind.textContent = short(entry.type || 'ENTRY', 10);
      button.append(lsn, kind);
      button.addEventListener('click', () => {
        stop();
        walState.index = i;
        renderTimeline();
      });
      rail.appendChild(button);
    }
  }

  function step(direction = 1) {
    if (!walState.entries.length) return;
    walState.index += direction;
    if (walState.index >= walState.entries.length) walState.index = 0;
    if (walState.index < 0) walState.index = walState.entries.length - 1;
    renderTimeline();
  }

  function stop() {
    walState.playing = false;
    if (walState.timer) clearInterval(walState.timer);
    walState.timer = null;
    const button = el('wal-replay-play');
    if (button) button.textContent = '▶ Replay';
  }

  function play() {
    if (walState.playing) return stop();
    if (!walState.entries.length) return;
    walState.playing = true;
    const button = el('wal-replay-play');
    if (button) button.textContent = '■ Stop';
    const speed = () => Number(el('wal-replay-speed')?.value || 650);
    const loop = () => {
      if (!walState.playing) return;
      step(1);
      walState.timer = setTimeout(loop, speed());
    };
    walState.timer = setTimeout(loop, speed());
  }

  function setEntries(entries) {
    const next = ordered(entries);
    const priorLsn = walState.entries[walState.index]?.lsn;
    walState.entries = next;
    const priorIndex = next.findIndex(x => String(x.lsn) === String(priorLsn));
    walState.index = priorIndex >= 0 ? priorIndex : Math.max(0, next.length - 1);
    renderTimeline();
  }

  function bind() {
    const slider = el('wal-scrubber');
    if (!slider) return;
    slider.addEventListener('input', () => {
      stop();
      walState.index = Number(slider.value || 0);
      renderTimeline();
    });
    el('wal-replay-play')?.addEventListener('click', play);
    el('wal-replay-prev')?.addEventListener('click', () => { stop(); step(-1); });
    el('wal-replay-next')?.addEventListener('click', () => { stop(); step(1); });
    document.addEventListener('observatory:snapshot', event => setEntries(event.detail?.wal || []));
  }

  document.addEventListener('DOMContentLoaded', bind);
})();
