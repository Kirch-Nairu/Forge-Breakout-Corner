'use strict';

const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, atomicJson, hashFile, fsyncDir } = require('./jsonfs');

function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

class DurabilityRealityCheck {
  constructor(savior) {
    this.savior = savior;
    this.root = path.join(savior.root, 'durability-lab');
  }

  async init() { await ensureDir(this.root); }

  async syncedWrite(file, buffer) {
    const handle = await fsp.open(file, 'w');
    try { await handle.writeFile(buffer); await handle.sync(); }
    finally { await handle.close(); }
  }

  async probe(options = {}) {
    await this.init();
    const id = `${Date.now()}-${crypto.randomUUID().slice(0,8)}`;
    const dir = path.join(this.root, id);
    await ensureDir(dir);
    const checks = [];
    const record = (name, ok, details = {}) => { checks.push({ name, ok, ...details }); return ok; };

    const original = crypto.randomBytes(8192);
    const replacement = crypto.randomBytes(8192);
    const target = path.join(dir, 'atomic-target.bin');
    const temp = path.join(dir, 'atomic-temp.bin');
    try {
      await this.syncedWrite(target, original);
      await fsyncDir(dir);
      record('initial-synced-write', await hashFile(target) === sha(original));
    } catch (error) { record('initial-synced-write', false, { error: error.message }); }

    try {
      await this.syncedWrite(temp, replacement);
      await fsp.rename(temp, target);
      await fsyncDir(dir);
      record('fsync-rename-replace', await hashFile(target) === sha(replacement), { expected: sha(replacement), actual: await hashFile(target).catch(()=>null) });
    } catch (error) { record('fsync-rename-replace', false, { error: error.message }); }

    const appendFile = path.join(dir, 'append.log');
    const records = Array.from({ length: 8 }, (_, i) => Buffer.from(`${i}:${crypto.randomBytes(64).toString('hex')}\n`));
    try {
      const handle = await fsp.open(appendFile, 'a');
      try {
        for (const bytes of records) { await handle.write(bytes); await handle.sync(); }
      } finally { await handle.close(); }
      const actual = await fsp.readFile(appendFile);
      const expected = Buffer.concat(records);
      record('append-sync-log', actual.equals(expected), { bytes: actual.length });
    } catch (error) { record('append-sync-log', false, { error: error.message }); }

    const jsonFile = path.join(dir, 'atomic.json');
    try {
      const payload = { format: 'JSONDB-DURABILITY-PROBE-1', id, random: crypto.randomBytes(128).toString('hex') };
      await atomicJson(jsonFile, payload);
      const parsed = JSON.parse(await fsp.readFile(jsonFile, 'utf8'));
      record('atomic-json-roundtrip', parsed.id === id && parsed.random === payload.random);
    } catch (error) { record('atomic-json-roundtrip', false, { error: error.message }); }

    let directorySync = true;
    try {
      const h = await fsp.open(dir, fs.constants.O_RDONLY);
      try { await h.sync(); } finally { await h.close(); }
    } catch (error) {
      directorySync = false;
      checks.push({ name: 'directory-fsync-direct', ok: false, advisory: true, error: error.message });
    }
    if (directorySync) checks.push({ name: 'directory-fsync-direct', ok: true, advisory: true });

    const critical = checks.filter(x => !x.advisory);
    const healthy = critical.every(x => x.ok);
    const report = {
      format: 'JSONDB-DURABILITY-REALITY-CHECK-1', id, at: now(),
      healthy, checks,
      filesystem: { probeDirectory: dir, platform: process.platform },
      doctrine: 'The storage engine may only trust durability primitives that the actual filesystem can demonstrate in a sacrificial directory on the same volume.'
    };
    await atomicJson(path.join(dir, 'REPORT.json'), report);
    await atomicJson(path.join(this.root, 'latest.json'), report);
    if (!healthy && options.freezeOnFailure !== false) await this.savior.setMode('read-only', 'Durability Reality Check failed one or more critical filesystem primitives.');
    return report;
  }
}

module.exports = { DurabilityRealityCheck };
