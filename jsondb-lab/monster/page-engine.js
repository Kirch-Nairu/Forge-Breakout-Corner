'use strict';

const path = require('path');
const crypto = require('crypto');
const fsp = require('fs/promises');
const { now, uuid, ensureDir, readJson, atomicJson, hashValue } = require('./jsonfs');

class BufferPool {
  constructor(pageLoader, pageWriter, capacity = 32) {
    this.pageLoader = pageLoader;
    this.pageWriter = pageWriter;
    this.capacity = capacity;
    this.frames = new Map();
    this.hits = 0; this.misses = 0; this.evictions = 0; this.flushes = 0;
  }

  async get(pageId, pin = false) {
    if (this.frames.has(pageId)) {
      const frame = this.frames.get(pageId);
      frame.lastUsed = Date.now(); frame.hits++; if (pin) frame.pins++;
      this.hits++; return frame.page;
    }
    this.misses++;
    await this.evictIfNeeded();
    const page = await this.pageLoader(pageId);
    if (!page) return null;
    this.frames.set(pageId, { page, dirty: false, pins: pin ? 1 : 0, lastUsed: Date.now(), hits: 0 });
    return page;
  }

  markDirty(pageId) {
    const frame = this.frames.get(pageId);
    if (frame) frame.dirty = true;
  }

  unpin(pageId) {
    const frame = this.frames.get(pageId);
    if (frame) frame.pins = Math.max(0, frame.pins - 1);
  }

  async evictIfNeeded() {
    if (this.frames.size < this.capacity) return;
    const candidates = [...this.frames.entries()].filter(([, f]) => f.pins === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    if (!candidates.length) throw Object.assign(new Error('Buffer pool exhausted: every page is pinned.'), { status: 503 });
    const [id, frame] = candidates[0];
    if (frame.dirty) { await this.pageWriter(frame.page); this.flushes++; }
    this.frames.delete(id); this.evictions++;
  }

  async flushAll() {
    for (const [id, frame] of this.frames) if (frame.dirty) { await this.pageWriter(frame.page); frame.dirty = false; this.flushes++; }
  }

  stats() {
    return { capacity: this.capacity, resident: this.frames.size, hits: this.hits, misses: this.misses, hitRate: this.hits + this.misses ? this.hits / (this.hits + this.misses) : 0, evictions: this.evictions, flushes: this.flushes, pages: [...this.frames.entries()].map(([id, f]) => ({ id, dirty: f.dirty, pins: f.pins, hits: f.hits })) };
  }
}

class JsonPageEngine {
  constructor(engine, pageBytes = 4096, poolSize = 32) {
    this.engine = engine;
    this.pageBytes = pageBytes;
    this.root = path.join(engine.data, 'advanced', 'pages');
    this.poolSize = poolSize;
    this.pools = new Map();
  }

  collectionDir(collection) { return path.join(this.root, collection); }
  pageFile(collection, id) { return path.join(this.collectionDir(collection), 'heap', `${id}.json`); }
  directoryFile(collection) { return path.join(this.collectionDir(collection), 'directory.json'); }

  async loadPage(collection, id) { return readJson(this.pageFile(collection, id), null); }
  async writePage(collection, page) {
    page.header.checksum = this.pageChecksum(page);
    page.header.flushedAt = now();
    await atomicJson(this.pageFile(collection, page.header.pageId), page);
  }

  pageChecksum(page) {
    const clone = JSON.parse(JSON.stringify(page));
    if (clone.header) clone.header.checksum = null;
    return hashValue(clone);
  }

  pool(collection) {
    if (!this.pools.has(collection)) this.pools.set(collection, new BufferPool(id => this.loadPage(collection, id), page => this.writePage(collection, page), this.poolSize));
    return this.pools.get(collection);
  }

  rowBytes(row) { return Buffer.byteLength(JSON.stringify(row), 'utf8') + 24; }

  newPage(collection, sequence) {
    const pageId = `p${String(sequence).padStart(8, '0')}-${crypto.randomBytes(3).toString('hex')}`;
    return {
      header: { pageId, collection, sequence, pageBytes: this.pageBytes, createdAt: now(), flushedAt: null, checksum: null },
      slots: [], free: { bytes: this.pageBytes, tombstones: 0 }
    };
  }

  recomputeFree(page) {
    const used = page.slots.reduce((sum, slot) => sum + (slot.deleted ? 16 : this.rowBytes(slot.row)), 0) + 256;
    page.free.bytes = Math.max(0, this.pageBytes - used);
    page.free.tombstones = page.slots.filter(slot => slot.deleted).length;
  }

  async rebuild(collection) {
    const rows = await this.engine.readAt(collection);
    const dir = this.collectionDir(collection);
    await fsp.rm(dir, { recursive: true, force: true });
    await ensureDir(path.join(dir, 'heap'));
    this.pools.delete(collection);
    const pages = [];
    let page = this.newPage(collection, 0);
    for (const row of rows) {
      const bytes = this.rowBytes(row);
      if (bytes > this.pageBytes - 512) throw Object.assign(new Error(`Row ${row.id} exceeds logical page capacity.`), { status: 413 });
      this.recomputeFree(page);
      if (page.slots.length && page.free.bytes < bytes) {
        this.recomputeFree(page); await this.writePage(collection, page); pages.push(page);
        page = this.newPage(collection, pages.length);
      }
      page.slots.push({ slot: page.slots.length, rowId: row.id, deleted: false, row });
      this.recomputeFree(page);
    }
    await this.writePage(collection, page); pages.push(page);
    const directory = {
      collection, pageBytes: this.pageBytes, rebuiltAt: now(), pages: pages.map(p => ({ pageId: p.header.pageId, sequence: p.header.sequence, slots: p.slots.length, freeBytes: p.free.bytes, tombstones: p.free.tombstones, minRowId: p.slots[0]?.rowId || null, maxRowId: p.slots[p.slots.length - 1]?.rowId || null }))
    };
    await atomicJson(this.directoryFile(collection), directory);
    return directory;
  }

  async inspect(collection, pageId) {
    const page = await this.pool(collection).get(pageId, true);
    if (!page) throw Object.assign(new Error('Page not found.'), { status: 404 });
    try {
      const expected = this.pageChecksum(page);
      return { page, checksumValid: expected === page.header.checksum, computedChecksum: expected, bufferPool: this.pool(collection).stats() };
    } finally { this.pool(collection).unpin(pageId); }
  }

  async heapScan(collection, limit = 1000) {
    const directory = await readJson(this.directoryFile(collection), null);
    if (!directory) throw Object.assign(new Error('Page heap not built.'), { status: 404 });
    const rows = []; let pagesRead = 0;
    for (const item of directory.pages) {
      const page = await this.pool(collection).get(item.pageId, true); pagesRead++;
      try {
        for (const slot of page.slots) {
          if (!slot.deleted) rows.push(slot.row);
          if (rows.length >= limit) return { collection, rows, pagesRead, bufferPool: this.pool(collection).stats() };
        }
      } finally { this.pool(collection).unpin(item.pageId); }
    }
    return { collection, rows, pagesRead, bufferPool: this.pool(collection).stats() };
  }

  async tombstone(collection, rowId) {
    const directory = await readJson(this.directoryFile(collection), null);
    if (!directory) throw Object.assign(new Error('Page heap not built.'), { status: 404 });
    for (const item of directory.pages) {
      const page = await this.pool(collection).get(item.pageId, true);
      try {
        const slot = page.slots.find(s => s.rowId === rowId && !s.deleted);
        if (!slot) continue;
        slot.deleted = true; slot.deletedAt = now(); this.recomputeFree(page); this.pool(collection).markDirty(item.pageId);
        return { collection, rowId, pageId: item.pageId, slot: slot.slot, tombstoned: true };
      } finally { this.pool(collection).unpin(item.pageId); }
    }
    throw Object.assign(new Error('Row not found in page heap.'), { status: 404 });
  }

  async vacuum(collection) {
    const scan = await this.heapScan(collection, Number.MAX_SAFE_INTEGER);
    const originalDirectory = await readJson(this.directoryFile(collection), null);
    const before = { pages: originalDirectory.pages.length, tombstones: originalDirectory.pages.reduce((n, p) => n + p.tombstones, 0) };
    await this.pool(collection).flushAll();
    // Vacuum uses the canonical engine rows, intentionally proving the page heap is a derived storage experiment.
    const afterDirectory = await this.rebuild(collection);
    return { collection, before, after: { pages: afterDirectory.pages.length, tombstones: 0 }, scannedRows: scan.rows.length };
  }

  async status(collection) {
    return { directory: await readJson(this.directoryFile(collection), null), bufferPool: this.pool(collection).stats() };
  }
}

module.exports = { JsonPageEngine, BufferPool };
