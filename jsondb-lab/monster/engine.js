'use strict';

const path = require('path');
const fsp = require('fs/promises');
const {
  now, uuid, clone, ensureDir, readJson, readJsonl, atomicJson, atomicText,
  appendJsonl, hashFile, merkleRoot, listFilesRecursive, copyDir
} = require('./jsonfs');
const { executeQuery, get, key } = require('./query');

class MonsterEngine {
  constructor(root) {
    this.root = root;
    this.data = path.join(root, 'monster-data');
    this.current = path.join(this.data, 'current');
    this.indexes = path.join(this.data, 'indexes');
    this.versions = path.join(this.data, 'versions');
    this.segments = path.join(this.data, 'segments');
    this.txdir = path.join(this.data, 'tx');
    this.checkpoints = path.join(this.data, 'checkpoints');
    this.snapshots = path.join(this.data, 'snapshots');
    this.views = path.join(this.data, 'views');
    this.integrityDir = path.join(this.data, 'integrity');
    this.wal = path.join(this.data, 'wal.jsonl');
    this.catalogFile = path.join(this.data, 'catalog.json');
    this.metaFile = path.join(this.data, 'meta.json');
    this.writeTail = Promise.resolve();
    this.metrics = {
      bootedAt: now(), queries: 0, writes: 0, commits: 0, aborts: 0,
      indexScans: 0, fullScans: 0, historicalReads: 0, joins: 0,
      checkpoints: 0, compactions: 0, integrityRuns: 0
    };
  }

  queue(fn) {
    const run = this.writeTail.then(fn, fn);
    this.writeTail = run.catch(() => {});
    return run;
  }

  safeName(value, what = 'name') {
    const s = String(value || '');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(s)) throw Object.assign(new Error(`Invalid ${what}.`), { status: 400 });
    return s;
  }

  tableFile(name) { return path.join(this.current, `${this.safeName(name, 'collection')}.json`); }
  indexFile(name) { return path.join(this.indexes, `${this.safeName(name, 'collection')}.json`); }
  versionFile(name) { return path.join(this.versions, `${this.safeName(name, 'collection')}.jsonl`); }
  segmentDir(name) { return path.join(this.segments, this.safeName(name, 'collection')); }

  async init() {
    for (const dir of [this.data, this.current, this.indexes, this.versions, this.segments, this.txdir, this.checkpoints, this.snapshots, this.views, this.integrityDir]) await ensureDir(dir);
    if (!(await readJson(this.metaFile, null))) await atomicJson(this.metaFile, { engineVersion: 2, nextTx: 1, nextLsn: 1, checkpointLsn: 0, createdAt: now() });
    if (!(await readJson(this.catalogFile, null))) await atomicJson(this.catalogFile, { version: 2, createdAt: now(), collections: {}, materializedViews: {} });
    await this.recoverPreparedTransactions();
    const catalog = await this.catalog();
    if (!catalog.collections.tasks) {
      await this.createCollection({
        name: 'tasks',
        unique: ['slug'],
        indexes: [
          { name: 'tasks_slug_uq', fields: ['slug'], unique: true },
          { name: 'tasks_status', fields: ['status'] },
          { name: 'tasks_priority', fields: ['priority'] }
        ]
      });
      await this.transact([
        { type: 'insert', collection: 'tasks', row: { slug: 'past-the-limit', title: 'Turn JSON into a storage engine against its will', status: 'active', priority: 999 } },
        { type: 'insert', collection: 'tasks', row: { slug: 'sqlite-refusal', title: 'Continue refusing SQLite for scientific reasons', status: 'unwise', priority: 900 } }
      ]);
    }
    await this.rebuildAllIndexes();
    return this.status();
  }

  async meta() { return readJson(this.metaFile, { engineVersion: 2, nextTx: 1, nextLsn: 1, checkpointLsn: 0 }); }
  async catalog() { return readJson(this.catalogFile, { version: 2, collections: {}, materializedViews: {} }); }
  async loadCurrent(name) {
    const table = await readJson(this.tableFile(name), null);
    if (!table) throw Object.assign(new Error(`Collection not found: ${name}`), { status: 404 });
    return table;
  }

  async allocateTxAndLsn(count = 1) {
    const meta = await this.meta();
    const txid = meta.nextTx++;
    const firstLsn = meta.nextLsn;
    meta.nextLsn += count;
    await atomicJson(this.metaFile, meta);
    return { txid, firstLsn };
  }

  async walEvent(event) {
    const meta = await this.meta();
    const entry = { lsn: meta.nextLsn++, at: now(), ...event };
    await appendJsonl(this.wal, entry);
    await atomicJson(this.metaFile, meta);
    return entry;
  }

  normalizeIndexes(spec = {}, unique = []) {
    const indexes = [];
    const seen = new Set();
    const add = idx => {
      if (!idx?.name || !Array.isArray(idx.fields) || !idx.fields.length) return;
      const name = this.safeName(idx.name, 'index name');
      if (seen.has(name)) return;
      seen.add(name);
      indexes.push({ name, fields: idx.fields.map(String), unique: Boolean(idx.unique) });
    };
    for (const idx of spec.indexes || []) add(idx);
    for (const field of unique) add({ name: `${spec.name}_${field}_uq`.slice(0, 63), fields: [field], unique: true });
    return indexes;
  }

  async createCollection(spec) {
    return this.queue(async () => {
      const name = this.safeName(spec?.name, 'collection name');
      const catalog = await this.catalog();
      if (catalog.collections[name]) throw Object.assign(new Error(`Collection exists: ${name}`), { status: 409 });
      const unique = [...new Set((spec.unique || []).map(String))];
      const foreignKeys = (spec.foreignKeys || []).map(fk => ({
        field: String(fk.field), references: { collection: this.safeName(fk.references?.collection, 'foreign collection'), field: String(fk.references?.field || 'id') }, onDelete: fk.onDelete || 'restrict'
      }));
      const indexes = this.normalizeIndexes({ ...spec, name }, unique);
      catalog.collections[name] = { name, createdAt: now(), schemaVersion: Number(spec.schemaVersion || 1), unique, foreignKeys, indexes };
      const table = { name, meta: { createdAt: now(), updatedAt: now(), rows: 0, revision: 0, lastTx: 0 }, rows: [] };
      await atomicJson(this.tableFile(name), table);
      await atomicJson(this.catalogFile, catalog);
      await this.rebuildIndex(name, table, catalog.collections[name]);
      await this.walEvent({ type: 'DDL_CREATE_COLLECTION', collection: name, schemaVersion: catalog.collections[name].schemaVersion });
      return catalog.collections[name];
    });
  }

  async alterCollection(name, patch = {}) {
    return this.queue(async () => {
      name = this.safeName(name, 'collection');
      const catalog = await this.catalog();
      const current = catalog.collections[name];
      if (!current) throw Object.assign(new Error(`Collection not found: ${name}`), { status: 404 });
      if (patch.unique) current.unique = [...new Set(patch.unique.map(String))];
      if (patch.foreignKeys) current.foreignKeys = patch.foreignKeys.map(fk => ({ field: String(fk.field), references: { collection: this.safeName(fk.references.collection), field: String(fk.references.field || 'id') }, onDelete: fk.onDelete || 'restrict' }));
      if (patch.indexes) current.indexes = this.normalizeIndexes({ name, indexes: patch.indexes }, current.unique || []);
      current.schemaVersion = Number(current.schemaVersion || 1) + 1;
      current.alteredAt = now();
      await atomicJson(this.catalogFile, catalog);
      await this.rebuildIndex(name);
      await this.walEvent({ type: 'DDL_ALTER_COLLECTION', collection: name, schemaVersion: current.schemaVersion });
      return current;
    });
  }

  async rebuildAllIndexes() {
    const catalog = await this.catalog();
    for (const name of Object.keys(catalog.collections)) await this.rebuildIndex(name);
  }

  buildIndexDoc(table, config) {
    const doc = { collection: table.name, builtAt: now(), tx: table.meta.lastTx || 0, rowCount: table.rows.length, indexes: {} };
    for (const idx of config.indexes || []) {
      const map = {};
      for (const row of table.rows) {
        const composite = idx.fields.map(field => get(row, field));
        const k = composite.length === 1 ? key(composite[0]) : key(composite);
        (map[k] ||= []).push(row.id);
      }
      doc.indexes[idx.name] = { fields: idx.fields, unique: Boolean(idx.unique), distinct: Object.keys(map).length, map };
    }
    return doc;
  }

  async rebuildIndex(name, table = null, config = null) {
    const catalog = config ? null : await this.catalog();
    table ||= await this.loadCurrent(name);
    config ||= catalog.collections[name];
    await atomicJson(this.indexFile(name), this.buildIndexDoc(table, config));
  }

  async readIndexes(name) {
    const doc = await readJson(this.indexFile(name), { indexes: {} });
    return doc.indexes || {};
  }

  normalizeRow(row, existing = null) {
    const t = now();
    const out = { ...(existing || {}), ...(row || {}) };
    delete out.__proto__;
    delete out._mvcc;
    out.id = existing?.id || row?.id || uuid();
    out.createdAt = existing?.createdAt || row?.createdAt || t;
    out.updatedAt = t;
    return out;
  }

  async validateDatabaseState(state, catalog) {
    for (const [name, table] of Object.entries(state)) {
      const cfg = catalog.collections[name];
      for (const field of cfg.unique || []) {
        const seen = new Set();
        for (const row of table.rows) {
          const value = get(row, field);
          if (value == null) continue;
          const k = key(value);
          if (seen.has(k)) throw Object.assign(new Error(`Unique constraint failed: ${name}.${field}`), { status: 409 });
          seen.add(k);
        }
      }
      for (const idx of (cfg.indexes || []).filter(x => x.unique)) {
        const seen = new Set();
        for (const row of table.rows) {
          const values = idx.fields.map(field => get(row, field));
          if (values.some(v => v == null)) continue;
          const k = key(values);
          if (seen.has(k)) throw Object.assign(new Error(`Unique index failed: ${idx.name}`), { status: 409 });
          seen.add(k);
        }
      }
      for (const fk of cfg.foreignKeys || []) {
        const target = state[fk.references.collection];
        if (!target) throw Object.assign(new Error(`Foreign key target missing: ${fk.references.collection}`), { status: 500 });
        const values = new Set(target.rows.map(row => key(get(row, fk.references.field))));
        for (const row of table.rows) {
          const value = get(row, fk.field);
          if (value == null) continue;
          if (!values.has(key(value))) throw Object.assign(new Error(`Foreign key failed: ${name}.${fk.field} -> ${fk.references.collection}.${fk.references.field}`), { status: 409 });
        }
      }
    }
  }

  async loadDatabaseState() {
    const catalog = await this.catalog();
    const state = {};
    for (const name of Object.keys(catalog.collections)) state[name] = await this.loadCurrent(name);
    return { catalog, state };
  }

  async appendMutationHistory(collection, event) {
    await appendJsonl(this.versionFile(collection), event);
    const bucket = String(Math.floor(event.tx / 1000)).padStart(8, '0');
    const dir = this.segmentDir(collection);
    await ensureDir(dir);
    await appendJsonl(path.join(dir, `segment-${bucket}.jsonl`), event);
  }

  async transact(ops, options = {}) {
    if (!Array.isArray(ops) || !ops.length) throw Object.assign(new Error('Transaction requires operations.'), { status: 400 });
    if (ops.length > 1000) throw Object.assign(new Error('Monster transaction limit is 1000 operations because even monsters need a number.'), { status: 400 });
    return this.queue(async () => {
      const { catalog, state } = await this.loadDatabaseState();
      for (const op of ops) if (!catalog.collections[this.safeName(op.collection, 'collection')]) throw Object.assign(new Error(`Collection not found: ${op.collection}`), { status: 404 });
      const { txid } = await this.allocateTxAndLsn(0);
      const touched = [...new Set(ops.map(op => op.collection))];
      const before = Object.fromEntries(touched.map(name => [name, clone(state[name])]));
      const manifest = path.join(this.txdir, `${txid}.json`);
      await atomicJson(manifest, { txid, state: 'PREPARED', startedAt: now(), touched, before });
      await this.walEvent({ type: 'BEGIN', tx: txid, isolation: options.isolation || 'snapshot-ish', operations: ops.length });
      const mutations = [];
      const results = [];
      try {
        for (const op of ops) {
          const table = state[op.collection];
          if (op.type === 'insert') {
            const after = this.normalizeRow(op.row || {});
            if (table.rows.some(row => row.id === after.id)) throw Object.assign(new Error(`Duplicate primary key: ${after.id}`), { status: 409 });
            table.rows.push(after);
            mutations.push({ tx: txid, at: now(), op: 'insert', id: after.id, before: null, after: clone(after) });
            results.push(after);
          } else if (op.type === 'update') {
            const i = table.rows.findIndex(row => row.id === op.id);
            if (i < 0) throw Object.assign(new Error(`Row not found: ${op.id}`), { status: 404 });
            const previous = clone(table.rows[i]);
            const after = this.normalizeRow(op.patch || {}, table.rows[i]);
            table.rows[i] = after;
            mutations.push({ tx: txid, at: now(), op: 'update', id: op.id, before: previous, after: clone(after) });
            results.push(after);
          } else if (op.type === 'delete') {
            const i = table.rows.findIndex(row => row.id === op.id);
            if (i < 0) throw Object.assign(new Error(`Row not found: ${op.id}`), { status: 404 });
            const previous = table.rows.splice(i, 1)[0];
            mutations.push({ tx: txid, at: now(), op: 'delete', id: op.id, before: clone(previous), after: null });
            results.push(previous);
          } else {
            throw Object.assign(new Error(`Unknown mutation: ${op.type}`), { status: 400 });
          }
        }

        await this.validateDatabaseState(state, catalog);
        for (const name of touched) {
          const table = state[name];
          table.meta.updatedAt = now();
          table.meta.rows = table.rows.length;
          table.meta.revision = Number(table.meta.revision || 0) + 1;
          table.meta.lastTx = txid;
          await atomicJson(this.tableFile(name), table);
          await this.rebuildIndex(name, table, catalog.collections[name]);
        }
        for (const mutation of mutations) {
          const collection = ops.find((op, i) => {
            const m = mutations[i];
            return m === mutation;
          })?.collection || touched[0];
          mutation.collection = collection;
          await this.appendMutationHistory(collection, mutation);
          await this.walEvent({ type: 'MUTATION', tx: txid, collection, op: mutation.op, id: mutation.id, after: mutation.after });
        }
        await this.walEvent({ type: 'COMMIT', tx: txid, touched, mutations: mutations.length });
        await fsp.unlink(manifest).catch(() => {});
        this.metrics.writes += mutations.length;
        this.metrics.commits++;
        return { tx: txid, committed: true, touched, results };
      } catch (error) {
        for (const [name, table] of Object.entries(before)) {
          await atomicJson(this.tableFile(name), table).catch(() => {});
          await this.rebuildIndex(name, table, catalog.collections[name]).catch(() => {});
        }
        await this.walEvent({ type: 'ABORT', tx: txid, reason: error.message }).catch(() => {});
        await fsp.unlink(manifest).catch(() => {});
        this.metrics.aborts++;
        throw error;
      }
    });
  }

  async recoverPreparedTransactions() {
    const files = (await fsp.readdir(this.txdir).catch(() => [])).filter(file => file.endsWith('.json'));
    for (const file of files) {
      const full = path.join(this.txdir, file);
      const manifest = await readJson(full, null);
      if (!manifest?.before) continue;
      const catalog = await this.catalog();
      for (const [name, table] of Object.entries(manifest.before)) {
        await atomicJson(this.tableFile(name), table);
        if (catalog.collections[name]) await this.rebuildIndex(name, table, catalog.collections[name]);
      }
      await this.walEvent({ type: 'RECOVERY_ROLLBACK', tx: manifest.txid, touched: Object.keys(manifest.before) });
      await fsp.unlink(full).catch(() => {});
    }
  }

  async readAt(name, asOf = null) {
    name = this.safeName(name, 'collection');
    if (asOf == null || asOf === 'latest') return (await this.loadCurrent(name)).rows;
    const tx = Number(asOf);
    if (!Number.isFinite(tx) || tx < 0) throw Object.assign(new Error('asOf must be a transaction number.'), { status: 400 });
    this.metrics.historicalReads++;
    const events = await readJsonl(this.versionFile(name));
    const rows = new Map();
    for (const event of events) {
      if (event.__corrupt || Number(event.tx) > tx) continue;
      if (event.op === 'delete') rows.delete(event.id);
      else if (event.after) rows.set(event.id, clone(event.after));
    }
    return [...rows.values()];
  }

  async query(query) {
    this.metrics.queries++;
    const result = await executeQuery({
      query,
      readCollection: (name, asOf) => this.readAt(name, asOf),
      readIndexes: name => this.readIndexes(name)
    });
    if (result.explain.access.type === 'index-scan') this.metrics.indexScans++;
    else this.metrics.fullScans++;
    this.metrics.joins += result.explain.joins.length;
    return result;
  }

  async createMaterializedView(name, query) {
    return this.queue(async () => {
      name = this.safeName(name, 'view name');
      const result = await this.query(query);
      const catalog = await this.catalog();
      catalog.materializedViews[name] = { name, query, createdAt: catalog.materializedViews[name]?.createdAt || now(), refreshedAt: now(), rows: result.rows.length };
      await atomicJson(path.join(this.views, `${name}.json`), { meta: catalog.materializedViews[name], rows: result.rows });
      await atomicJson(this.catalogFile, catalog);
      await this.walEvent({ type: 'VIEW_REFRESH', view: name, rows: result.rows.length });
      return catalog.materializedViews[name];
    });
  }

  async refreshViews() {
    const catalog = await this.catalog();
    const refreshed = [];
    for (const [name, view] of Object.entries(catalog.materializedViews || {})) refreshed.push(await this.createMaterializedView(name, view.query));
    return refreshed;
  }

  async checkpoint() {
    return this.queue(async () => {
      const meta = await this.meta();
      const stamp = `${String(meta.nextTx).padStart(10, '0')}-${Date.now()}`;
      const dir = path.join(this.checkpoints, stamp);
      await ensureDir(dir);
      await copyDir(this.current, path.join(dir, 'current'));
      await copyDir(this.indexes, path.join(dir, 'indexes'));
      await fsp.copyFile(this.catalogFile, path.join(dir, 'catalog.json'));
      const walText = await fsp.readFile(this.wal, 'utf8').catch(() => '');
      await atomicText(path.join(dir, 'wal.jsonl'), walText);
      const lastLsn = Math.max(0, meta.nextLsn - 1);
      meta.checkpointLsn = lastLsn;
      meta.lastCheckpoint = { id: stamp, at: now(), lsn: lastLsn };
      await atomicJson(this.metaFile, meta);
      await atomicText(this.wal, `${JSON.stringify({ lsn: meta.nextLsn++, at: now(), type: 'CHECKPOINT_BASE', checkpoint: stamp, previousLsn: lastLsn })}\n`);
      await atomicJson(this.metaFile, meta);
      this.metrics.checkpoints++;
      return meta.lastCheckpoint;
    });
  }

  async compact(collection = null) {
    return this.queue(async () => {
      const catalog = await this.catalog();
      const names = collection ? [this.safeName(collection, 'collection')] : Object.keys(catalog.collections);
      const results = [];
      for (const name of names) {
        const dir = this.segmentDir(name);
        await ensureDir(dir);
        const files = (await fsp.readdir(dir).catch(() => [])).filter(file => file.startsWith('segment-') && file.endsWith('.jsonl'));
        const table = await this.loadCurrent(name);
        const base = { collection: name, compactedAt: now(), tx: table.meta.lastTx, rows: table.rows };
        await atomicJson(path.join(dir, 'base.json'), base);
        const archive = path.join(dir, 'archive', String(Date.now()));
        if (files.length) await ensureDir(archive);
        for (const file of files) await fsp.rename(path.join(dir, file), path.join(archive, file));
        await this.walEvent({ type: 'COMPACTION', collection: name, archivedSegments: files.length, rows: table.rows.length });
        results.push({ collection: name, archivedSegments: files.length, rows: table.rows.length });
      }
      this.metrics.compactions++;
      return results;
    });
  }

  async snapshot() {
    return this.queue(async () => {
      const meta = await this.meta();
      const stamp = `snapshot-tx-${String(meta.nextTx - 1).padStart(10, '0')}-${Date.now()}`;
      const dir = path.join(this.snapshots, stamp);
      await ensureDir(dir);
      await copyDir(this.current, path.join(dir, 'current'));
      await fsp.copyFile(this.catalogFile, path.join(dir, 'catalog.json'));
      await fsp.copyFile(this.metaFile, path.join(dir, 'meta.json'));
      await this.walEvent({ type: 'SNAPSHOT', snapshot: stamp });
      return { snapshot: stamp, tx: meta.nextTx - 1 };
    });
  }

  async verifyIntegrity() {
    const ignorePrefix = path.resolve(this.integrityDir);
    const files = (await listFilesRecursive(this.data)).filter(file => !path.resolve(file).startsWith(ignorePrefix));
    const entries = [];
    for (const file of files) entries.push({ file: path.relative(this.data, file), sha256: await hashFile(file) });
    const root = merkleRoot(entries.map(entry => entry.sha256));
    const report = { at: now(), algorithm: 'sha256-merkle-ish', files: entries.length, merkleRoot: root, entries };
    await atomicJson(path.join(this.integrityDir, `integrity-${Date.now()}.json`), report);
    await atomicJson(path.join(this.integrityDir, 'latest.json'), report);
    this.metrics.integrityRuns++;
    return report;
  }

  async cdc(afterLsn = 0, limit = 200) {
    const rows = await readJsonl(this.wal);
    return rows.filter(row => !row.__corrupt && Number(row.lsn || 0) > Number(afterLsn || 0)).slice(0, Math.min(2000, Math.max(1, Number(limit || 200))));
  }

  async status() {
    const [meta, catalog] = await Promise.all([this.meta(), this.catalog()]);
    const collections = [];
    for (const [name, cfg] of Object.entries(catalog.collections)) {
      const table = await this.loadCurrent(name);
      const versionStat = await fsp.stat(this.versionFile(name)).catch(() => ({ size: 0 }));
      collections.push({ name, rows: table.rows.length, revision: table.meta.revision, lastTx: table.meta.lastTx, schemaVersion: cfg.schemaVersion, indexes: (cfg.indexes || []).length, foreignKeys: (cfg.foreignKeys || []).length, versionBytes: versionStat.size });
    }
    const walStat = await fsp.stat(this.wal).catch(() => ({ size: 0 }));
    return {
      engine: 'JSONDB MONSTER MODE',
      slogan: 'We could have used SQLite.',
      engineVersion: meta.engineVersion,
      nextTx: meta.nextTx,
      nextLsn: meta.nextLsn,
      checkpointLsn: meta.checkpointLsn,
      lastCheckpoint: meta.lastCheckpoint || null,
      walBytes: walStat.size,
      collections,
      materializedViews: Object.keys(catalog.materializedViews || {}),
      metrics: clone(this.metrics),
      capabilities: [
        'JSON WAL', 'undo recovery', 'MVCC-ish time travel', 'mutation segments', 'compaction',
        'secondary/composite indexes', 'unique constraints', 'foreign keys', 'query AST',
        'cost-ish planner', 'hash joins', 'aggregates', 'materialized views', 'CDC feed',
        'checkpoints', 'snapshots', 'SHA-256 integrity manifest', 'simulated replication'
      ]
    };
  }
}

module.exports = { MonsterEngine };
