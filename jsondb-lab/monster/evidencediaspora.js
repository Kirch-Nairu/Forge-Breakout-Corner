'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson, listFilesRecursive, hashFile, merkleRoot, copyDir } = require('./jsonfs');

function safe(v) { return String(v || 'evidence').replace(/[^A-Za-z0-9_.-]/g, '_'); }
function digest(v) { return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'); }

class EvidenceDiaspora {
  constructor({ savior, constellation, polyhash = null }) {
    this.savior = savior;
    this.constellation = constellation;
    this.polyhash = polyhash;
    this.root = path.join(savior.root, 'evidence-diaspora');
    this.bundles = path.join(this.root, 'bundles');
    this.receipts = path.join(this.root, 'receipts');
  }

  async init() { await ensureDir(this.bundles); await ensureDir(this.receipts); await this.constellation.init(); }

  async manifest(dir) {
    const files = await listFilesRecursive(dir);
    const entries = [];
    for (const file of files) entries.push({ path: path.relative(dir, file).split(path.sep).join('/'), sha256: await hashFile(file), bytes: (await fsp.stat(file)).size });
    entries.sort((a,b)=>a.path.localeCompare(b.path));
    return { files: entries.length, bytes: entries.reduce((n,x)=>n+x.bytes,0), merkleRoot: merkleRoot(entries.map(x=>x.sha256)), entries };
  }

  async createBundle(label, sources = [], metadata = {}) {
    await this.init();
    const id = `${Date.now()}-${safe(label)}`;
    const dir = path.join(this.bundles, id);
    await ensureDir(dir);
    const copied = [];
    for (const sourceSpec of sources) {
      const source = typeof sourceSpec === 'string' ? sourceSpec : sourceSpec.path;
      const name = typeof sourceSpec === 'string' ? path.basename(source) : (sourceSpec.name || path.basename(source));
      try {
        const stat = await fsp.stat(source);
        const target = path.join(dir, safe(name));
        if (stat.isDirectory()) await copyDir(source, target);
        else await fsp.copyFile(source, target);
        copied.push({ source, name: safe(name), type: stat.isDirectory() ? 'directory' : 'file' });
      } catch (error) {
        copied.push({ source, name: safe(name), error: error.message });
      }
    }
    const body = {
      format: 'JSONDB-EVIDENCE-DIASPORA-BUNDLE-1', id, label, createdAt: now(), metadata,
      copied, doctrine: 'Evidence bundles contain corroboration and recovery references. A bundle is not canonical database state.'
    };
    await atomicJson(path.join(dir, 'BUNDLE.json'), body);
    const manifest = await this.manifest(dir);
    const record = { ...body, directory: dir, manifest };
    record.bundleHash = digest(record);
    if (this.polyhash) record.polyhash = await this.polyhash.envelope(record, { purpose: 'evidence-diaspora-bundle' });
    await atomicJson(path.join(dir, 'BUNDLE-MANIFEST.json'), record);
    await atomicJson(path.join(this.root, 'latest-bundle.json'), { id, directory: dir, merkleRoot: manifest.merkleRoot, bundleHash: record.bundleHash });
    return record;
  }

  domainKey(medium) {
    const device = medium.inspection?.deviceKey || `unknown:${medium.name}`;
    const location = medium.expectedLocation || 'location-unknown';
    return { device, location, composite: `${location}|${device}` };
  }

  placementOrder(media) {
    const rows = media.map(m => ({ medium: m, domain: this.domainKey(m) }));
    const chosen = [];
    const usedDevices = new Set(), usedLocations = new Set();
    for (const row of rows) {
      if (!usedDevices.has(row.domain.device) && !usedLocations.has(row.domain.location)) {
        chosen.push({ ...row, tier: 'NEW_DEVICE_AND_LOCATION' });
        usedDevices.add(row.domain.device); usedLocations.add(row.domain.location);
      }
    }
    for (const row of rows) {
      if (chosen.some(x => x.medium.name === row.medium.name)) continue;
      if (!usedDevices.has(row.domain.device)) {
        chosen.push({ ...row, tier: 'NEW_DEVICE' }); usedDevices.add(row.domain.device); usedLocations.add(row.domain.location);
      }
    }
    for (const row of rows) if (!chosen.some(x => x.medium.name === row.medium.name)) chosen.push({ ...row, tier: 'CORRELATED_OVERFLOW' });
    return chosen;
  }

  async scatter(bundleId = null, options = {}) {
    await this.init();
    const latest = bundleId ? { id: bundleId, directory: path.join(this.bundles, bundleId) } : await readJson(path.join(this.root, 'latest-bundle.json'), null);
    if (!latest) throw new Error('No evidence bundle exists.');
    const source = latest.directory || path.join(this.bundles, latest.id);
    const sourceManifest = await this.manifest(source);
    const assessment = await this.constellation.assess();
    const media = assessment.registry.media || [];
    if (!media.length) throw new Error('Evidence Diaspora has no registered media targets.');
    const ordered = this.placementOrder(media);
    const targetCopies = Math.max(1, Math.min(ordered.length, Number(options.copies || ordered.length)));
    const placements = [];
    for (const row of ordered.slice(0, targetCopies)) {
      const target = path.join(row.medium.root, 'JSONDB-SURVIVAL', 'evidence-diaspora', safe(latest.id));
      await copyDir(source, target);
      const copied = await this.manifest(target);
      placements.push({
        media: row.medium.name, root: row.medium.root, target,
        tier: row.tier, deviceKey: row.domain.device, expectedLocation: row.domain.location,
        valid: copied.merkleRoot === sourceManifest.merkleRoot,
        copiedMerkleRoot: copied.merkleRoot
      });
    }
    const valid = placements.filter(x=>x.valid);
    const result = {
      format: 'JSONDB-EVIDENCE-DIASPORA-PLACEMENT-1',
      id: `${Date.now()}-${safe(latest.id)}`, at: now(), bundleId: latest.id,
      sourceMerkleRoot: sourceManifest.merkleRoot,
      requestedCopies: targetCopies, validCopies: valid.length,
      distinctDeviceKeys: new Set(valid.map(x=>x.deviceKey)).size,
      distinctExpectedLocations: new Set(valid.map(x=>x.expectedLocation)).size,
      apparentIndependenceRatio: valid.length ? new Set(valid.map(x=>x.deviceKey)).size / valid.length : 0,
      placements,
      domainAssessment: assessment.comparison,
      doctrine: 'Replica count is not authority. Independence is estimated from distinct failure domains; correlated copies are explicitly labeled.'
    };
    result.receiptHash = digest(result);
    if (this.polyhash) result.polyhash = await this.polyhash.envelope(result, { purpose: 'evidence-diaspora-placement' });
    await atomicJson(path.join(this.receipts, `${result.id}.json`), result);
    await atomicJson(path.join(this.root, 'latest-placement.json'), result);
    return result;
  }

  async verifyPlacement(id = null, options = {}) {
    const readOnly = options.readOnly === true;
    if (!readOnly) await this.init();
    const record = id ? await readJson(path.join(this.receipts, `${id}.json`), null) : await readJson(path.join(this.root, 'latest-placement.json'), null);
    if (!record) return { valid: false, status: 'ABSENT', readOnly };
    const receiptCopy = { ...record }; delete receiptCopy.receiptHash; delete receiptCopy.polyhash;
    const computedReceiptHash = digest(receiptCopy);
    const staticValid = computedReceiptHash === record.receiptHash;
    let polyhash = null;
    if (this.polyhash && record.polyhash) polyhash = await this.polyhash.verify({ ...receiptCopy, receiptHash: record.receiptHash }, record.polyhash, { readOnly });
    const checks = [];
    for (const p of record.placements || []) {
      try {
        const m = await this.manifest(p.target);
        checks.push({ media: p.media, valid: m.merkleRoot === record.sourceMerkleRoot, actualMerkleRoot: m.merkleRoot, expected: record.sourceMerkleRoot });
      } catch (error) { checks.push({ media: p.media, valid: false, error: error.message }); }
    }
    const validCopies = checks.filter(x=>x.valid).length;
    const copiesValid = validCopies > 0 && checks.every(x=>x.valid);
    return {
      format: 'JSONDB-EVIDENCE-DIASPORA-PLACEMENT-VERIFY-2',
      valid: staticValid && (!polyhash || polyhash.valid) && copiesValid,
      readOnly,
      staticValid,
      expectedReceiptHash: record.receiptHash,
      computedReceiptHash,
      polyhash,
      copiesValid,
      validCopies,
      totalCopies: checks.length,
      checks
    };
  }
}

module.exports = { EvidenceDiaspora };
