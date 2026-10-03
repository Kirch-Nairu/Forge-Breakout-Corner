'use strict';

const path = require('path');
const fsp = require('fs/promises');
const { now, ensureDir, atomicJson, readJson, listFilesRecursive, hashFile, merkleRoot } = require('./jsonfs');

class PointInTimeRecovery {
  constructor(engine) {
    this.engine = engine;
    this.root = path.join(engine.data, 'advanced', 'pitr');
  }

  async restoreToTransaction(targetTx) {
    targetTx = Number(targetTx);
    if (!Number.isFinite(targetTx) || targetTx < 0) throw Object.assign(new Error('Target transaction must be a non-negative number.'), { status: 400 });
    const catalog = await this.engine.catalog();
    const meta = await this.engine.meta();
    if (targetTx >= meta.nextTx) throw Object.assign(new Error(`Target ${targetTx} is beyond current transaction horizon ${meta.nextTx - 1}.`), { status: 400 });
    const id = `pitr-tx-${String(targetTx).padStart(10, '0')}-${Date.now()}`;
    const dir = path.join(this.root, id);
    await ensureDir(path.join(dir, 'current'));
    const collections = [];
    for (const name of Object.keys(catalog.collections)) {
      const rows = await this.engine.readAt(name, targetTx);
      const live = await this.engine.loadCurrent(name);
      const table = {
        name,
        meta: {
          ...live.meta,
          restoredAt: now(),
          restoredToTx: targetTx,
          rows: rows.length,
          warning: 'PITR sandbox reconstruction from mutation history; not promoted to live database.'
        },
        rows
      };
      await atomicJson(path.join(dir, 'current', `${name}.json`), table);
      collections.push({ name, rows: rows.length });
    }
    await atomicJson(path.join(dir, 'catalog.json'), catalog);
    await atomicJson(path.join(dir, 'meta.json'), { ...meta, restoredAt: now(), restoredToTx: targetTx, sourceNextTx: meta.nextTx });
    const files = await listFilesRecursive(dir);
    const hashes = [];
    for (const file of files) hashes.push({ file: path.relative(dir, file), sha256: await hashFile(file) });
    const manifest = { id, createdAt: now(), targetTx, sourceCurrentTx: meta.nextTx - 1, collections, files: hashes.length, merkleRoot: merkleRoot(hashes.map(x => x.sha256)), liveDatabaseTouched: false };
    await atomicJson(path.join(dir, 'restore-manifest.json'), manifest);
    return manifest;
  }

  async diffTransactions(fromTx, toTx, collection) {
    const [from, to] = await Promise.all([this.engine.readAt(collection, Number(fromTx)), this.engine.readAt(collection, Number(toTx))]);
    const a = new Map(from.map(row => [row.id, row]));
    const b = new Map(to.map(row => [row.id, row]));
    const inserted = [], deleted = [], updated = [];
    for (const [id, row] of b) {
      if (!a.has(id)) inserted.push(row);
      else if (JSON.stringify(a.get(id)) !== JSON.stringify(row)) updated.push({ id, before: a.get(id), after: row });
    }
    for (const [id, row] of a) if (!b.has(id)) deleted.push(row);
    return { collection, fromTx: Number(fromTx), toTx: Number(toTx), inserted, updated, deleted, counts: { inserted: inserted.length, updated: updated.length, deleted: deleted.length } };
  }

  async list() {
    const dirs = await fsp.readdir(this.root).catch(() => []);
    const out = [];
    for (const dir of dirs) {
      const manifest = await readJson(path.join(this.root, dir, 'restore-manifest.json'), null);
      if (manifest) out.push(manifest);
    }
    return out.sort((a, b) => b.targetTx - a.targetTx);
  }
}

module.exports = { PointInTimeRecovery };
