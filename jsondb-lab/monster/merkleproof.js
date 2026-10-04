'use strict';

const crypto = require('crypto');
const path = require('path');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');
const { canonicalA } = require('./canonicalquorum');

function h(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function leafHash(id, row) { return h(`leaf\0${id}\0${canonicalA(row)}`); }
function parentHash(left, right) { return h(`node\0${left}\0${right}`); }
function collectionLeaf(name, root) { return h(`collection\0${name}\0${root}`); }

function buildTree(hashes) {
  if (!hashes.length) return { layers: [[h('empty')]], root: h('empty') };
  const layers = [hashes.slice()];
  while (layers.at(-1).length > 1) {
    const current = layers.at(-1);
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]; const right = current[i+1] || left;
      next.push(parentHash(left,right));
    }
    layers.push(next);
  }
  return { layers, root: layers.at(-1)[0] };
}

function proofForIndex(layers, index) {
  const proof = [];
  let cursor = index;
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level];
    const isRight = cursor % 2 === 1;
    const siblingIndex = isRight ? cursor - 1 : cursor + 1;
    const sibling = layer[siblingIndex] || layer[cursor];
    proof.push({ level, side: isRight ? 'left' : 'right', hash: sibling });
    cursor = Math.floor(cursor / 2);
  }
  return proof;
}

function applyProof(leaf, proof) {
  let current = leaf;
  for (const step of proof || []) current = step.side === 'left' ? parentHash(step.hash,current) : parentHash(current,step.hash);
  return current;
}

class MerkleProofRegistry {
  constructor(engine, savior) {
    this.engine = engine;
    this.savior = savior;
    this.root = path.join(savior.root, 'merkle-row-proofs');
    this.generations = path.join(this.root, 'generations');
  }

  async init() { await ensureDir(this.generations); }

  async buildCollection(name) {
    const table = await this.engine.loadCurrent(name);
    const rows = [...(table.rows || [])].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
    const leaves = rows.map(row => ({ id: row.id, hash: leafHash(row.id,row), rowSemanticHash: h(canonicalA(row)) }));
    const tree = buildTree(leaves.map(x=>x.hash));
    return {
      collection: name, rowCount: rows.length, tx: table.meta?.lastTx || 0,
      root: tree.root, leaves, layers: tree.layers,
      rows
    };
  }

  async buildWorld(label = 'merkle-world') {
    await this.init();
    const catalog = await this.engine.catalog();
    const collections = [];
    for (const name of Object.keys(catalog.collections || {}).sort()) collections.push(await this.buildCollection(name));
    const worldLeaves = collections.map(c => ({ collection: c.collection, hash: collectionLeaf(c.collection,c.root), collectionRoot: c.root, rowCount: c.rowCount, tx: c.tx }));
    const worldTree = buildTree(worldLeaves.map(x=>x.hash));
    const generation = `${Date.now()}-${worldTree.root.slice(0,12)}`;
    const dir = path.join(this.generations,generation);
    await ensureDir(dir);
    for (const c of collections) {
      await atomicJson(path.join(dir, `${c.collection}.json`), {
        format: 'JSONDB-COLLECTION-MERKLE-1', generation, collection: c.collection,
        root: c.root, rowCount: c.rowCount, tx: c.tx,
        leaves: c.leaves, layers: c.layers
      });
    }
    const manifest = {
      format: 'JSONDB-MERKLE-WORLD-1', generation, label, createdAt: now(),
      worldRoot: worldTree.root,
      collectionLeaves: worldLeaves,
      worldLayers: worldTree.layers,
      doctrine: 'Inclusion proofs authenticate membership relative to this generated root. A trusted root still needs independent provenance.'
    };
    await atomicJson(path.join(dir,'WORLD.json'),manifest);
    await atomicJson(path.join(this.root,'latest.json'),manifest);
    return { generation, worldRoot: manifest.worldRoot, collections: worldLeaves };
  }

  async generation(id = null) {
    const manifest = id ? await readJson(path.join(this.generations,id,'WORLD.json'),null) : await readJson(path.join(this.root,'latest.json'),null);
    if (!manifest) throw new Error('Merkle proof generation not found.');
    return manifest;
  }

  async collectionDoc(generation, collection) {
    const doc = await readJson(path.join(this.generations,generation,`${collection}.json`),null);
    if (!doc) throw new Error(`Merkle collection not found: ${collection}`);
    return doc;
  }

  async prove(collection, rowId, generationId = null) {
    const world = await this.generation(generationId);
    const doc = await this.collectionDoc(world.generation,collection);
    const index = doc.leaves.findIndex(x=>x.id===rowId);
    if (index < 0) return this.proveAbsent(collection,rowId,world.generation);
    const worldIndex = world.collectionLeaves.findIndex(x=>x.collection===collection);
    const table = await this.engine.loadCurrent(collection);
    const row = (table.rows || []).find(x=>x.id===rowId);
    if (!row) throw new Error('Row existed in Merkle generation but is absent from live table; historical row body was not embedded in the Merkle registry.');
    const leaf = doc.leaves[index];
    const proof = {
      format: 'JSONDB-MERKLE-ROW-INCLUSION-1', generation: world.generation,
      worldRoot: world.worldRoot, collection, collectionRoot: doc.root,
      rowId, row, rowSemanticHash: leaf.rowSemanticHash, leafHash: leaf.hash,
      rowProof: proofForIndex(doc.layers,index),
      collectionLeafHash: collectionLeaf(collection,doc.root),
      collectionProof: proofForIndex(world.worldLayers,worldIndex)
    };
    return proof;
  }

  async proveNeighbor(collection, rowId, doc, world) {
    const index = doc.leaves.findIndex(x=>x.id===rowId);
    if (index < 0) return null;
    const worldIndex = world.collectionLeaves.findIndex(x=>x.collection===collection);
    return {
      rowId,
      leafHash: doc.leaves[index].hash,
      rowProof: proofForIndex(doc.layers,index),
      collectionRoot: doc.root,
      collectionLeafHash: collectionLeaf(collection,doc.root),
      collectionProof: proofForIndex(world.worldLayers,worldIndex)
    };
  }

  async proveAbsent(collection, targetId, generationId = null) {
    const world = await this.generation(generationId);
    const doc = await this.collectionDoc(world.generation,collection);
    const ids = doc.leaves.map(x=>x.id);
    let insertion = 0;
    while (insertion < ids.length && ids[insertion].localeCompare(targetId) < 0) insertion++;
    const predecessor = insertion > 0 ? await this.proveNeighbor(collection,ids[insertion-1],doc,world) : null;
    const successor = insertion < ids.length ? await this.proveNeighbor(collection,ids[insertion],doc,world) : null;
    return {
      format: 'JSONDB-MERKLE-ROW-NONMEMBERSHIP-1', generation: world.generation,
      worldRoot: world.worldRoot, collection, collectionRoot: doc.root,
      targetId, predecessor, successor,
      orderingClaim: {
        afterPredecessor: predecessor ? predecessor.rowId.localeCompare(targetId) < 0 : true,
        beforeSuccessor: successor ? targetId.localeCompare(successor.rowId) < 0 : true
      },
      warning: 'This is sorted-neighbor non-membership evidence relative to the generation leaf list, not a sparse-Merkle non-membership proof.'
    };
  }

  verifyInclusion(proof) {
    if (!proof || proof.format !== 'JSONDB-MERKLE-ROW-INCLUSION-1') return { valid:false,reason:'wrong proof format' };
    const recomputedLeaf = leafHash(proof.rowId,proof.row);
    const collectionRoot = applyProof(recomputedLeaf,proof.rowProof);
    const collectionLeafHash = collectionLeaf(proof.collection,collectionRoot);
    const worldRoot = applyProof(collectionLeafHash,proof.collectionProof);
    const valid = recomputedLeaf===proof.leafHash && collectionRoot===proof.collectionRoot && worldRoot===proof.worldRoot;
    return { valid,recomputedLeaf,collectionRoot,worldRoot };
  }

  verifyNeighbor(neighbor,collection,worldRoot) {
    if (!neighbor) return true;
    const collectionRoot = applyProof(neighbor.leafHash,neighbor.rowProof);
    if (collectionRoot!==neighbor.collectionRoot) return false;
    const world = applyProof(collectionLeaf(collection,collectionRoot),neighbor.collectionProof);
    return world===worldRoot;
  }

  verifyNonmembership(proof) {
    if (!proof || proof.format!=='JSONDB-MERKLE-ROW-NONMEMBERSHIP-1') return {valid:false,reason:'wrong proof format'};
    const neighborsValid = this.verifyNeighbor(proof.predecessor,proof.collection,proof.worldRoot) && this.verifyNeighbor(proof.successor,proof.collection,proof.worldRoot);
    const orderingValid = (!proof.predecessor || proof.predecessor.rowId.localeCompare(proof.targetId)<0) && (!proof.successor || proof.targetId.localeCompare(proof.successor.rowId)<0);
    const distinct = proof.predecessor?.rowId!==proof.targetId && proof.successor?.rowId!==proof.targetId;
    return { valid: Boolean(neighborsValid&&orderingValid&&distinct), neighborsValid,orderingValid,distinct };
  }
}

module.exports = { MerkleProofRegistry, buildTree, proofForIndex, applyProof, leafHash, parentHash, collectionLeaf };
