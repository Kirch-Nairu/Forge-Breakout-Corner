'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');
const { canonical } = require('./truth');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function same(a, b) { return digest(a) === digest(b); }
function refName(value) {
  const name = String(value || 'main');
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new Error('Invalid World Tree ref name.');
  return name;
}

class WorldTree {
  constructor({ memoryPalace, savior }) {
    this.memory = memoryPalace;
    this.savior = savior;
    this.root = path.join(savior.root, 'world-tree');
    this.commits = path.join(this.root, 'commits');
    this.refs = path.join(this.root, 'refs');
    this.merges = path.join(this.root, 'merge-sandboxes');
  }

  async init() {
    await ensureDir(this.commits);
    await ensureDir(this.refs);
    await ensureDir(this.merges);
  }

  commitFile(id) { return path.join(this.commits, `${id}.json`); }
  refFile(name) { return path.join(this.refs, `${refName(name)}.json`); }

  async ref(name) { return readJson(this.refFile(name), null); }

  async commitCurrent(label = 'world-commit', ref = 'main', metadata = {}) {
    await this.init();
    ref = refName(ref);
    const parentRef = await this.ref(ref);
    const memory = await this.memory.snapshot(`world-tree:${ref}:${label}`);
    const body = {
      format: 'JSONDB-WORLD-TREE-COMMIT-1',
      createdAt: now(), label, ref,
      parents: parentRef?.commit ? [parentRef.commit] : [],
      memoryPalaceId: memory.id,
      worldSha256: memory.worldSha256,
      chunkMerkleRoot: memory.chunkMerkleRoot,
      metadata
    };
    body.id = digest(body).slice(0, 40);
    await atomicJson(this.commitFile(body.id), body);
    await atomicJson(this.refFile(ref), { format: 'JSONDB-WORLD-TREE-REF-1', ref, commit: body.id, updatedAt: now(), worldSha256: body.worldSha256 });
    return body;
  }

  async resolve(value) {
    await this.init();
    const maybeRef = await this.ref(value).catch(() => null);
    const id = maybeRef?.commit || String(value || '');
    const commit = await readJson(this.commitFile(id), null);
    if (!commit) throw new Error(`World Tree commit/ref not found: ${value}`);
    return commit;
  }

  async branch(name, from = 'main') {
    await this.init();
    name = refName(name);
    const source = await this.resolve(from);
    const ref = { format: 'JSONDB-WORLD-TREE-REF-1', ref: name, commit: source.id, updatedAt: now(), branchedFrom: from, worldSha256: source.worldSha256 };
    await atomicJson(this.refFile(name), ref);
    return ref;
  }

  async world(commitOrRef) {
    const commit = typeof commitOrRef === 'object' ? commitOrRef : await this.resolve(commitOrRef);
    const verification = await this.memory.verify(commit.memoryPalaceId);
    if (!verification.valid || !verification._buffer) throw new Error(`Memory Palace world for commit ${commit.id} is unavailable or invalid.`);
    let world;
    try { world = JSON.parse(verification._buffer.toString('utf8')); }
    catch (error) { throw new Error(`World Tree commit ${commit.id} contains non-JSON world bytes: ${error.message}`); }
    return { commit, world: canonical(world), verification };
  }

  async ancestors(start) {
    const first = await this.resolve(start);
    const distance = new Map([[first.id, 0]]);
    const queue = [first];
    while (queue.length) {
      const current = queue.shift();
      const d = distance.get(current.id);
      for (const parentId of current.parents || []) {
        if (distance.has(parentId)) continue;
        const parent = await readJson(this.commitFile(parentId), null);
        if (!parent) continue;
        distance.set(parentId, d + 1);
        queue.push(parent);
      }
    }
    return distance;
  }

  async commonAncestor(a, b) {
    const aa = await this.ancestors(a);
    const bb = await this.ancestors(b);
    const common = [...aa.keys()].filter(id => bb.has(id)).map(id => ({ id, score: aa.get(id) + bb.get(id), a: aa.get(id), b: bb.get(id) }));
    common.sort((x,y)=>x.score-y.score || x.id.localeCompare(y.id));
    return common[0] || null;
  }

  rowMap(table) { return new Map((table?.rows || []).filter(x => x && typeof x.id === 'string').map(row => [row.id, row])); }

  mergeValue(base, ours, theirs, pathLabel, conflicts) {
    if (same(ours, theirs)) return clone(ours);
    if (same(ours, base)) return clone(theirs);
    if (same(theirs, base)) return clone(ours);

    const objectish = value => value && typeof value === 'object' && !Array.isArray(value);
    if (objectish(base) && objectish(ours) && objectish(theirs)) {
      const out = {};
      const keys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
      for (const key of [...keys].sort()) {
        const hasB = Object.prototype.hasOwnProperty.call(base, key);
        const hasO = Object.prototype.hasOwnProperty.call(ours, key);
        const hasT = Object.prototype.hasOwnProperty.call(theirs, key);
        const b = hasB ? base[key] : undefined;
        const o = hasO ? ours[key] : undefined;
        const t = hasT ? theirs[key] : undefined;
        if (!hasO && !hasT) continue;
        if (!hasO && same(t, b)) continue;
        if (!hasT && same(o, b)) continue;
        if (!hasO && !same(t, b)) { conflicts.push({ path: `${pathLabel}.${key}`, type: 'DELETE_MODIFY', base: b, ours: undefined, theirs: t }); continue; }
        if (!hasT && !same(o, b)) { conflicts.push({ path: `${pathLabel}.${key}`, type: 'MODIFY_DELETE', base: b, ours: o, theirs: undefined }); continue; }
        out[key] = this.mergeValue(b, o, t, `${pathLabel}.${key}`, conflicts);
      }
      return out;
    }

    conflicts.push({ path: pathLabel, type: 'VALUE_CONFLICT', base, ours, theirs });
    return clone(ours);
  }

  mergeTables(baseTable, oursTable, theirsTable, collection, conflicts) {
    const base = this.rowMap(baseTable);
    const ours = this.rowMap(oursTable);
    const theirs = this.rowMap(theirsTable);
    const ids = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    const rows = [];
    for (const id of [...ids].sort()) {
      const b = base.get(id);
      const o = ours.get(id);
      const t = theirs.get(id);
      if (o && t) rows.push(this.mergeValue(b || {}, o, t, `${collection}/${id}`, conflicts));
      else if (!o && !t) continue;
      else if (!o) {
        if (b && same(t, b)) continue;
        if (!b) rows.push(clone(t));
        else conflicts.push({ path: `${collection}/${id}`, type: 'DELETE_MODIFY_ROW', base: b, ours: null, theirs: t });
      } else if (!t) {
        if (b && same(o, b)) continue;
        if (!b) rows.push(clone(o));
        else conflicts.push({ path: `${collection}/${id}`, type: 'MODIFY_DELETE_ROW', base: b, ours: o, theirs: null });
      }
    }
    const template = oursTable || theirsTable || baseTable || { name: collection, meta: {} };
    return { name: template.name || collection, meta: { ...(template.meta || {}), worldTreeMergedAt: now(), rows: rows.length }, rows };
  }

  async mergePreview(oursRef, theirsRef) {
    await this.init();
    const oursCommit = await this.resolve(oursRef);
    const theirsCommit = await this.resolve(theirsRef);
    const ancestor = await this.commonAncestor(oursCommit.id, theirsCommit.id);
    if (!ancestor) throw new Error('World Tree histories have no common ancestor. Use forensic comparison instead of synthetic merge.');
    const baseCommit = await this.resolve(ancestor.id);
    const [base, ours, theirs] = await Promise.all([this.world(baseCommit), this.world(oursCommit), this.world(theirsCommit)]);
    const collections = new Set([
      ...Object.keys(base.world.tables || {}),
      ...Object.keys(ours.world.tables || {}),
      ...Object.keys(theirs.world.tables || {})
    ]);
    const conflicts = [];
    const merged = {
      format: 'JSONDB-WORLD-TREE-MERGED-WORLD-1',
      catalog: this.mergeValue(base.world.catalog || {}, ours.world.catalog || {}, theirs.world.catalog || {}, 'catalog', conflicts),
      meta: this.mergeValue(base.world.meta || {}, ours.world.meta || {}, theirs.world.meta || {}, 'meta', conflicts),
      tables: {}
    };
    for (const name of [...collections].sort()) merged.tables[name] = this.mergeTables(base.world.tables?.[name], ours.world.tables?.[name], theirs.world.tables?.[name], name, conflicts);

    const mergeId = `${Date.now()}-${digest({ base: baseCommit.id, ours: oursCommit.id, theirs: theirsCommit.id, merged }).slice(0,12)}`;
    const worldFile = path.join(this.merges, `${mergeId}.world.json`);
    const evidenceFile = path.join(this.merges, `${mergeId}.evidence.json`);
    await atomicJson(worldFile, merged);
    const evidence = {
      format: 'JSONDB-WORLD-TREE-MERGE-EVIDENCE-1', mergeId, at: now(),
      base: baseCommit.id, ours: oursCommit.id, theirs: theirsCommit.id,
      commonAncestorDistance: { ours: ancestor.a, theirs: ancestor.b },
      mergedWorldHash: digest(merged),
      conflictCount: conflicts.length, conflicts,
      status: conflicts.length ? 'CONFLICTED' : 'CLEAN_PREVIEW',
      doctrine: 'Merge previews are sandbox evidence. They never move refs or replace canonical database state automatically.'
    };
    await atomicJson(evidenceFile, evidence);
    return { ...evidence, worldFile, evidenceFile };
  }

  async log(ref = 'main', limit = 100) {
    const start = await this.resolve(ref);
    const out = [];
    const queue = [start];
    const seen = new Set();
    while (queue.length && out.length < limit) {
      const commit = queue.shift();
      if (!commit || seen.has(commit.id)) continue;
      seen.add(commit.id);
      out.push(commit);
      for (const parent of commit.parents || []) queue.push(await readJson(this.commitFile(parent), null));
    }
    return out;
  }
}

module.exports = { WorldTree, digest, same };
