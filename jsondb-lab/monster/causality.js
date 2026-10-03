'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, readJsonl, atomicJson, atomicText } = require('./jsonfs');

function digest(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
function compareClock(a, b) {
  if ((a?.wall || 0) !== (b?.wall || 0)) return (a?.wall || 0) - (b?.wall || 0);
  if ((a?.logical || 0) !== (b?.logical || 0)) return (a?.logical || 0) - (b?.logical || 0);
  return String(a?.node || '').localeCompare(String(b?.node || ''));
}

class HybridLogicalClock {
  constructor(node, state = null) {
    this.node = node;
    this.wall = state?.wall || 0;
    this.logical = state?.logical || 0;
  }
  tick() {
    const physical = Date.now();
    if (physical > this.wall) { this.wall = physical; this.logical = 0; }
    else this.logical++;
    return this.value();
  }
  merge(remote) {
    const physical = Date.now();
    const maxWall = Math.max(physical, this.wall, remote?.wall || 0);
    if (maxWall === this.wall && maxWall === (remote?.wall || 0)) this.logical = Math.max(this.logical, remote.logical || 0) + 1;
    else if (maxWall === this.wall) this.logical = this.logical + 1;
    else if (maxWall === (remote?.wall || 0)) this.logical = (remote.logical || 0) + 1;
    else this.logical = 0;
    this.wall = maxWall;
    return this.value();
  }
  value() { return { wall: this.wall, logical: this.logical, node: this.node }; }
}

class TamperLedger {
  constructor(engine) {
    this.engine = engine;
    this.root = path.join(engine.data, 'advanced', 'ledger');
    this.file = path.join(this.root, 'wal-seal.jsonl');
    this.anchor = path.join(this.root, 'anchor.json');
  }

  async seal() {
    await ensureDir(this.root);
    const events = (await readJsonl(this.engine.wal)).filter(x => !x.__corrupt);
    let previous = '0'.repeat(64);
    const lines = [];
    for (let i = 0; i < events.length; i++) {
      const canonical = JSON.stringify(events[i]);
      const hash = digest(`${previous}|${canonical}`);
      lines.push(JSON.stringify({ ordinal: i, lsn: events[i].lsn ?? null, previous, hash, event: events[i] }));
      previous = hash;
    }
    await atomicText(this.file, lines.length ? `${lines.join('\n')}\n` : '');
    const anchor = { sealedAt: now(), entries: events.length, head: previous, source: 'wal.jsonl', algorithm: 'sha256 hash chain' };
    await atomicJson(this.anchor, anchor);
    return anchor;
  }

  async verify() {
    const rows = await readJsonl(this.file);
    let previous = '0'.repeat(64);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.__corrupt) return { valid: false, ordinal: i, reason: 'Corrupt ledger JSON.' };
      if (row.previous !== previous) return { valid: false, ordinal: i, reason: 'Previous-hash link mismatch.' };
      const expected = digest(`${previous}|${JSON.stringify(row.event)}`);
      if (expected !== row.hash) return { valid: false, ordinal: i, reason: 'Entry hash mismatch.' };
      previous = row.hash;
    }
    const anchor = await readJson(this.anchor, null);
    if (anchor && anchor.head !== previous) return { valid: false, ordinal: rows.length, reason: 'Anchor head mismatch.', computed: previous, anchored: anchor.head };
    return { valid: true, entries: rows.length, head: previous, anchor };
  }
}

class CrdtLab {
  constructor(engine) {
    this.engine = engine;
    this.root = path.join(engine.data, 'advanced', 'crdt');
  }
  nodeFile(node) { return path.join(this.root, 'nodes', `${node}.json`); }

  async loadNode(node) {
    await ensureDir(path.dirname(this.nodeFile(node)));
    return readJson(this.nodeFile(node), { node, clock: { wall: 0, logical: 0, node }, documents: {}, operations: 0 });
  }

  async saveNode(state) { await atomicJson(this.nodeFile(state.node), state); return state; }

  async set(node, collection, key, field, value) {
    const state = await this.loadNode(node);
    const clock = new HybridLogicalClock(node, state.clock);
    const stamp = clock.tick();
    state.clock = stamp;
    state.documents[collection] ||= {};
    state.documents[collection][key] ||= { fields: {}, tombstone: null };
    state.documents[collection][key].fields[field] = { value, clock: stamp };
    state.operations++;
    await this.saveNode(state);
    return { node, collection, key, field, value, clock: stamp };
  }

  async remove(node, collection, key) {
    const state = await this.loadNode(node);
    const clock = new HybridLogicalClock(node, state.clock);
    const stamp = clock.tick(); state.clock = stamp;
    state.documents[collection] ||= {};
    state.documents[collection][key] ||= { fields: {}, tombstone: null };
    state.documents[collection][key].tombstone = stamp;
    state.operations++;
    await this.saveNode(state);
    return { node, collection, key, deleted: true, clock: stamp };
  }

  mergeDocument(a = { fields: {}, tombstone: null }, b = { fields: {}, tombstone: null }) {
    const out = { fields: {}, tombstone: compareClock(a.tombstone, b.tombstone) >= 0 ? a.tombstone : b.tombstone };
    const fields = new Set([...Object.keys(a.fields || {}), ...Object.keys(b.fields || {})]);
    for (const field of fields) {
      const av = a.fields?.[field], bv = b.fields?.[field];
      out.fields[field] = !av ? bv : !bv ? av : compareClock(av.clock, bv.clock) >= 0 ? av : bv;
    }
    return out;
  }

  async merge(targetNode, sourceNode) {
    const target = await this.loadNode(targetNode);
    const source = await this.loadNode(sourceNode);
    const clock = new HybridLogicalClock(targetNode, target.clock);
    target.clock = clock.merge(source.clock);
    for (const [collection, docs] of Object.entries(source.documents || {})) {
      target.documents[collection] ||= {};
      for (const [key, doc] of Object.entries(docs)) target.documents[collection][key] = this.mergeDocument(target.documents[collection][key], doc);
    }
    target.operations++;
    target.lastMerge = { at: now(), source: sourceNode, sourceClock: source.clock };
    await this.saveNode(target);
    return { target: targetNode, source: sourceNode, clock: target.clock, documents: Object.values(target.documents).reduce((n, c) => n + Object.keys(c).length, 0) };
  }

  async materialize(node, collection) {
    const state = await this.loadNode(node);
    const docs = state.documents[collection] || {};
    const rows = [];
    for (const [id, doc] of Object.entries(docs)) {
      const latestFieldClock = Object.values(doc.fields || {}).reduce((best, item) => !best || compareClock(item.clock, best) > 0 ? item.clock : best, null);
      if (doc.tombstone && compareClock(doc.tombstone, latestFieldClock) >= 0) continue;
      const row = { id };
      for (const [field, entry] of Object.entries(doc.fields || {})) if (!doc.tombstone || compareClock(entry.clock, doc.tombstone) > 0) row[field] = entry.value;
      rows.push(row);
    }
    return { node, collection, clock: state.clock, rows };
  }

  async conflictDemo() {
    const key = `demo-${Date.now()}`;
    await this.set('offline-laptop-a', 'notes', key, 'text', 'A edited this while offline.');
    await this.set('offline-laptop-b', 'notes', key, 'text', 'B independently edited this too.');
    await this.set('offline-laptop-a', 'notes', key, 'mood', 'reckless');
    const before = {
      a: await this.materialize('offline-laptop-a', 'notes'),
      b: await this.materialize('offline-laptop-b', 'notes')
    };
    await this.merge('offline-laptop-a', 'offline-laptop-b');
    await this.merge('offline-laptop-b', 'offline-laptop-a');
    return { key, before, after: { a: await this.materialize('offline-laptop-a', 'notes'), b: await this.materialize('offline-laptop-b', 'notes') }, resolution: 'HLC last-writer-wins per field with deterministic node-id tie break.' };
  }
}

module.exports = { HybridLogicalClock, TamperLedger, CrdtLab, compareClock };
