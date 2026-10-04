'use strict';

const fsp = require('fs/promises');
const path = require('path');
const {
  now, ensureDir, exists, readJson, atomicJson, listFilesRecursive, merkleRoot, hashFile
} = require('./jsonfs');

function safe(value) { return String(value || 'seed').replace(/[^A-Za-z0-9_.-]/g, '_'); }

class CivilizationSeed {
  constructor({ engine, savior, genome, council, braid, repair, polyhash = null, trinity = null, orthogonal = null, memoryPalace = null, fountain = null, formatPolyglot = null }) {
    Object.assign(this, { engine, savior, genome, council, braid, repair, polyhash, trinity, orthogonal, memoryPalace, fountain, formatPolyglot });
    this.root = path.join(savior.root, 'civilization-seeds');
  }

  async init() { await ensureDir(this.root); }

  async copyJsonIf(source, target) {
    const value = await readJson(source, null).catch(() => null);
    if (!value) return false;
    await ensureDir(path.dirname(target));
    await atomicJson(target, value);
    return true;
  }

  async copyTextIf(source, target) {
    if (!(await exists(source))) return false;
    await ensureDir(path.dirname(target));
    await fsp.copyFile(source, target);
    return true;
  }

  async create(label = 'civilization-seed') {
    await this.init();
    const id = `${Date.now()}-${safe(label)}`;
    const dir = path.join(this.root, id);
    await ensureDir(dir);

    let genome = await readJson(path.join(this.genome.root, 'latest.json'), null);
    if (!genome) { await this.genome.create('civilization-seed'); genome = await readJson(path.join(this.genome.root, 'latest.json'), null); }
    if (!genome) throw new Error('Civilization Seed requires a Survivor Genome.');

    await atomicJson(path.join(dir, 'SURVIVOR-GENOME.json'), genome);
    await this.repair.init();
    await this.copyJsonIf(this.repair.file, path.join(dir, 'REPAIR-CONSTITUTION.json'));
    await this.copyJsonIf(this.braid.head, path.join(dir, 'BRAID-HEAD.json'));
    if (this.polyhash) {
      await this.polyhash.init();
      await this.copyJsonIf(this.polyhash.policyFile, path.join(dir, 'HASH-POLICY.json'));
    }

    const council = await this.council.init();
    await atomicJson(path.join(dir, 'WITNESS-PUBLIC-COUNCIL.json'), {
      format: 'JSONDB-PUBLIC-WITNESS-COUNCIL-1',
      generation: council.generation, threshold: council.threshold,
      members: (council.members || []).map(m => ({ id: m.id, publicKeyPem: m.publicKeyPem, createdAt: m.createdAt, revokedAt: m.revokedAt || null })),
      warning: 'Private witness keys are intentionally excluded from Civilization Seeds.'
    });

    const references = {
      trinity: this.trinity ? await readJson(path.join(this.trinity.root, 'latest.json'), null) : null,
      orthogonal: this.orthogonal ? await readJson(path.join(this.orthogonal.root, 'latest.json'), null) : null,
      memoryPalace: this.memoryPalace ? await readJson(path.join(this.memoryPalace.root, 'latest.json'), null) : null,
      fountain: this.fountain ? await readJson(path.join(this.fountain.root, 'latest.json'), null) : null,
      formatPolyglot: this.formatPolyglot ? await readJson(path.join(this.formatPolyglot.root, 'latest.json'), null) : null
    };
    await atomicJson(path.join(dir, 'RECOVERY-REFERENCES.json'), references);

    const sourceDir = path.join(dir, 'recovery-source');
    await ensureDir(sourceDir);
    for (const src of genome.sources || []) {
      const target = path.join(sourceDir, src.path);
      await ensureDir(path.dirname(target));
      await fsp.writeFile(target, src.source, 'utf8');
    }

    const rescueRuntimes = [];
    for (const [file, runtime, command] of [
      ['lifeboat.js', 'node', 'node lifeboat.js <savior-root>'],
      ['lifeboat.py', 'python3-stdlib', 'python3 lifeboat.py --help']
    ]) {
      const copied = await this.copyTextIf(path.join(this.engine.root, file), path.join(sourceDir, file));
      if (copied) rescueRuntimes.push({ runtime, entry: `recovery-source/${file}`, command });
    }
    await atomicJson(path.join(dir, 'RESCUE-RUNTIMES.json'), {
      format: 'JSONDB-RESCUE-RUNTIMES-1', createdAt: now(), runtimes: rescueRuntimes,
      doctrine: 'Prefer cross-runtime agreement when more than one rescue runtime is available. No package manager is required by either lifeboat.'
    });

    const registry = {
      format: 'JSONDB-SURVIVAL-FORMAT-REGISTRY-2', generatedAt: now(),
      formats: {
        survivorGenome: genome.format || 'JSONDB-SURVIVOR-GENOME-1',
        crossHistoryBraid: 'JSONDB-CROSS-HISTORY-BRAID-1',
        trinityArk: 'JSONDB-TRINITY-ARK-1',
        xorArk: 'JSONDB-XOR-ARK-1',
        reedSolomonArk: 'JSONDB-RS-ARK-1',
        surfaceParity: 'JSONDB-SURFACE-PARITY-ARK-1',
        fountainDroplet: 'JSONDB-FOUNTAIN-DROPLET-1',
        memoryPalace: 'JSONDB-MEMORY-PALACE-1',
        formatPolyglot: 'JSONDB-FORMAT-POLYGLOT-CAPSULE-1',
        semanticChronicle: 'JSONDB-SEMANTIC-COMMIT-1',
        repairConstitution: 'JSONDB-REPAIR-CONSTITUTION-1',
        bootSentinel: 'JSONDB-BOOT-SENTINEL-1',
        sovereignClock: 'JSONDB-SOVEREIGN-CLOCK-1'
      },
      principle: 'Unknown formats must not be silently coerced into known ones. Prefer explicit migration or read-only forensic inspection.'
    };
    await atomicJson(path.join(dir, 'FORMAT-REGISTRY.json'), registry);

    const bootOrder = {
      format: 'JSONDB-CIVILIZATION-BOOT-ORDER-2', generatedAt: now(),
      phases: [
        { phase: 0, name: 'PRESERVE', actions: ['Copy surviving media before modifying anything.','Do not run repair in-place on the only surviving copy.'] },
        { phase: 1, name: 'VERIFY_SEED', actions: ['Verify SEED-MANIFEST.json file hashes and Merkle root.','Verify SURVIVOR-GENOME.json source hashes.','Choose Node lifeboat.js or Python stdlib lifeboat.py from recovery-source.'] },
        { phase: 2, name: 'ESTABLISH_TRUTH', actions: ['Inspect Braid and witness public material.','Verify multiple recovery families independently.','Treat decoder disagreement as evidence, not inconvenience.'] },
        { phase: 3, name: 'RESTORE_SANDBOX', actions: ['Restore into a new directory.','Never overwrite surviving evidence during first recovery.'] },
        { phase: 4, name: 'COMPARE', actions: ['Compare semantic hashes, catalog inference, Chronicle replay, independent runtime decoders, and available archive outputs.'] },
        { phase: 5, name: 'PROMOTE_MANUALLY', actions: ['Only an operator may designate a sandbox as the new canonical world.','Automation may freeze authority; it may not silently increase authority.'] }
      ]
    };
    await atomicJson(path.join(dir, 'RECOVERY-ORDER.json'), bootOrder);

    const readme = `JSONDB CIVILIZATION SEED\n\nThis directory is deliberately self-describing recovery material.\n\nStart with RECOVERY-ORDER.json.\nVerify SEED-MANIFEST.json before trusting included source.\nRescue runtimes are listed in RESCUE-RUNTIMES.json.\nPrivate witness keys are intentionally NOT included.\nRestore into a sandbox first. Never overwrite the only surviving copy.\n\nThe term quantum-inspired elsewhere in JSONDB refers to classical speculative execution only.\n`;
    await fsp.writeFile(path.join(dir, 'READ-ME-FIRST.txt'), readme, 'utf8');

    const filesBeforeManifest = (await listFilesRecursive(dir)).filter(file => path.basename(file) !== 'SEED-MANIFEST.json');
    const entries = [];
    for (const file of filesBeforeManifest) entries.push({ path: path.relative(dir, file).split(path.sep).join('/'), sha256: await hashFile(file), bytes: (await fsp.stat(file)).size });
    entries.sort((a,b)=>a.path.localeCompare(b.path));
    const manifest = {
      format: 'JSONDB-CIVILIZATION-SEED-2', id, label, createdAt: now(),
      entries,
      merkleRoot: merkleRoot(entries.map(x => x.sha256)),
      files: entries.length,
      rescueRuntimes,
      doctrine: 'The seed contains instructions, public trust material, format identifiers, recovery-source text, and references. It is bootstrap evidence, not proof that every referenced archive still survives.'
    };
    if (this.polyhash) manifest.polyhash = await this.polyhash.envelope(manifest, { purpose: 'civilization-seed-manifest' });
    await atomicJson(path.join(dir, 'SEED-MANIFEST.json'), manifest);
    await atomicJson(path.join(this.root, 'latest.json'), { id, label, createdAt: manifest.createdAt, directory: dir, merkleRoot: manifest.merkleRoot, files: manifest.files, rescueRuntimes });
    return { id, directory: dir, merkleRoot: manifest.merkleRoot, files: manifest.files, rescueRuntimes, references: Object.fromEntries(Object.entries(references).map(([k,v])=>[k,v?.id || v?.generation || null])) };
  }

  async verify(id = null, options = {}) {
    const readOnly = options.readOnly === true;
    if (!readOnly) await this.init();
    let dir;
    if (id) dir = path.join(this.root, id);
    else {
      const latest = await readJson(path.join(this.root, 'latest.json'), null);
      if (!latest) return { valid: false, status: 'ABSENT', readOnly };
      dir = latest.directory || path.join(this.root, latest.id);
    }
    const manifest = await readJson(path.join(dir, 'SEED-MANIFEST.json'), null);
    if (!manifest) return { valid: false, status: 'MISSING_MANIFEST', readOnly, directory: dir };
    const results = [];
    for (const entry of manifest.entries || []) {
      const file = path.join(dir, entry.path);
      try {
        const actual = await hashFile(file);
        results.push({ path: entry.path, valid: actual === entry.sha256, expected: entry.sha256, actual });
      } catch (error) { results.push({ path: entry.path, valid: false, error: error.message }); }
    }
    const root = merkleRoot((manifest.entries || []).map(x => x.sha256));
    const valid = results.every(x => x.valid) && root === manifest.merkleRoot;
    let polyhash = null;
    if (this.polyhash && manifest.polyhash) {
      const copy = { ...manifest }; delete copy.polyhash;
      polyhash = await this.polyhash.verify(copy, manifest.polyhash, { readOnly });
    }
    return { format: 'JSONDB-CIVILIZATION-SEED-VERIFY-3', valid: valid && (!polyhash || polyhash.valid), status: valid ? 'INTACT' : 'DAMAGED', readOnly, directory: dir, merkleRoot: manifest.merkleRoot, computedMerkleRoot: root, results, polyhash, rescueRuntimes: manifest.rescueRuntimes || [] };
  }
}

module.exports = { CivilizationSeed };
