'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {
  now, ensureDir, readJson, atomicJson, copyDir, listFilesRecursive, hashFile, merkleRoot
} = require('./jsonfs');
const { FailureDomainRegistry } = require('./failuredomains');

function safe(value) { return String(value || 'export').replace(/[^A-Za-z0-9_.-]/g, '_'); }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

class MediaConstellation {
  constructor({ savior, civilizationSeed, fountain, registry = null }) {
    this.savior = savior;
    this.seed = civilizationSeed;
    this.fountain = fountain;
    this.root = path.join(savior.root, 'media-constellation');
    this.registry = registry || new FailureDomainRegistry(path.join(this.root, 'registry'));
    this.receipts = path.join(this.root, 'receipts');
  }

  async init() { await ensureDir(this.receipts); await this.registry.init(); }
  async register(name, root, metadata = {}) { await this.init(); return this.registry.register(name, root, metadata); }
  async assess() { await this.init(); return this.registry.assess(); }

  async manifestDirectory(dir) {
    const files = await listFilesRecursive(dir);
    const entries = [];
    for (const file of files) entries.push({ path: path.relative(dir, file).split(path.sep).join('/'), sha256: await hashFile(file), bytes: (await fsp.stat(file)).size });
    entries.sort((a,b)=>a.path.localeCompare(b.path));
    return { files: entries.length, bytes: entries.reduce((n,x)=>n+x.bytes,0), merkleRoot: merkleRoot(entries.map(x=>x.sha256)), entries };
  }

  async exportSeed(options = {}) {
    await this.init();
    const assessment = await this.registry.assess();
    const media = assessment.registry.media || [];
    if (!media.length) throw new Error('Media Constellation has no available registered media.');
    let seedRef = options.seedId ? { id: options.seedId, directory: path.join(this.seed.root, options.seedId) } : await readJson(path.join(this.seed.root, 'latest.json'), null);
    if (!seedRef || options.createNew === true) seedRef = await this.seed.create(options.label || 'constellation');
    const source = seedRef.directory || path.join(this.seed.root, seedRef.id);
    const sourceManifest = await this.manifestDirectory(source);
    const exports = [];
    for (const medium of media) {
      const target = path.join(medium.root, 'JSONDB-SURVIVAL', 'civilization-seeds', safe(seedRef.id));
      await copyDir(source, target);
      const copied = await this.manifestDirectory(target);
      const valid = copied.merkleRoot === sourceManifest.merkleRoot && copied.files === sourceManifest.files;
      const receipt = {
        format: 'JSONDB-MEDIA-SEED-COPY-1', at: now(),
        media: medium.name, deviceKey: medium.inspection.deviceKey,
        source, target, valid,
        sourceMerkleRoot: sourceManifest.merkleRoot, copiedMerkleRoot: copied.merkleRoot,
        files: copied.files, bytes: copied.bytes
      };
      await atomicJson(path.join(target, 'CONSTELLATION-COPY-RECEIPT.json'), receipt);
      exports.push(receipt);
    }
    const distinctDevices = new Set(exports.filter(x=>x.valid).map(x=>x.deviceKey)).size;
    const result = {
      format: 'JSONDB-MEDIA-CONSTELLATION-SEED-1', id: `${Date.now()}-${safe(seedRef.id)}`,
      at: now(), seedId: seedRef.id,
      copies: exports.length, validCopies: exports.filter(x=>x.valid).length,
      distinctDeviceKeys: distinctDevices,
      exports,
      domainAssessment: assessment.comparison,
      doctrine: 'Copy count and failure-domain count are different metrics. Multiple directories on one device count as one apparent device domain.'
    };
    result.receiptHash = digest(result);
    await atomicJson(path.join(this.receipts, `${result.id}.json`), result);
    await atomicJson(path.join(this.root, 'latest-seed-export.json'), result);
    return result;
  }

  async fountainGeneration(generation = null) {
    const summary = generation
      ? await readJson(path.join(this.fountain.generations, generation, 'summary.json'), null)
      : await readJson(path.join(this.fountain.root, 'latest.json'), null);
    if (!summary) throw new Error('Fountain generation not found.');
    return { summary, dir: path.join(this.fountain.generations, summary.generation) };
  }

  async scatterFountain(options = {}) {
    await this.init();
    const assessment = await this.registry.assess();
    const media = assessment.registry.media || [];
    if (!media.length) throw new Error('No available registered media for Fountain scatter.');
    const { summary, dir } = await this.fountainGeneration(options.generation || null);
    const packets = (await fsp.readdir(dir)).filter(x => /^droplet-.*\.json$/.test(x)).sort();
    if (!packets.length) throw new Error('Fountain generation has no droplet packets.');
    const copiesPerDroplet = Math.max(1, Math.min(media.length, Number(options.copiesPerDroplet || Math.min(2, media.length))));
    const placements = [];

    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i];
      for (let copy = 0; copy < copiesPerDroplet; copy++) {
        const medium = media[(i + copy) % media.length];
        const targetDir = path.join(medium.root, 'JSONDB-SURVIVAL', 'fountain', summary.generation);
        await ensureDir(targetDir);
        const source = path.join(dir, packet);
        const target = path.join(targetDir, packet);
        await fsp.copyFile(source, target);
        placements.push({
          packet, copy: copy + 1, media: medium.name,
          deviceKey: medium.inspection.deviceKey,
          target, sha256: await hashFile(target)
        });
      }
    }

    const perPacket = new Map();
    for (const p of placements) {
      const slot = perPacket.get(p.packet) || [];
      slot.push(p); perPacket.set(p.packet, slot);
    }
    const packetDiversity = [...perPacket.entries()].map(([packet, rows]) => ({
      packet, copies: rows.length, distinctDeviceKeys: new Set(rows.map(x=>x.deviceKey)).size,
      media: rows.map(x=>x.media)
    }));
    const result = {
      format: 'JSONDB-MEDIA-CONSTELLATION-FOUNTAIN-1', id: `${Date.now()}-${summary.generation}`,
      at: now(), generation: summary.generation,
      packets: packets.length, placements: placements.length,
      copiesPerDroplet,
      registeredMedia: media.length,
      distinctDeviceKeys: assessment.comparison.distinctDeviceKeys,
      packetDiversity,
      domainAssessment: assessment.comparison,
      doctrine: 'Fountain droplets are useful because media can disappear unpredictably. Placement tries to spread copies, but physical-domain evidence remains heuristic.'
    };
    result.receiptHash = digest(result);
    await atomicJson(path.join(this.receipts, `${result.id}.json`), result);
    await atomicJson(path.join(this.root, 'latest-fountain-scatter.json'), result);
    return result;
  }

  async inventory() {
    await this.init();
    const assessment = await this.registry.assess();
    const inventory = [];
    for (const medium of assessment.registry.media || []) {
      const base = path.join(medium.root, 'JSONDB-SURVIVAL');
      const files = await listFilesRecursive(base).catch(() => []);
      inventory.push({
        media: medium.name, root: medium.root,
        deviceKey: medium.inspection.deviceKey,
        files: files.length,
        bytes: (await Promise.all(files.map(file => fsp.stat(file).then(x=>x.size).catch(()=>0)))).reduce((a,b)=>a+b,0)
      });
    }
    return { format: 'JSONDB-MEDIA-CONSTELLATION-INVENTORY-1', at: now(), assessment, inventory };
  }
}

module.exports = { MediaConstellation };
