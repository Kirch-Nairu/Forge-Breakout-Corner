'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, uuid, ensureDir, exists, readJson, atomicJson, merkleRoot } = require('./jsonfs');

function sha(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

const DECODER_MAP = {
  'JSONDB-XOR-ARK-1': ['monster/savior.js','monster/jsonfs.js'],
  'JSONDB-RS-ARK-1': ['monster/erasure.js','monster/jsonfs.js'],
  'JSONDB-SURFACE-PARITY-ARK-1': ['monster/surfacecode.js','monster/jsonfs.js'],
  'JSONDB-TRINITY-ARK-1': ['monster/trinity.js','monster/savior.js','monster/erasure.js','monster/surfacecode.js'],
  'JSONDB-FOUNTAIN-DROPLET-1': ['monster/fountain.js'],
  'JSONDB-MEMORY-PALACE-1': ['monster/memorypalace.js','monster/jsonfs.js','monster/truth.js'],
  'JSONDB-FORMAT-POLYGLOT-CAPSULE-1': ['monster/formatpolyglot.js','monster/truth.js'],
  'JSONDB-SEMANTIC-COMMIT-1': ['monster/chronicle.js','monster/truth.js'],
  'JSONDB-CROSS-HISTORY-BRAID-1': ['monster/braid.js'],
  'JSONDB-WORLD-TREE-COMMIT-1': ['monster/worldtree.js','monster/memorypalace.js'],
  'JSONDB-CIVILIZATION-SEED-2': ['monster/seed.js','lifeboat.js','lifeboat.py']
};

class CompatibilityTimeCapsule {
  constructor(engine, savior) {
    this.engine = engine;
    this.savior = savior;
    this.root = path.join(savior.root, 'compatibility-time-capsules');
    this.generations = path.join(this.root, 'generations');
    this.migrationsFile = path.join(this.root, 'migration-registry.json');
  }

  async init() {
    await ensureDir(this.generations);
    if (!(await readJson(this.migrationsFile, null))) {
      await atomicJson(this.migrationsFile, {
        format: 'JSONDB-COMPATIBILITY-MIGRATIONS-1', createdAt: now(), migrations: [],
        doctrine: 'Migration registry describes explicit compatibility edges. Recovery never assumes latest decoders understand unknown historical formats.'
      });
    }
  }

  async source(relative) {
    const file = path.join(this.engine.root, relative);
    if (!(await exists(file))) return null;
    const source = await fsp.readFile(file, 'utf8');
    return { path: relative, sha256: sha(source), language: relative.endsWith('.py') ? 'python' : 'javascript', source };
  }

  async capture(label = 'compatibility-epoch', formats = Object.keys(DECODER_MAP)) {
    await this.init();
    const selected = [...new Set((formats || []).map(String))].sort();
    const sourcePaths = [...new Set(selected.flatMap(format => DECODER_MAP[format] || []))].sort();
    const sources = [];
    for (const relative of sourcePaths) {
      const record = await this.source(relative);
      if (record) sources.push(record);
    }
    const migrations = await readJson(this.migrationsFile, { migrations: [] });
    const id = `${Date.now()}-${uuid().slice(0,8)}`;
    const capsule = {
      format: 'JSONDB-COMPATIBILITY-TIME-CAPSULE-1', id, label, createdAt: now(),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      formats: selected.map(format => ({ format, decoders: DECODER_MAP[format] || [], supported: Boolean(DECODER_MAP[format]) })),
      sourceMerkleRoot: merkleRoot(sources.map(x => x.sha256)),
      sources,
      migrationRegistry: migrations,
      doctrine: 'Recovery should select decoder source by archive format/generation. Newer code is not automatically more correct for older evidence.'
    };
    await atomicJson(path.join(this.generations, `${id}.json`), capsule);
    await atomicJson(path.join(this.root, 'latest.json'), { id, label, createdAt: capsule.createdAt, sourceMerkleRoot: capsule.sourceMerkleRoot, formats: selected });
    return { id, label, formats: selected, sources: sources.map(x => ({ path: x.path, sha256: x.sha256, language: x.language })), sourceMerkleRoot: capsule.sourceMerkleRoot };
  }

  async verify(id = null) {
    await this.init();
    const latest = id ? { id } : await readJson(path.join(this.root, 'latest.json'), null);
    if (!latest) return { valid: false, status: 'ABSENT' };
    const capsule = await readJson(path.join(this.generations, `${latest.id}.json`), null);
    if (!capsule) return { valid: false, status: 'MISSING_CAPSULE', id: latest.id };
    const results = (capsule.sources || []).map(src => ({ path: src.path, expected: src.sha256, actual: sha(src.source), valid: sha(src.source) === src.sha256 }));
    const root = merkleRoot((capsule.sources || []).map(src => sha(src.source)));
    return {
      format: 'JSONDB-COMPATIBILITY-VERIFY-1', id: capsule.id,
      valid: results.every(x=>x.valid) && root === capsule.sourceMerkleRoot,
      expectedRoot: capsule.sourceMerkleRoot, computedRoot: root,
      runtime: capsule.runtime, formats: capsule.formats, results
    };
  }

  async extract(id, targetDirectory) {
    const capsule = await readJson(path.join(this.generations, `${id}.json`), null);
    if (!capsule) throw new Error(`Compatibility capsule not found: ${id}`);
    const verified = await this.verify(id);
    if (!verified.valid) throw new Error('Compatibility capsule failed source verification.');
    await ensureDir(targetDirectory);
    const written = [];
    for (const src of capsule.sources || []) {
      const target = path.join(targetDirectory, src.path);
      await ensureDir(path.dirname(target));
      await fsp.writeFile(target, src.source, 'utf8');
      written.push(target);
    }
    await atomicJson(path.join(targetDirectory, 'COMPATIBILITY-METADATA.json'), {
      extractedAt: now(), capsuleId: id, runtime: capsule.runtime,
      formats: capsule.formats, sourceMerkleRoot: capsule.sourceMerkleRoot,
      migrationRegistry: capsule.migrationRegistry
    });
    return { id, targetDirectory, written };
  }

  async registerMigration(spec) {
    await this.init();
    if (!spec?.from || !spec?.to) throw new Error('Migration requires from and to format identifiers.');
    const registry = await readJson(this.migrationsFile, { migrations: [] });
    const edge = {
      id: spec.id || `${String(spec.from).replace(/[^A-Za-z0-9]/g,'_')}-to-${String(spec.to).replace(/[^A-Za-z0-9]/g,'_')}`,
      from: String(spec.from), to: String(spec.to), registeredAt: now(),
      description: spec.description || '',
      reversible: spec.reversible === true,
      transformSpec: spec.transformSpec || null,
      warning: 'Registration is descriptive. Recovery tooling must explicitly implement/verify any transform before use.'
    };
    const i = registry.migrations.findIndex(x => x.id === edge.id);
    if (i >= 0) registry.migrations[i] = edge; else registry.migrations.push(edge);
    registry.updatedAt = now();
    await atomicJson(this.migrationsFile, registry);
    return edge;
  }

  async migrationPlan(from, to) {
    await this.init();
    const registry = await readJson(this.migrationsFile, { migrations: [] });
    const queue = [{ format: from, path: [] }];
    const seen = new Set([from]);
    while (queue.length) {
      const current = queue.shift();
      if (current.format === to) return { found: true, from, to, steps: current.path };
      for (const edge of registry.migrations.filter(x => x.from === current.format)) {
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        queue.push({ format: edge.to, path: [...current.path, edge] });
      }
    }
    return { found: false, from, to, steps: [], reason: 'No explicit migration path. Do not guess a transform.' };
  }
}

module.exports = { CompatibilityTimeCapsule, DECODER_MAP };
