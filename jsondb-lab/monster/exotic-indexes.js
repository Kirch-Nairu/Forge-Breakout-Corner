'use strict';

const path = require('path');
const fsp = require('fs/promises');
const { ensureDir, atomicJson, readJson, now, uuid } = require('./jsonfs');
const { get } = require('./query');

function compare(a, b) {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return a < b ? -1 : 1;
}

class JsonBPlusTree {
  constructor(engine) {
    this.engine = engine;
    this.root = path.join(engine.data, 'advanced', 'btree');
  }

  dir(collection, field) { return path.join(this.root, collection, field.replace(/[^A-Za-z0-9_.-]/g, '_')); }

  async writePage(dir, page) {
    await atomicJson(path.join(dir, 'pages', `${page.id}.json`), page);
    return page.id;
  }

  async readPage(dir, id) { return readJson(path.join(dir, 'pages', `${id}.json`), null); }

  async build(collection, field, fanout = 64) {
    fanout = Math.min(256, Math.max(4, Number(fanout || 64)));
    const rows = await this.engine.readAt(collection);
    const entries = rows
      .map(row => ({ key: get(row, field), id: row.id }))
      .filter(entry => entry.key !== undefined && entry.key !== null)
      .sort((a, b) => compare(a.key, b.key) || String(a.id).localeCompare(String(b.id)));
    const dir = this.dir(collection, field);
    await fsp.rm(dir, { recursive: true, force: true });
    await ensureDir(path.join(dir, 'pages'));

    const leaves = [];
    for (let i = 0; i < entries.length; i += fanout) {
      leaves.push({ id: uuid(), type: 'leaf', entries: entries.slice(i, i + fanout), next: null, min: entries[i]?.key ?? null, max: entries[Math.min(entries.length - 1, i + fanout - 1)]?.key ?? null });
    }
    if (!leaves.length) leaves.push({ id: uuid(), type: 'leaf', entries: [], next: null, min: null, max: null });
    for (let i = 0; i < leaves.length - 1; i++) leaves[i].next = leaves[i + 1].id;
    for (const leaf of leaves) await this.writePage(dir, leaf);

    let level = leaves.map(page => ({ id: page.id, min: page.min, max: page.max }));
    let height = 1;
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += fanout) {
        const children = level.slice(i, i + fanout);
        const page = {
          id: uuid(), type: 'internal',
          separators: children.slice(1).map(child => child.min),
          children: children.map(child => child.id),
          min: children[0]?.min ?? null,
          max: children[children.length - 1]?.max ?? null
        };
        await this.writePage(dir, page);
        next.push({ id: page.id, min: page.min, max: page.max });
      }
      level = next;
      height++;
    }
    const manifest = {
      type: 'json-b-plus-tree-ish', collection, field, fanout, builtAt: now(), rows: entries.length,
      height, rootPage: level[0].id, firstLeaf: leaves[0].id, leafPages: leaves.length,
      disclaimer: 'Bulk-built immutable pages; not a production B+ tree implementation.'
    };
    await atomicJson(path.join(dir, 'manifest.json'), manifest);
    return manifest;
  }

  async findLeaf(dir, rootId, value) {
    let page = await this.readPage(dir, rootId);
    if (!page) throw Object.assign(new Error('B+ tree root missing.'), { status: 500 });
    while (page.type === 'internal') {
      let child = 0;
      while (child < page.separators.length && compare(value, page.separators[child]) >= 0) child++;
      page = await this.readPage(dir, page.children[child]);
    }
    return page;
  }

  async range(collection, field, min = null, max = null, limit = 1000) {
    const dir = this.dir(collection, field);
    const manifest = await readJson(path.join(dir, 'manifest.json'), null);
    if (!manifest) throw Object.assign(new Error('B+ tree not built.'), { status: 404 });
    limit = Math.min(10000, Math.max(1, Number(limit || 1000)));
    let page = min == null ? await this.readPage(dir, manifest.firstLeaf) : await this.findLeaf(dir, manifest.rootPage, min);
    const ids = [];
    let pagesRead = 0;
    while (page && ids.length < limit) {
      pagesRead++;
      for (const entry of page.entries) {
        if (min != null && compare(entry.key, min) < 0) continue;
        if (max != null && compare(entry.key, max) > 0) return { ...manifest, min, max, ids, pagesRead, truncated: ids.length >= limit };
        ids.push(entry.id);
        if (ids.length >= limit) break;
      }
      page = page.next ? await this.readPage(dir, page.next) : null;
    }
    return { ...manifest, min, max, ids, pagesRead, truncated: ids.length >= limit };
  }
}

function tokenize(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s_-]+/g, ' ').split(/\s+/).filter(token => token.length > 1).slice(0, 10000);
}

class JsonFullTextIndex {
  constructor(engine) {
    this.engine = engine;
    this.root = path.join(engine.data, 'advanced', 'fulltext');
  }

  file(collection, name) { return path.join(this.root, collection, `${name}.json`); }

  async build(collection, name, fields) {
    fields = [...new Set((fields || []).map(String))];
    if (!fields.length) throw Object.assign(new Error('Full-text index needs fields.'), { status: 400 });
    const rows = await this.engine.readAt(collection);
    const postings = {};
    const docLengths = {};
    let totalLength = 0;
    for (const row of rows) {
      const tokens = tokenize(fields.map(field => get(row, field)).join(' '));
      docLengths[row.id] = tokens.length;
      totalLength += tokens.length;
      const tf = new Map();
      for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
      for (const [token, count] of tf) (postings[token] ||= []).push([row.id, count]);
    }
    const index = {
      type: 'json-inverted-index', collection, name, fields, builtAt: now(), documents: rows.length,
      averageDocumentLength: rows.length ? totalLength / rows.length : 0,
      docLengths, postings
    };
    await ensureDir(path.dirname(this.file(collection, name)));
    await atomicJson(this.file(collection, name), index);
    return { collection, name, fields, documents: rows.length, terms: Object.keys(postings).length, averageDocumentLength: index.averageDocumentLength };
  }

  async search(collection, name, query, limit = 50) {
    const index = await readJson(this.file(collection, name), null);
    if (!index) throw Object.assign(new Error('Full-text index not built.'), { status: 404 });
    const terms = [...new Set(tokenize(query))];
    const N = index.documents || 1;
    const avgdl = index.averageDocumentLength || 1;
    const scores = new Map();
    const k1 = 1.2, b = 0.75;
    for (const term of terms) {
      const posting = index.postings[term] || [];
      const df = posting.length;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const [id, tf] of posting) {
        const dl = index.docLengths[id] || 0;
        const score = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl)));
        scores.set(id, (scores.get(id) || 0) + score);
      }
    }
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.min(500, Math.max(1, Number(limit || 50))));
    const wanted = new Map(ranked);
    const rows = (await this.engine.readAt(collection)).filter(row => wanted.has(row.id)).map(row => ({ score: wanted.get(row.id), row })).sort((a, b) => b.score - a.score);
    return { collection, index: name, query, terms, algorithm: 'BM25-ish over JSON postings', rows };
  }
}

module.exports = { JsonBPlusTree, JsonFullTextIndex, tokenize };
