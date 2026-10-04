'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

class PhysicalFailureDomainInspector {
  async inspect(root) {
    const absolute = path.resolve(root);
    await ensureDir(absolute);
    const real = await fsp.realpath(absolute).catch(() => absolute);
    const stat = await fsp.stat(real);
    let statfs = null;
    if (typeof fsp.statfs === 'function') {
      try {
        const s = await fsp.statfs(real);
        statfs = {
          type: String(s.type), bsize: Number(s.bsize), blocks: Number(s.blocks),
          bfree: Number(s.bfree), bavail: Number(s.bavail), files: Number(s.files), ffree: Number(s.ffree)
        };
      } catch {}
    }
    const device = Number(stat.dev);
    const deviceKey = Number.isFinite(device) && device !== 0
      ? `${process.platform}:dev:${device}`
      : `${process.platform}:realpath-root:${path.parse(real).root}`;
    return {
      root: absolute, realpath: real, platform: process.platform,
      device, deviceKey, deviceFingerprint: hash(deviceKey).slice(0, 20),
      statfs,
      note: 'OS device identifiers are useful evidence, not proof of independent physical hardware. RAID, virtualization, network mounts, and storage controllers can hide common failure domains.'
    };
  }

  async compare(roots) {
    const inspected = [];
    for (const root of roots) inspected.push(await this.inspect(root));
    const groups = new Map();
    for (const item of inspected) {
      const slot = groups.get(item.deviceKey) || [];
      slot.push(item.root); groups.set(item.deviceKey, slot);
    }
    const domains = [...groups.entries()].map(([deviceKey, paths]) => ({ deviceKey, fingerprint: hash(deviceKey).slice(0,20), paths, count: paths.length }));
    const collisions = domains.filter(x => x.count > 1);
    return {
      format: 'JSONDB-PHYSICAL-FAILURE-DOMAIN-1', at: now(),
      roots: inspected.length, distinctDeviceKeys: domains.length,
      apparentIndependenceRatio: inspected.length ? domains.length / inspected.length : 0,
      domains, collisions, inspected,
      warning: 'Distinct device keys increase confidence but do not prove independent power, controller, site, or operator failure domains.'
    };
  }
}

class FailureDomainRegistry {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'media-registry.json');
    this.inspector = new PhysicalFailureDomainInspector();
  }

  async init() {
    await ensureDir(this.root);
    let registry = await readJson(this.file, null);
    if (!registry) {
      registry = { format: 'JSONDB-MEDIA-REGISTRY-1', createdAt: now(), media: [] };
      await atomicJson(this.file, registry);
    }
    return registry;
  }

  async register(name, root, metadata = {}) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(String(name || ''))) throw new Error('Invalid media name.');
    const registry = await this.init();
    const inspection = await this.inspector.inspect(root);
    const entry = {
      name, root: inspection.root, registeredAt: now(),
      purpose: metadata.purpose || 'survival-media',
      expectedLocation: metadata.expectedLocation || null,
      offlineByDefault: metadata.offlineByDefault === true,
      inspection
    };
    const i = registry.media.findIndex(x => x.name === name);
    if (i >= 0) registry.media[i] = entry; else registry.media.push(entry);
    registry.updatedAt = now();
    await atomicJson(this.file, registry);
    return entry;
  }

  async unregister(name) {
    const registry = await this.init();
    registry.media = registry.media.filter(x => x.name !== name);
    registry.updatedAt = now();
    await atomicJson(this.file, registry);
    return registry;
  }

  async assess() {
    const registry = await this.init();
    const live = [];
    const unavailable = [];
    for (const media of registry.media) {
      try { live.push({ ...media, inspection: await this.inspector.inspect(media.root) }); }
      catch (error) { unavailable.push({ name: media.name, root: media.root, error: error.message }); }
    }
    const comparison = await this.inspector.compare(live.map(x => x.root));
    return { registry: { ...registry, media: live }, unavailable, comparison };
  }
}

module.exports = { PhysicalFailureDomainInspector, FailureDomainRegistry };
