'use strict';

const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');
const {
  now, ensureDir, readJson, atomicJson, hashValue, copyDir, listFilesRecursive, hashFile, merkleRoot
} = require('./jsonfs');
const { get, key } = require('./query');

class LockManager {
  constructor() {
    this.locks = new Map();
    this.waitFor = new Map();
    this.waiters = [];
  }

  owner(resource) { return this.locks.get(resource) || null; }

  graph() {
    return Object.fromEntries([...this.waitFor].map(([k, v]) => [k, [...v]]));
  }

  hasCycle(start) {
    const visiting = new Set();
    const visited = new Set();
    const walk = node => {
      if (visiting.has(node)) return true;
      if (visited.has(node)) return false;
      visiting.add(node);
      for (const next of this.waitFor.get(node) || []) if (walk(next)) return true;
      visiting.delete(node);
      visited.add(node);
      return false;
    };
    return walk(start);
  }

  async acquire(tx, resources, timeoutMs = 5000) {
    resources = [...new Set(resources)].sort();
    const blockedBy = new Set();
    for (const resource of resources) {
      const owner = this.owner(resource);
      if (owner && owner !== tx) blockedBy.add(owner);
    }
    if (!blockedBy.size) {
      for (const resource of resources) this.locks.set(resource, tx);
      return { tx, resources, waited: false };
    }
    this.waitFor.set(tx, blockedBy);
    if (this.hasCycle(tx)) {
      this.waitFor.delete(tx);
      const error = new Error(`Deadlock detected for ${tx}; waits for ${[...blockedBy].join(', ')}`);
      error.status = 409;
      error.code = 'JSONDB_DEADLOCK';
      throw error;
    }
    return new Promise((resolve, reject) => {
      const waiter = { tx, resources, resolve, reject, createdAt: Date.now() };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        this.waitFor.delete(tx);
        const error = new Error(`Lock timeout for ${tx}`);
        error.status = 409;
        error.code = 'JSONDB_LOCK_TIMEOUT';
        reject(error);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  release(tx) {
    for (const [resource, owner] of [...this.locks]) if (owner === tx) this.locks.delete(resource);
    this.waitFor.delete(tx);
    for (const deps of this.waitFor.values()) deps.delete(tx);
    this.drain();
  }

  drain() {
    for (const waiter of [...this.waiters]) {
      const blocked = waiter.resources.some(resource => {
        const owner = this.owner(resource);
        return owner && owner !== waiter.tx;
      });
      if (blocked) continue;
      clearTimeout(waiter.timer);
      for (const resource of waiter.resources) this.locks.set(resource, waiter.tx);
      this.waitFor.delete(waiter.tx);
      this.waiters = this.waiters.filter(item => item !== waiter);
      waiter.resolve({ tx: waiter.tx, resources: waiter.resources, waited: true, waitMs: Date.now() - waiter.createdAt });
    }
  }

  status() {
    return {
      locks: Object.fromEntries(this.locks),
      waitFor: this.graph(),
      waiters: this.waiters.map(w => ({ tx: w.tx, resources: w.resources, waitingMs: Date.now() - w.createdAt }))
    };
  }
}

class AdvancedServices {
  constructor(engine) {
    this.engine = engine;
    this.root = path.join(engine.data, 'advanced');
    this.statsDir = path.join(this.root, 'stats');
    this.bloomDir = path.join(this.root, 'bloom');
    this.partitionDir = path.join(this.root, 'partitions');
    this.backupDir = path.join(this.root, 'backups');
    this.restoreDir = path.join(this.root, 'restore-sandboxes');
    this.migrationsFile = path.join(this.root, 'migrations.json');
    this.triggersFile = path.join(this.root, 'triggers.json');
    this.preparedFile = path.join(this.root, 'prepared.json');
    this.locks = new LockManager();
    this.planCache = new Map();
  }

  async init() {
    for (const dir of [this.root, this.statsDir, this.bloomDir, this.partitionDir, this.backupDir, this.restoreDir]) await ensureDir(dir);
    if (!(await readJson(this.migrationsFile, null))) await atomicJson(this.migrationsFile, { applied: [] });
    if (!(await readJson(this.triggersFile, null))) await atomicJson(this.triggersFile, { triggers: [] });
    if (!(await readJson(this.preparedFile, null))) await atomicJson(this.preparedFile, { statements: {} });
    return this.status();
  }

  async analyze(collection) {
    const rows = await this.engine.readAt(collection);
    const fields = new Set();
    for (const row of rows) for (const field of Object.keys(row)) fields.add(field);
    const report = { collection, analyzedAt: now(), rows: rows.length, fields: {} };
    for (const field of fields) {
      const values = rows.map(row => get(row, field));
      const nonNull = values.filter(v => v !== null && v !== undefined && ['string', 'number', 'boolean'].includes(typeof v));
      const freq = new Map();
      for (const value of nonNull) freq.set(key(value), (freq.get(key(value)) || 0) + 1);
      const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([encoded, count]) => ({ encoded, count }));
      const numeric = nonNull.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
      let histogram = [];
      if (numeric.length) {
        const buckets = Math.min(10, Math.ceil(Math.sqrt(numeric.length)));
        const min = numeric[0], max = numeric[numeric.length - 1];
        const width = max === min ? 1 : (max - min) / buckets;
        histogram = Array.from({ length: buckets }, (_, i) => ({ min: min + width * i, max: i === buckets - 1 ? max : min + width * (i + 1), count: 0 }));
        for (const n of numeric) histogram[Math.min(buckets - 1, Math.floor((n - min) / width))].count++;
      }
      report.fields[field] = {
        nulls: values.length - nonNull.length,
        nonNull: nonNull.length,
        distinct: freq.size,
        selectivity: rows.length ? freq.size / rows.length : 0,
        top,
        min: numeric.length ? numeric[0] : null,
        max: numeric.length ? numeric[numeric.length - 1] : null,
        histogram
      };
    }
    await atomicJson(path.join(this.statsDir, `${collection}.json`), report);
    return report;
  }

  bloomPositions(value, bits, hashes) {
    const positions = [];
    for (let i = 0; i < hashes; i++) {
      const digest = crypto.createHash('sha256').update(`${i}:${JSON.stringify(value)}`).digest();
      positions.push(digest.readUInt32BE(0) % bits);
    }
    return positions;
  }

  async buildBloom(collection, field, bits = 32768, hashes = 7) {
    bits = Math.min(2_000_000, Math.max(1024, Number(bits)));
    hashes = Math.min(16, Math.max(1, Number(hashes)));
    const rows = await this.engine.readAt(collection);
    const buffer = Buffer.alloc(Math.ceil(bits / 8));
    let inserted = 0;
    for (const row of rows) {
      const value = get(row, field);
      if (value == null) continue;
      inserted++;
      for (const pos of this.bloomPositions(value, bits, hashes)) buffer[Math.floor(pos / 8)] |= 1 << (pos % 8);
    }
    const filter = { collection, field, bits, hashes, inserted, builtAt: now(), base64: buffer.toString('base64') };
    await atomicJson(path.join(this.bloomDir, `${collection}-${field}.json`), filter);
    return { ...filter, base64: `[${filter.base64.length} base64 chars]` };
  }

  async testBloom(collection, field, value) {
    const filter = await readJson(path.join(this.bloomDir, `${collection}-${field}.json`), null);
    if (!filter) throw Object.assign(new Error('Bloom filter not built.'), { status: 404 });
    const buffer = Buffer.from(filter.base64, 'base64');
    const maybe = this.bloomPositions(value, filter.bits, filter.hashes).every(pos => (buffer[Math.floor(pos / 8)] & (1 << (pos % 8))) !== 0);
    return { collection, field, value, maybe, verdict: maybe ? 'MAYBE PRESENT (bloom filters can lie positively)' : 'DEFINITELY ABSENT' };
  }

  async buildPartitions(collection, field, buckets = 8) {
    buckets = Math.min(256, Math.max(2, Number(buckets)));
    const rows = await this.engine.readAt(collection);
    const out = Array.from({ length: buckets }, (_, i) => ({ partition: i, rows: [] }));
    for (const row of rows) {
      const value = get(row, field);
      const digest = crypto.createHash('sha256').update(JSON.stringify(value)).digest();
      const bucket = digest.readUInt32BE(0) % buckets;
      out[bucket].rows.push(row);
    }
    const dir = path.join(this.partitionDir, collection, field);
    await ensureDir(dir);
    const manifest = { collection, field, buckets, builtAt: now(), counts: out.map(p => p.rows.length) };
    await atomicJson(path.join(dir, 'manifest.json'), manifest);
    for (const partition of out) await atomicJson(path.join(dir, `part-${String(partition.partition).padStart(4, '0')}.json`), partition);
    return manifest;
  }

  async prepare(name, query) {
    name = this.engine.safeName(name, 'prepared statement');
    const store = await readJson(this.preparedFile, { statements: {} });
    const fingerprint = hashValue(query);
    store.statements[name] = { name, query, fingerprint, preparedAt: now(), executions: store.statements[name]?.executions || 0 };
    await atomicJson(this.preparedFile, store);
    this.planCache.set(fingerprint, { preparedAt: now(), query });
    return store.statements[name];
  }

  async executePrepared(name, params = {}) {
    const store = await readJson(this.preparedFile, { statements: {} });
    const statement = store.statements[name];
    if (!statement) throw Object.assign(new Error(`Prepared statement not found: ${name}`), { status: 404 });
    const substitute = value => {
      if (typeof value === 'string' && value.startsWith('$')) return params[value.slice(1)];
      if (Array.isArray(value)) return value.map(substitute);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
      return value;
    };
    const query = substitute(statement.query);
    const result = await this.engine.query(query);
    statement.executions++;
    statement.lastExecutedAt = now();
    await atomicJson(this.preparedFile, store);
    return { prepared: name, fingerprint: statement.fingerprint, params, ...result };
  }

  async addTrigger(trigger) {
    const store = await readJson(this.triggersFile, { triggers: [] });
    const normalized = {
      id: trigger.id || `trigger-${Date.now()}`,
      collection: this.engine.safeName(trigger.collection, 'trigger collection'),
      event: trigger.event || 'insert',
      enabled: trigger.enabled !== false,
      action: trigger.action || { type: 'set', field: 'triggeredAt', value: '$now' },
      createdAt: now()
    };
    store.triggers.push(normalized);
    await atomicJson(this.triggersFile, store);
    return normalized;
  }

  async applyBeforeTriggers(ops) {
    const store = await readJson(this.triggersFile, { triggers: [] });
    const fired = [];
    const transformed = ops.map(op => {
      let next = JSON.parse(JSON.stringify(op));
      for (const trigger of store.triggers.filter(t => t.enabled && t.collection === op.collection && t.event === op.type)) {
        if (trigger.action?.type === 'set') {
          const target = op.type === 'insert' ? (next.row ||= {}) : (next.patch ||= {});
          target[trigger.action.field] = trigger.action.value === '$now' ? now() : trigger.action.value;
          fired.push(trigger.id);
        }
        if (trigger.action?.type === 'reject') {
          const error = new Error(trigger.action.message || `Rejected by trigger ${trigger.id}`);
          error.status = 409;
          throw error;
        }
      }
      return next;
    });
    return { ops: transformed, fired };
  }

  async applyMigration(migration) {
    const store = await readJson(this.migrationsFile, { applied: [] });
    const id = this.engine.safeName(migration.id, 'migration id');
    const checksum = hashValue(migration.steps || []);
    const previous = store.applied.find(item => item.id === id);
    if (previous) {
      if (previous.checksum !== checksum) throw Object.assign(new Error(`Migration checksum drift: ${id}`), { status: 409 });
      return { ...previous, skipped: true };
    }
    const appliedSteps = [];
    for (const step of migration.steps || []) {
      if (step.type === 'createCollection') appliedSteps.push(await this.engine.createCollection(step.spec));
      else if (step.type === 'alterCollection') appliedSteps.push(await this.engine.alterCollection(step.collection, step.patch));
      else if (step.type === 'backfill') {
        const rows = await this.engine.readAt(step.collection);
        let changed = 0;
        for (let i = 0; i < rows.length; i += 250) {
          const ops = rows.slice(i, i + 250)
            .filter(row => step.onlyMissing ? get(row, step.field) == null : true)
            .map(row => ({ type: 'update', collection: step.collection, id: row.id, patch: { [step.field]: step.value === '$now' ? now() : step.value } }));
          if (ops.length) { await this.engine.transact(ops); changed += ops.length; }
        }
        appliedSteps.push({ type: 'backfill', changed });
      } else throw Object.assign(new Error(`Unknown migration step: ${step.type}`), { status: 400 });
    }
    const record = { id, checksum, appliedAt: now(), steps: appliedSteps.length };
    store.applied.push(record);
    await atomicJson(this.migrationsFile, store);
    await this.engine.walEvent({ type: 'MIGRATION_APPLIED', migration: id, checksum });
    return record;
  }

  async backup() {
    const stamp = `backup-${Date.now()}`;
    const dir = path.join(this.backupDir, stamp);
    await ensureDir(dir);
    await copyDir(this.engine.current, path.join(dir, 'current'));
    await copyDir(this.engine.indexes, path.join(dir, 'indexes'));
    await copyDir(this.engine.versions, path.join(dir, 'versions'));
    await fsp.copyFile(this.engine.catalogFile, path.join(dir, 'catalog.json'));
    await fsp.copyFile(this.engine.metaFile, path.join(dir, 'meta.json'));
    await fsp.copyFile(this.engine.wal, path.join(dir, 'wal.jsonl')).catch(() => {});
    const files = await listFilesRecursive(dir);
    const hashes = [];
    for (const file of files) hashes.push({ file: path.relative(dir, file), sha256: await hashFile(file) });
    const manifest = { backup: stamp, createdAt: now(), files: hashes, merkleRoot: merkleRoot(hashes.map(h => h.sha256)) };
    await atomicJson(path.join(dir, 'manifest.json'), manifest);
    return manifest;
  }

  async restoreSandbox(backup) {
    backup = this.engine.safeName(backup, 'backup');
    const src = path.join(this.backupDir, backup);
    const manifest = await readJson(path.join(src, 'manifest.json'), null);
    if (!manifest) throw Object.assign(new Error('Backup not found.'), { status: 404 });
    const dst = path.join(this.restoreDir, `${backup}-restored-${Date.now()}`);
    await copyDir(src, dst);
    return { backup, restoredTo: dst, manifest, liveDatabaseTouched: false };
  }

  async status() {
    const [migrations, triggers, prepared] = await Promise.all([
      readJson(this.migrationsFile, { applied: [] }),
      readJson(this.triggersFile, { triggers: [] }),
      readJson(this.preparedFile, { statements: {} })
    ]);
    return {
      locks: this.locks.status(),
      migrations: migrations.applied.length,
      triggers: triggers.triggers.length,
      preparedStatements: Object.keys(prepared.statements).length,
      planCacheEntries: this.planCache.size
    };
  }
}

module.exports = { AdvancedServices, LockManager };
