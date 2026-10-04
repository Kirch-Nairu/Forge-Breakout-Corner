'use strict';

const path = require('path');
const { now, ensureDir, readJson, atomicJson, listFilesRecursive } = require('./jsonfs');
const { ReedSolomonArk } = require('./erasure');
const { sha256 } = require('./savior');

class OrthogonalArk {
  constructor(engine, savior) {
    this.engine = engine;
    this.savior = savior;
    this.root = path.join(savior.root, 'orthogonal-ark');
    this.rs = new ReedSolomonArk(path.join(this.root, 'reed-solomon'), 6, 3);
    this.manifests = path.join(this.root, 'manifests');
  }

  async init() { await ensureDir(this.root); await ensureDir(this.manifests); await this.rs.init(); }

  async worldPayload(label = 'world') {
    const tables = {};
    for (const file of await listFilesRecursive(this.engine.current)) {
      if (!file.endsWith('.json')) continue;
      tables[path.basename(file, '.json')] = await readJson(file, null);
    }
    return {
      format: 'JSONDB-ORTHOGONAL-WORLD-1', label, capturedAt: now(),
      meta: await this.engine.meta(), catalog: await this.engine.catalog(),
      inferredCatalog: await this.savior.inferCatalog(), tables,
      saviorState: await this.savior.status()
    };
  }

  async archive(label = 'orthogonal') {
    await this.init();
    const payload = await this.worldPayload(label);
    const buffer = Buffer.from(JSON.stringify(payload));
    const worldSha256 = sha256(buffer);
    const xor = await this.savior.ark.archiveBuffer(`orthogonal:${label}`, buffer, { dataShards: 6 });
    const rs = await this.rs.archiveBuffer(`orthogonal:${label}`, buffer);
    const id = `${Date.now()}-${worldSha256.slice(0, 12)}`;
    const manifest = {
      format: 'JSONDB-ORTHOGONAL-ARK-1', id, label, createdAt: now(), worldSha256,
      encoders: {
        xor: { generation: xor.generation, dataShards: xor.dataShards, parityShards: xor.parityShards, merkleRoot: xor.merkleRoot },
        reedSolomon: { generation: rs.generation, dataShards: rs.dataShards, parityShards: rs.parityShards, merkleRoot: rs.merkleRoot }
      },
      doctrine: 'Independent recovery implementations must converge on the same world hash before recovery is called strong.'
    };
    await atomicJson(path.join(this.manifests, `${id}.json`), manifest);
    await atomicJson(path.join(this.root, 'latest.json'), manifest);
    return manifest;
  }

  async verify(id = null) {
    await this.init();
    let manifest;
    if (id) manifest = await readJson(path.join(this.manifests, `${id}.json`), null);
    else manifest = await readJson(path.join(this.root, 'latest.json'), null);
    if (!manifest) throw new Error('No orthogonal ARK manifest found.');
    const xor = await this.savior.ark.verifyAndRepair(manifest.encoders.xor.generation);
    const rs = await this.rs.verifyAndRepair(manifest.encoders.reedSolomon.generation);
    const xorHash = xor.healthy ? xor.restoredSha256 : null;
    const rsHash = rs.healthy ? rs.restoredSha256 : null;
    const bothHealthy = Boolean(xorHash && rsHash);
    const agree = bothHealthy && xorHash === rsHash && xorHash === manifest.worldSha256;
    const oneHealthy = Boolean(xorHash || rsHash);
    let status = 'LOST';
    if (agree) status = 'STRONG';
    else if (oneHealthy && (xorHash === manifest.worldSha256 || rsHash === manifest.worldSha256)) status = 'DEGRADED';
    else if (bothHealthy && xorHash !== rsHash) status = 'DISAGREEMENT';
    return {
      id: manifest.id, status, expected: manifest.worldSha256,
      xor: { healthy: xor.healthy, hash: xorHash, damaged: xor.damaged, repaired: xor.repaired },
      reedSolomon: { healthy: rs.healthy, hash: rsHash, damaged: rs.damaged, repaired: rs.repaired, tolerance: rs.tolerance },
      independentAgreement: agree,
      safeToRestoreAutomatically: agree
    };
  }

  async restore(target, id = null, options = {}) {
    const verdict = await this.verify(id);
    if (verdict.status === 'DISAGREEMENT' || verdict.status === 'LOST') throw new Error(`Orthogonal recovery refused: ${verdict.status}`);
    if (verdict.status === 'DEGRADED' && options.allowDegraded !== true) throw new Error('Only one independent decoder survived. Pass allowDegraded=true for an explicit operator override.');
    const manifest = id ? await readJson(path.join(this.manifests, `${id}.json`), null) : await readJson(path.join(this.root, 'latest.json'), null);
    if (verdict.xor.healthy) return { verdict, restore: await this.savior.ark.restore(manifest.encoders.xor.generation, target), decoder: 'xor' };
    return { verdict, restore: await this.rs.restore(manifest.encoders.reedSolomon.generation, target), decoder: 'reed-solomon' };
  }
}

module.exports = { OrthogonalArk };
