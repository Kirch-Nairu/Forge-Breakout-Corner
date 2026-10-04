'use strict';

(() => {
  const byId = id => document.getElementById(id);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const short = value => {
    const s = String(value ?? 'null');
    return s.length > 34 ? `${s.slice(0, 31)}…` : s;
  };
  const shortId = value => {
    const s = String(value ?? 'row');
    return s.length > 14 ? `${s.slice(0, 11)}…` : s;
  };

  class IndexLab {
    constructor() {
      this.data = null;
      this.collectionNames = [];
      this.replayToken = 0;
      this.sortToken = 0;
      this.sortEntries = [];
      this.sortNodes = new Map();
      this.sortInitial = [];
      this.bind();
    }

    bind() {
      byId('index-collection')?.addEventListener('change', () => this.load());
      byId('index-name')?.addEventListener('change', () => this.renderIndex());
      byId('index-reload')?.addEventListener('click', () => this.load());
      byId('index-play')?.addEventListener('click', () => this.replayIndex());
      byId('sort-field')?.addEventListener('change', () => this.resetSort());
      byId('sort-algorithm')?.addEventListener('change', () => this.resetSort());
      byId('sort-play')?.addEventListener('click', () => this.playSort());
      byId('sort-reset')?.addEventListener('click', () => this.resetSort());

      document.addEventListener('observatory:snapshot', event => this.acceptSnapshot(event.detail));
      document.addEventListener('observatory:event', event => this.acceptObservation(event.detail));
    }

    acceptSnapshot(snapshot) {
      const names = (snapshot?.collections || []).map(item => item.name);
      if (!names.length) return;
      const changed = names.join('\0') !== this.collectionNames.join('\0');
      this.collectionNames = names;
      const select = byId('index-collection');
      const previous = select.value;
      if (changed || !select.options.length) {
        select.replaceChildren();
        for (const name of names) {
          const option = document.createElement('option');
          option.value = name;
          option.textContent = name;
          select.appendChild(option);
        }
        select.value = names.includes(previous) ? previous : names[0];
      }
      if (!this.data || this.data.collection !== select.value) this.load();
    }

    acceptObservation(event) {
      if (event?.type !== 'INDEX_CHANGED') return;
      const selected = byId('index-collection')?.value;
      if (!selected || event.source !== `indexes/${selected}.json`) return;
      const badge = byId('index-live-state');
      badge.textContent = 'LIVE INDEX CHANGE';
      badge.classList.add('hot');
      clearTimeout(this.liveReloadTimer);
      this.liveReloadTimer = setTimeout(async () => {
        await this.load({ preserveStatus: true });
        badge.textContent = 'LIVE / SYNCED';
        setTimeout(() => badge.classList.remove('hot'), 800);
      }, 180);
    }

    async load(options = {}) {
      const collection = byId('index-collection')?.value;
      if (!collection) return;
      this.replayToken++;
      this.sortToken++;
      const badge = byId('index-live-state');
      if (!options.preserveStatus) badge.textContent = 'LOADING';
      try {
        const response = await fetch(`/api/index-lab?collection=${encodeURIComponent(collection)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.data = await response.json();
        this.renderSelectors();
        this.renderIndex();
        this.renderSortFields();
        this.resetSort();
        if (!options.preserveStatus) badge.textContent = 'LIVE / SYNCED';
      } catch (error) {
        badge.textContent = 'LOAD FAILED';
        byId('index-replay-status').textContent = error.message;
      }
    }

    renderSelectors() {
      const indexSelect = byId('index-name');
      const prior = indexSelect.value;
      indexSelect.replaceChildren();
      const indexes = this.data?.indexArtifact?.indexes || [];
      for (const index of indexes) {
        const option = document.createElement('option');
        option.value = index.name;
        option.textContent = `${index.name} [${index.fields.join(' + ')}]`;
        indexSelect.appendChild(option);
      }
      if (indexes.some(item => item.name === prior)) indexSelect.value = prior;
      else if (indexes[0]) indexSelect.value = indexes[0].name;
    }

    selectedIndex() {
      const name = byId('index-name')?.value;
      return (this.data?.indexArtifact?.indexes || []).find(index => index.name === name) || null;
    }

    rowBucketMap(index) {
      const map = new Map();
      for (const bucket of index?.buckets || []) {
        for (const rowId of bucket.rowIds || []) map.set(String(rowId), bucket.key);
      }
      return map;
    }

    renderIndex() {
      const index = this.selectedIndex();
      const rows = this.data?.table?.rows || [];
      const rowLane = byId('index-row-lane');
      const bucketGrid = byId('index-bucket-grid');
      rowLane.replaceChildren();
      bucketGrid.replaceChildren();

      byId('index-built-at').textContent = this.data?.indexArtifact?.builtAt ? new Date(this.data.indexArtifact.builtAt).toLocaleTimeString() : '—';
      byId('index-tx').textContent = this.data?.indexArtifact?.tx || 0;
      byId('index-row-count').textContent = this.data?.indexArtifact?.rowCount || rows.length;
      byId('index-distinct').textContent = index?.distinct || 0;

      if (!index) {
        byId('index-replay-status').textContent = 'This collection has no persisted index to replay.';
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No index artifact.';
        rowLane.appendChild(empty);
        return;
      }

      const bucketByRow = this.rowBucketMap(index);
      for (const row of rows.slice(0, 80)) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'index-row-chip';
        chip.dataset.rowId = String(row.id);
        chip.dataset.bucketKey = bucketByRow.get(String(row.id)) || '';
        chip.innerHTML = `<b>${escapeHtml(shortId(row.id))}</b><small>${escapeHtml(short(index.fields.map(field => getField(row, field)).join(' | ')))}</small>`;
        rowLane.appendChild(chip);
      }

      for (const bucket of (index.buckets || []).slice(0, 80)) {
        const card = document.createElement('article');
        card.className = 'index-bucket-card';
        card.dataset.bucketKey = bucket.key;
        const header = document.createElement('header');
        const key = document.createElement('code');
        key.textContent = short(bucket.key);
        const count = document.createElement('span');
        count.textContent = `${bucket.rowIds.length} row${bucket.rowIds.length === 1 ? '' : 's'}`;
        header.append(key, count);
        const members = document.createElement('div');
        members.className = 'bucket-members';
        for (const id of bucket.rowIds.slice(0, 10)) {
          const member = document.createElement('i');
          member.textContent = shortId(id);
          members.appendChild(member);
        }
        if (bucket.rowIds.length > 10) {
          const more = document.createElement('i');
          more.textContent = `+${bucket.rowIds.length - 10}`;
          members.appendChild(more);
        }
        card.append(header, members);
        bucketGrid.appendChild(card);
      }
      byId('index-replay-status').textContent = `${index.name}: ${index.fields.join(' + ')} → ${index.bucketCount} persisted buckets`;
    }

    async replayIndex() {
      const index = this.selectedIndex();
      if (!index) return;
      const token = ++this.replayToken;
      const rows = this.data?.table?.rows || [];
      const bucketByRow = this.rowBucketMap(index);
      const button = byId('index-play');
      button.disabled = true;
      document.querySelectorAll('.index-row-chip, .index-bucket-card').forEach(node => node.classList.remove('active', 'landed'));
      try {
        for (const row of rows.slice(0, 80)) {
          if (token !== this.replayToken) break;
          const rowId = String(row.id);
          const key = bucketByRow.get(rowId);
          const rowNode = [...document.querySelectorAll('.index-row-chip')].find(node => node.dataset.rowId === rowId);
          const bucketNode = [...document.querySelectorAll('.index-bucket-card')].find(node => node.dataset.bucketKey === key);
          if (!rowNode || !bucketNode) continue;
          document.querySelectorAll('.index-row-chip.active, .index-bucket-card.active').forEach(node => node.classList.remove('active'));
          rowNode.classList.add('active');
          bucketNode.classList.add('active');
          byId('index-replay-status').textContent = `row ${shortId(rowId)} → encode [${index.fields.join(', ')}] → bucket ${short(key)} → append row.id`;
          await flyClone(rowNode, bucketNode, 360);
          bucketNode.classList.add('landed');
          await sleep(95);
        }
        if (token === this.replayToken) byId('index-replay-status').textContent = `Replay complete: ${rows.length} current rows → ${index.bucketCount} persisted hash buckets.`;
      } finally {
        button.disabled = false;
      }
    }

    renderSortFields() {
      const select = byId('sort-field');
      const prior = select.value;
      select.replaceChildren();
      for (const field of this.data?.sortFields || []) {
        const option = document.createElement('option');
        option.value = field.field;
        option.textContent = `${field.field} (${field.dominantType})`;
        select.appendChild(option);
      }
      if ([...select.options].some(option => option.value === prior)) select.value = prior;
    }

    resetSort() {
      this.sortToken++;
      const field = byId('sort-field')?.value;
      const rows = this.data?.table?.rows || [];
      const values = rows
        .map((row, sequence) => ({ row, sequence, id: String(row.id), value: getField(row, field) }))
        .filter(entry => entry.value != null && ['string', 'number', 'boolean'].includes(typeof entry.value))
        .slice(0, 28);
      this.sortEntries = values.map((entry, index) => ({ ...entry, token: `${entry.id}\0${entry.sequence}\0${index}` }));
      this.sortInitial = this.sortEntries.map(entry => ({ ...entry }));
      this.sortNodes.clear();
      const stage = byId('sort-stage');
      stage.replaceChildren();
      if (!field || !this.sortEntries.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Choose a field with primitive values.';
        stage.appendChild(empty);
        this.setSortMetrics(0, 0, 'NO DATA');
        return;
      }
      const heights = valueHeights(this.sortEntries.map(entry => entry.value));
      this.sortEntries.forEach((entry, index) => {
        const bar = document.createElement('div');
        bar.className = 'sort-bar';
        bar.dataset.token = entry.token;
        bar.style.setProperty('--bar-height', `${heights[index]}%`);
        const value = document.createElement('b');
        value.textContent = short(entry.value);
        const id = document.createElement('small');
        id.textContent = shortId(entry.id);
        bar.append(value, id);
        stage.appendChild(bar);
        this.sortNodes.set(entry.token, bar);
      });
      this.setSortMetrics(0, 0, 'READY');
    }

    setSortMetrics(comparisons, moves, status) {
      byId('sort-comparisons').textContent = comparisons;
      byId('sort-moves').textContent = moves;
      byId('sort-status').textContent = status;
    }

    comparator(a, b) {
      if (typeof a.value === 'number' && typeof b.value === 'number') return a.value - b.value;
      if (typeof a.value === 'boolean' && typeof b.value === 'boolean') return Number(a.value) - Number(b.value);
      return String(a.value).localeCompare(String(b.value), undefined, { numeric: true, sensitivity: 'base' });
    }

    operations(entries, algorithm) {
      const work = entries.map(entry => ({ ...entry }));
      const operations = [];
      const compare = (i, j) => {
        operations.push({ type: 'compare', i, j });
        return this.comparator(work[i], work[j]);
      };
      const swap = (i, j) => {
        [work[i], work[j]] = [work[j], work[i]];
        operations.push({ type: 'swap', i, j });
      };
      if (algorithm === 'bubble') {
        for (let end = work.length - 1; end > 0; end--) {
          let changed = false;
          for (let i = 0; i < end; i++) {
            if (compare(i, i + 1) > 0) { swap(i, i + 1); changed = true; }
          }
          if (!changed) break;
        }
      } else if (algorithm === 'selection') {
        for (let i = 0; i < work.length - 1; i++) {
          let min = i;
          for (let j = i + 1; j < work.length; j++) if (compare(j, min) < 0) min = j;
          if (min !== i) swap(i, min);
        }
      } else {
        for (let i = 1; i < work.length; i++) {
          let j = i;
          while (j > 0) {
            if (compare(j - 1, j) <= 0) break;
            swap(j - 1, j);
            j--;
          }
        }
      }
      return operations;
    }

    async playSort() {
      if (!this.sortEntries.length) return;
      this.resetSort();
      const token = ++this.sortToken;
      const algorithm = byId('sort-algorithm').value;
      const delay = Number(byId('sort-speed').value || 420);
      const operations = this.operations(this.sortEntries, algorithm);
      let comparisons = 0;
      let moves = 0;
      const play = byId('sort-play');
      play.disabled = true;
      this.setSortMetrics(0, 0, 'RUNNING');
      try {
        for (const op of operations) {
          if (token !== this.sortToken) break;
          this.clearSortClasses();
          if (op.type === 'compare') {
            comparisons++;
            this.sortNodes.get(this.sortEntries[op.i]?.token)?.classList.add('comparing');
            this.sortNodes.get(this.sortEntries[op.j]?.token)?.classList.add('comparing');
            this.setSortMetrics(comparisons, moves, 'COMPARE');
            await sleep(Math.max(20, delay * .42));
          } else {
            moves++;
            await this.animateSwap(op.i, op.j, Math.max(40, delay * .72));
            this.setSortMetrics(comparisons, moves, 'MOVE');
          }
          await sleep(Math.max(8, delay * .12));
        }
        if (token === this.sortToken) {
          this.clearSortClasses();
          document.querySelectorAll('#sort-stage .sort-bar').forEach(node => node.classList.add('sorted'));
          this.setSortMetrics(comparisons, moves, 'SORTED');
        }
      } finally {
        play.disabled = false;
      }
    }

    clearSortClasses() {
      document.querySelectorAll('#sort-stage .sort-bar').forEach(node => node.classList.remove('comparing', 'swapping', 'sorted'));
    }

    async animateSwap(i, j, duration) {
      const stage = byId('sort-stage');
      const a = this.sortEntries[i];
      const b = this.sortEntries[j];
      if (!a || !b) return;
      const nodeA = this.sortNodes.get(a.token);
      const nodeB = this.sortNodes.get(b.token);
      if (!nodeA || !nodeB) return;
      const beforeA = nodeA.getBoundingClientRect();
      const beforeB = nodeB.getBoundingClientRect();
      [this.sortEntries[i], this.sortEntries[j]] = [this.sortEntries[j], this.sortEntries[i]];
      for (const entry of this.sortEntries) stage.appendChild(this.sortNodes.get(entry.token));
      const afterA = nodeA.getBoundingClientRect();
      const afterB = nodeB.getBoundingClientRect();
      nodeA.classList.add('swapping');
      nodeB.classList.add('swapping');
      await Promise.all([
        nodeA.animate([{ transform: `translate(${beforeA.left - afterA.left}px,0)` }, { transform: 'translate(0,0)' }], { duration, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished,
        nodeB.animate([{ transform: `translate(${beforeB.left - afterB.left}px,0)` }, { transform: 'translate(0,0)' }], { duration, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished
      ]).catch(() => {});
      nodeA.classList.remove('swapping');
      nodeB.classList.remove('swapping');
    }
  }

  function getField(value, field) {
    if (!field) return undefined;
    return field.split('.').reduce((current, part) => current == null ? undefined : current[part], value);
  }

  function valueHeights(values) {
    if (values.every(value => typeof value === 'number' && Number.isFinite(value))) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      return values.map(value => max === min ? 60 : 18 + ((value - min) / (max - min)) * 74);
    }
    const ordered = [...new Set(values.map(value => String(value)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const rank = new Map(ordered.map((value, index) => [value, index]));
    return values.map(value => ordered.length <= 1 ? 60 : 18 + (rank.get(String(value)) / (ordered.length - 1)) * 74);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  }

  async function flyClone(source, target, duration) {
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const clone = document.createElement('div');
    clone.className = 'index-flight';
    clone.textContent = source.querySelector('b')?.textContent || 'row';
    clone.style.left = `${sourceRect.left + sourceRect.width / 2}px`;
    clone.style.top = `${sourceRect.top + sourceRect.height / 2}px`;
    document.body.appendChild(clone);
    const dx = targetRect.left + targetRect.width / 2 - (sourceRect.left + sourceRect.width / 2);
    const dy = targetRect.top + targetRect.height / 2 - (sourceRect.top + sourceRect.height / 2);
    try {
      await clone.animate([
        { transform: 'translate(-50%,-50%) scale(.8)', opacity: .2 },
        { transform: `translate(calc(-50% + ${dx * .55}px), calc(-50% + ${dy * .32 - 28}px)) scale(1)`, opacity: 1, offset: .58 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.65)`, opacity: .25 }
      ], { duration, easing: 'cubic-bezier(.25,.8,.25,1)' }).finished;
    } catch {} finally { clone.remove(); }
  }

  document.addEventListener('DOMContentLoaded', () => { window.omegaIndexLab = new IndexLab(); });
})();
