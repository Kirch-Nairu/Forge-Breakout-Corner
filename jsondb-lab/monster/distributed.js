'use strict';

const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { now, uuid, ensureDir, readJson, atomicJson, appendJsonl, clone } = require('./jsonfs');

class DistributedJsonStore {
  constructor(engine) {
    this.engine = engine;
    this.root = path.join(engine.data, 'distributed');
    this.topologyFile = path.join(this.root, 'topology.json');
    this.coordinatorLog = path.join(this.root, 'coordinator.jsonl');
    this.txdir = path.join(this.root, 'coordinator-tx');
    this.writeTail = Promise.resolve();
  }

  queue(fn) {
    const run = this.writeTail.then(fn, fn);
    this.writeTail = run.catch(() => {});
    return run;
  }

  shardRoot(id) { return path.join(this.root, 'shards', id); }
  shardTable(id, collection) { return path.join(this.shardRoot(id), 'tables', `${collection}.json`); }
  shardPrepare(id, tx) { return path.join(this.shardRoot(id), 'prepare', `${tx}.json`); }

  async init(count = 4) {
    await ensureDir(this.root); await ensureDir(this.txdir);
    let topology = await readJson(this.topologyFile, null);
    if (!topology) {
      const shards = Array.from({ length: count }, (_, i) => ({ id: `shard-${String(i).padStart(2, '0')}`, online: true, weight: 1 }));
      topology = { version: 1, algorithm: 'rendezvous-hashing', createdAt: now(), shards };
      await atomicJson(this.topologyFile, topology);
    }
    for (const shard of topology.shards) {
      await ensureDir(path.join(this.shardRoot(shard.id), 'tables'));
      await ensureDir(path.join(this.shardRoot(shard.id), 'prepare'));
    }
    await this.recover();
    return topology;
  }

  async topology() { return readJson(this.topologyFile, null); }

  score(key, shard) {
    const digest = crypto.createHash('sha256').update(`${key}|${shard.id}`).digest();
    return digest.readBigUInt64BE(0) * BigInt(Math.max(1, Math.floor((shard.weight || 1) * 1000)));
  }

  async route(key) {
    const topology = await this.topology();
    const online = topology.shards.filter(s => s.online);
    if (!online.length) throw Object.assign(new Error('No online shards.'), { status: 503 });
    return online.reduce((best, shard) => !best || this.score(key, shard) > this.score(key, best) ? shard : best, null);
  }

  async loadShardTable(shard, collection) {
    return readJson(this.shardTable(shard, collection), { collection, shard, revision: 0, rows: {} });
  }

  async put(collection, key, row) {
    return this.twoPhaseCommit([{ type: 'put', collection, key, row }]);
  }

  async remove(collection, key) {
    return this.twoPhaseCommit([{ type: 'delete', collection, key }]);
  }

  async get(collection, key) {
    const shard = await this.route(key);
    const table = await this.loadShardTable(shard.id, collection);
    return { shard: shard.id, key, row: table.rows[key] ?? null };
  }

  async twoPhaseCommit(ops) {
    if (!Array.isArray(ops) || !ops.length) throw Object.assign(new Error('2PC needs operations.'), { status: 400 });
    return this.queue(async () => {
      const tx = `2pc-${uuid()}`;
      const groups = new Map();
      for (const op of ops) {
        const shard = await this.route(op.key);
        if (!groups.has(shard.id)) groups.set(shard.id, []);
        groups.get(shard.id).push(op);
      }
      const coordinator = { tx, state: 'PREPARING', startedAt: now(), participants: [...groups.keys()], ops: clone(ops) };
      const coordinatorFile = path.join(this.txdir, `${tx}.json`);
      await atomicJson(coordinatorFile, coordinator);
      await appendJsonl(this.coordinatorLog, { at: now(), tx, type: 'BEGIN_2PC', participants: coordinator.participants });

      const prepared = [];
      try {
        for (const [shard, shardOps] of groups) {
          const tables = {};
          const collections = [...new Set(shardOps.map(op => op.collection))];
          for (const collection of collections) tables[collection] = await this.loadShardTable(shard, collection);
          const before = clone(tables);
          for (const op of shardOps) {
            const table = tables[op.collection];
            if (op.type === 'put') table.rows[op.key] = { ...(op.row || {}), _distributedKey: op.key, _shard: shard, _updatedAt: now() };
            else if (op.type === 'delete') delete table.rows[op.key];
            else throw Object.assign(new Error(`Unknown distributed op: ${op.type}`), { status: 400 });
          }
          await atomicJson(this.shardPrepare(shard, tx), { tx, shard, state: 'PREPARED', preparedAt: now(), before, after: tables });
          prepared.push(shard);
          await appendJsonl(this.coordinatorLog, { at: now(), tx, type: 'SHARD_PREPARED', shard });
        }

        coordinator.state = 'COMMITTING';
        await atomicJson(coordinatorFile, coordinator);
        await appendJsonl(this.coordinatorLog, { at: now(), tx, type: 'DECISION_COMMIT' });
        for (const shard of prepared) {
          const manifest = await readJson(this.shardPrepare(shard, tx), null);
          for (const [collection, table] of Object.entries(manifest.after)) {
            table.revision = Number(table.revision || 0) + 1;
            table.lastTx = tx;
            await atomicJson(this.shardTable(shard, collection), table);
          }
          manifest.state = 'COMMITTED'; manifest.committedAt = now();
          await atomicJson(this.shardPrepare(shard, tx), manifest);
          await appendJsonl(this.coordinatorLog, { at: now(), tx, type: 'SHARD_COMMITTED', shard });
        }
        coordinator.state = 'COMMITTED'; coordinator.committedAt = now();
        await atomicJson(coordinatorFile, coordinator);
        for (const shard of prepared) await fsp.unlink(this.shardPrepare(shard, tx)).catch(() => {});
        await fsp.unlink(coordinatorFile).catch(() => {});
        await appendJsonl(this.coordinatorLog, { at: now(), tx, type: 'END_2PC_COMMIT' });
        return { tx, committed: true, participants: prepared, operations: ops.length };
      } catch (error) {
        await appendJsonl(this.coordinatorLog, { at: now(), tx, type: 'DECISION_ABORT', reason: error.message });
        for (const shard of prepared) {
          const manifest = await readJson(this.shardPrepare(shard, tx), null);
          if (manifest?.before) for (const [collection, table] of Object.entries(manifest.before)) await atomicJson(this.shardTable(shard, collection), table).catch(() => {});
          await fsp.unlink(this.shardPrepare(shard, tx)).catch(() => {});
        }
        await fsp.unlink(coordinatorFile).catch(() => {});
        throw error;
      }
    });
  }

  async recover() {
    const coordinators = (await fsp.readdir(this.txdir).catch(() => [])).filter(f => f.endsWith('.json'));
    const recovered = [];
    for (const file of coordinators) {
      const coordinatorFile = path.join(this.txdir, file);
      const tx = await readJson(coordinatorFile, null);
      if (!tx) continue;
      if (tx.state === 'COMMITTING') {
        for (const shard of tx.participants || []) {
          const manifest = await readJson(this.shardPrepare(shard, tx.tx), null);
          if (!manifest?.after) continue;
          for (const [collection, table] of Object.entries(manifest.after)) await atomicJson(this.shardTable(shard, collection), table);
          await fsp.unlink(this.shardPrepare(shard, tx.tx)).catch(() => {});
        }
        await appendJsonl(this.coordinatorLog, { at: now(), tx: tx.tx, type: 'RECOVER_COMMIT_2PC' });
      } else {
        for (const shard of tx.participants || []) {
          const manifest = await readJson(this.shardPrepare(shard, tx.tx), null);
          if (manifest?.before) for (const [collection, table] of Object.entries(manifest.before)) await atomicJson(this.shardTable(shard, collection), table);
          await fsp.unlink(this.shardPrepare(shard, tx.tx)).catch(() => {});
        }
        await appendJsonl(this.coordinatorLog, { at: now(), tx: tx.tx, type: 'RECOVER_ABORT_2PC' });
      }
      await fsp.unlink(coordinatorFile).catch(() => {});
      recovered.push(tx.tx);
    }
    return recovered;
  }

  async scan(collection) {
    const topology = await this.topology();
    const shards = [];
    for (const shard of topology.shards) {
      const table = await this.loadShardTable(shard.id, collection);
      shards.push({ shard: shard.id, online: shard.online, rows: Object.values(table.rows) });
    }
    return { collection, shards, rows: shards.flatMap(s => s.rows) };
  }

  async mapReduce(collection, field, op = 'count') {
    const scan = await this.scan(collection);
    const partials = scan.shards.map(shard => {
      const groups = {};
      for (const row of shard.rows) {
        const value = row[field] ?? null;
        const k = JSON.stringify(value);
        const g = groups[k] ||= { value, count: 0, sum: 0 };
        g.count++;
        if (typeof value === 'number') g.sum += value;
      }
      return { shard: shard.shard, groups };
    });
    const merged = {};
    for (const partial of partials) for (const [k, group] of Object.entries(partial.groups)) {
      const target = merged[k] ||= { value: group.value, count: 0, sum: 0 };
      target.count += group.count; target.sum += group.sum;
    }
    return { collection, field, op, partials, result: Object.values(merged).map(g => ({ value: g.value, result: op === 'sum' ? g.sum : g.count })) };
  }

  async rebalance(newCount) {
    return this.queue(async () => {
      newCount = Math.min(64, Math.max(1, Number(newCount)));
      const old = await this.topology();
      const collections = new Set();
      const allRows = [];
      for (const shard of old.shards) {
        const tableDir = path.join(this.shardRoot(shard.id), 'tables');
        for (const file of await fsp.readdir(tableDir).catch(() => [])) {
          if (!file.endsWith('.json')) continue;
          const collection = file.slice(0, -5); collections.add(collection);
          const table = await this.loadShardTable(shard.id, collection);
          for (const [key, row] of Object.entries(table.rows)) allRows.push({ collection, key, row });
        }
      }
      const shards = Array.from({ length: newCount }, (_, i) => ({ id: `shard-${String(i).padStart(2, '0')}`, online: true, weight: 1 }));
      const topology = { ...old, version: old.version + 1, rebalancedAt: now(), shards };
      await atomicJson(this.topologyFile, topology);
      const shardsRoot = path.join(this.root, 'shards');
      const archive = path.join(this.root, 'rebalance-archive', `v${old.version}-${Date.now()}`);
      await ensureDir(path.dirname(archive));
      await fsp.rename(shardsRoot, archive).catch(() => {});
      for (const shard of shards) { await ensureDir(path.join(this.shardRoot(shard.id), 'tables')); await ensureDir(path.join(this.shardRoot(shard.id), 'prepare')); }
      for (let i = 0; i < allRows.length; i += 500) {
        await this.twoPhaseCommit(allRows.slice(i, i + 500).map(item => ({ type: 'put', ...item })));
      }
      await appendJsonl(this.coordinatorLog, { at: now(), type: 'REBALANCE_COMPLETE', from: old.shards.length, to: newCount, rows: allRows.length, collections: [...collections] });
      return { from: old.shards.length, to: newCount, rowsMoved: allRows.length, archive };
    });
  }
}

module.exports = { DistributedJsonStore };
