'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, uuid, ensureDir, exists, readJson, atomicJson, merkleRoot } = require('./jsonfs');

function sha(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

class SurvivorGenome {
  constructor({ engine, savior, orthogonal, council }) {
    this.engine = engine;
    this.savior = savior;
    this.orthogonal = orthogonal;
    this.council = council;
    this.root = path.join(savior.root, 'genome');
  }

  async init() { await ensureDir(this.root); }

  async sourceRecord(relative) {
    const file = path.join(this.engine.root, relative);
    const source = await fsp.readFile(file, 'utf8');
    return { path: relative, language: relative.endsWith('.js') ? 'javascript' : 'text', sha256: sha(source), source };
  }

  async create(label = 'survivor-genome') {
    await this.init();
    const sources = [];
    for (const relative of ['lifeboat.js','monster/erasure.js','monster/savior.js','monster/orthogonal.js','monster/jsonfs.js']) {
      if (await exists(path.join(this.engine.root, relative))) sources.push(await this.sourceRecord(relative));
    }
    const council = await this.council.init();
    const publicCouncil = { ...council, members: council.members.map(m => ({ id: m.id, publicKeyPem: m.publicKeyPem, createdAt: m.createdAt, revokedAt: m.revokedAt || null })) };
    const latestOrthogonal = await readJson(path.join(this.orthogonal.root, 'latest.json'), null);
    const inferredCatalog = await this.savior.inferCatalog();
    const sourceHashes = sources.map(x => x.sha256);
    const id = `${Date.now()}-${uuid().slice(0,8)}`;
    const genome = {
      format: 'JSONDB-SURVIVOR-GENOME-1', id, label, createdAt: now(),
      purpose: 'Plain-JSON bootstrap material for reconstructing recovery tooling when higher application layers are unavailable.',
      recoveryOrder: [
        'Verify this genome sourceMerkleRoot and individual source SHA-256 values.',
        'Extract lifeboat.js from sources[].source onto any Node.js runtime.',
        'Locate orthogonal ARK shards referenced by latestOrthogonal.',
        'Run the extracted lifeboat against the Savior root.',
        'Use inferredCatalog only as reconstruction evidence; do not silently promote guessed constraints.'
      ],
      sourceMerkleRoot: merkleRoot(sourceHashes), sources,
      witnessCouncil: publicCouncil,
      latestOrthogonal,
      inferredCatalog
    };
    const file = path.join(this.root, `${id}.json`);
    await atomicJson(file, genome);
    await atomicJson(path.join(this.root, 'latest.json'), genome);

    const replicated = [];
    await this.savior.mirrors.init();
    for (const cell of this.savior.mirrors.cells()) {
      const target = path.join(this.savior.mirrors.cellsRoot, cell, '_bootstrap', 'survivor-genome.json');
      await ensureDir(path.dirname(target));
      await atomicJson(target, genome);
      replicated.push(target);
    }
    const orthogonalCopy = path.join(this.orthogonal.root, 'SURVIVOR-GENOME.json');
    await atomicJson(orthogonalCopy, genome);
    return { id, file, sourceMerkleRoot: genome.sourceMerkleRoot, sources: sources.map(x => ({ path: x.path, sha256: x.sha256 })), replicas: replicated.length + 1 };
  }

  async verify(file = null) {
    await this.init();
    const genome = await readJson(file || path.join(this.root, 'latest.json'), null);
    if (!genome) return { valid: false, reason: 'genome missing' };
    const results = (genome.sources || []).map(src => ({ path: src.path, expected: src.sha256, actual: sha(src.source), valid: sha(src.source) === src.sha256 }));
    const root = merkleRoot((genome.sources || []).map(src => sha(src.source)));
    return { valid: results.every(x => x.valid) && root === genome.sourceMerkleRoot, id: genome.id, sourceMerkleRoot: genome.sourceMerkleRoot, computedRoot: root, results };
  }

  async extract(targetDir, file = null) {
    const genome = await readJson(file || path.join(this.root, 'latest.json'), null);
    if (!genome) throw new Error('genome missing');
    const check = await this.verify(file);
    if (!check.valid) throw new Error('genome verification failed');
    await ensureDir(targetDir);
    const written = [];
    for (const src of genome.sources) {
      const target = path.join(targetDir, src.path);
      await ensureDir(path.dirname(target));
      await fsp.writeFile(target, src.source, 'utf8');
      written.push(target);
    }
    await atomicJson(path.join(targetDir, 'RECOVERY-METADATA.json'), {
      extractedAt: now(), genomeId: genome.id, latestOrthogonal: genome.latestOrthogonal,
      witnessCouncil: genome.witnessCouncil, inferredCatalog: genome.inferredCatalog
    });
    return { genomeId: genome.id, targetDir, written };
  }
}

module.exports = { SurvivorGenome };
