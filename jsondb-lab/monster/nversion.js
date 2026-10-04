'use strict';

const crypto = require('crypto');
const { canonical } = require('./truth');

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function digest(v) { return crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex'); }
function stripVolatile(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k,v] of Object.entries(row)) {
    if (['createdAt','updatedAt','_mvcc'].includes(k)) continue;
    out[k] = clone(v);
  }
  return out;
}
function normalizeWorld(state) {
  const out = {};
  for (const [name, rows] of Object.entries(state)) out[name] = rows.map(stripVolatile).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  return out;
}

function freezeOps(ops) {
  return (ops || []).map(op => {
    const x = clone(op);
    if (x.type === 'insert') {
      x.row ||= {};
      x.row.id ||= crypto.randomUUID();
    }
    return x;
  });
}

function reduceArray(snapshot, ops) {
  const state = clone(snapshot);
  for (const op of ops) {
    const rows = state[op.collection];
    if (!rows) throw new Error(`array reducer missing collection ${op.collection}`);
    if (op.type === 'insert') {
      if (rows.some(r => r.id === op.row.id)) throw new Error(`array reducer duplicate id ${op.row.id}`);
      rows.push(stripVolatile(op.row));
    } else if (op.type === 'update') {
      const i = rows.findIndex(r => r.id === op.id);
      if (i < 0) throw new Error(`array reducer row not found ${op.id}`);
      rows[i] = stripVolatile({ ...rows[i], ...(op.patch || {}), id: rows[i].id });
    } else if (op.type === 'delete') {
      const i = rows.findIndex(r => r.id === op.id);
      if (i < 0) throw new Error(`array reducer row not found ${op.id}`);
      rows.splice(i,1);
    } else throw new Error(`array reducer unknown op ${op.type}`);
  }
  return normalizeWorld(state);
}

function reduceMap(snapshot, ops) {
  const maps = {};
  for (const [name, rows] of Object.entries(snapshot)) maps[name] = new Map(rows.map(r => [r.id, stripVolatile(r)]));
  for (const op of ops) {
    const map = maps[op.collection];
    if (!map) throw new Error(`map reducer missing collection ${op.collection}`);
    if (op.type === 'insert') {
      if (map.has(op.row.id)) throw new Error(`map reducer duplicate id ${op.row.id}`);
      map.set(op.row.id, stripVolatile(op.row));
    } else if (op.type === 'update') {
      if (!map.has(op.id)) throw new Error(`map reducer row not found ${op.id}`);
      map.set(op.id, stripVolatile({ ...map.get(op.id), ...(op.patch || {}), id: op.id }));
    } else if (op.type === 'delete') {
      if (!map.delete(op.id)) throw new Error(`map reducer row not found ${op.id}`);
    } else throw new Error(`map reducer unknown op ${op.type}`);
  }
  return Object.fromEntries(Object.entries(maps).map(([name,map]) => [name, [...map.values()].sort((a,b)=>String(a.id).localeCompare(String(b.id)))]));
}

function reduceDictionary(snapshot, ops) {
  const state = {};
  for (const [name, rows] of Object.entries(snapshot)) {
    state[name] = { order: rows.map(r=>r.id), byId: Object.fromEntries(rows.map(r => [r.id, stripVolatile(r)])) };
  }
  for (const op of ops) {
    const table = state[op.collection];
    if (!table) throw new Error(`dictionary reducer missing collection ${op.collection}`);
    if (op.type === 'insert') {
      if (Object.prototype.hasOwnProperty.call(table.byId, op.row.id)) throw new Error(`dictionary reducer duplicate id ${op.row.id}`);
      table.byId[op.row.id] = stripVolatile(op.row); table.order.push(op.row.id);
    } else if (op.type === 'update') {
      const old = table.byId[op.id];
      if (!old) throw new Error(`dictionary reducer row not found ${op.id}`);
      table.byId[op.id] = stripVolatile(Object.assign({}, old, op.patch || {}, { id: op.id }));
    } else if (op.type === 'delete') {
      if (!table.byId[op.id]) throw new Error(`dictionary reducer row not found ${op.id}`);
      delete table.byId[op.id]; table.order = table.order.filter(id => id !== op.id);
    } else throw new Error(`dictionary reducer unknown op ${op.type}`);
  }
  const out = {};
  for (const [name, table] of Object.entries(state)) out[name] = Object.values(table.byId).map(stripVolatile).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  return out;
}

class NVersionMutationGuard {
  constructor(engine, savior = null) {
    this.engine = engine;
    this.savior = savior;
  }

  async snapshot(touched) {
    const state = {};
    for (const name of touched) state[name] = (await this.engine.loadCurrent(name)).rows.map(stripVolatile);
    return normalizeWorld(state);
  }

  async preflight(ops, options = {}) {
    const frozenOps = freezeOps(ops);
    const touched = [...new Set(frozenOps.map(x => x.collection))].sort();
    const snapshot = await this.snapshot(touched);
    const reducers = [
      { name: 'array-positional', fn: reduceArray },
      { name: 'map-identity', fn: reduceMap },
      { name: 'dictionary-event-fold', fn: reduceDictionary }
    ];
    const executions = [];
    for (const reducer of reducers) {
      try {
        const world = reducer.fn(snapshot, frozenOps);
        executions.push({ reducer: reducer.name, ok: true, hash: digest(world), world });
      } catch (error) {
        executions.push({ reducer: reducer.name, ok: false, error: error.message, hash: null, world: null });
      }
    }
    const good = executions.filter(x => x.ok);
    const unanimous = good.length === reducers.length && new Set(good.map(x => x.hash)).size === 1;
    const result = {
      format: 'JSONDB-N-VERSION-MUTATION-PREFLIGHT-1',
      unanimous, touched, frozenOps,
      baseHash: digest(snapshot), predictedHash: unanimous ? good[0].hash : null,
      executions: executions.map(({world,...x})=>x),
      predictedWorld: unanimous ? good[0].world : null,
      doctrine: 'Three separately implemented mutation reducers must agree before protected commit. Volatile timestamps are excluded; insert IDs are frozen once before simulation.'
    };
    if (!unanimous && this.savior && options.freezeOnDivergence !== false) await this.savior.setMode('read-only', 'N-version mutation reducers diverged before commit.');
    return result;
  }

  async postflight(preflight, options = {}) {
    if (!preflight?.unanimous) return { match: false, reason: 'preflight was not unanimous' };
    const live = await this.snapshot(preflight.touched || []);
    const liveHash = digest(live);
    const match = liveHash === preflight.predictedHash;
    const result = {
      format: 'JSONDB-N-VERSION-MUTATION-POSTFLIGHT-1',
      match, predictedHash: preflight.predictedHash, liveHash,
      touched: preflight.touched
    };
    if (!match && this.savior && options.freezeOnMismatch !== false) await this.savior.setMode('read-only', `N-version predicted world ${preflight.predictedHash} != live ${liveHash}`);
    return result;
  }
}

module.exports = {
  NVersionMutationGuard, freezeOps, stripVolatile,
  reduceArray, reduceMap, reduceDictionary, digest
};
