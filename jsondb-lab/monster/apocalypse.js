'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, uuid, ensureDir, atomicJson, readJson, listFilesRecursive } = require('./jsonfs');
const { XorArk, MirrorQuorum, sha256 } = require('./savior');

function flipByte(buffer, offset = null) {
  const out = Buffer.from(buffer);
  if (!out.length) return out;
  const i = offset == null ? crypto.randomInt(0, out.length) : Math.max(0, Math.min(out.length - 1, offset));
  out[i] ^= 0xff;
  return out;
}

class ExtinctionLab {
  constructor(engine, savior) {
    this.engine = engine;
    this.savior = savior;
    this.root = path.join(savior.root, 'extinction-drills');
  }

  async init() { await ensureDir(this.root); }

  async worldBuffer() {
    const tables = {};
    for (const file of await listFilesRecursive(this.engine.current)) {
      if (!file.endsWith('.json')) continue;
      tables[path.basename(file, '.json')] = await readJson(file, null);
    }
    const payload = {
      format: 'JSONDB-EXTINCTION-WORLD-1', capturedAt: now(),
      catalog: await this.engine.catalog(), meta: await this.engine.meta(), tables
    };
    return Buffer.from(JSON.stringify(payload));
  }

  async corruptArkShard(ark, generation, shardIndex) {
    const dir = path.join(ark.archives, generation);
    const manifest = await readJson(path.join(dir, 'manifest.json'), null);
    const spec = manifest.shards[shardIndex];
    const file = path.join(dir, spec.file);
    const payload = await readJson(file, null);
    const bytes = flipByte(Buffer.from(payload.base64, 'base64'));
    payload.base64 = bytes.toString('base64');
    payload.injectedFault = { at: now(), type: 'bit-flip' };
    await atomicJson(file, payload);
    return { file: spec.file, index: shardIndex };
  }

  async corruptMirrorCell(mirrors, cell, relative, salt) {
    const file = path.join(mirrors.cellsRoot, cell, relative);
    const bytes = await fsp.readFile(file);
    const poisoned = Buffer.concat([bytes, Buffer.from(`\nCORRUPTION-${salt}-${crypto.randomBytes(8).toString('hex')}`)]);
    await ensureDir(path.dirname(file));
    await fsp.writeFile(file, poisoned);
    return { cell, relative, before: sha256(bytes), after: sha256(poisoned) };
  }

  async run(options = {}) {
    await this.init();
    const id = `${Date.now()}-${uuid().slice(0, 8)}`;
    const dir = path.join(this.root, id);
    await ensureDir(dir);
    const world = await this.worldBuffer();
    const expected = sha256(world);

    const ark = new XorArk(path.join(dir, 'ark'));
    const archive = await ark.archiveBuffer('world.json', world, { dataShards: Number(options.dataShards || 6) });
    const shardIndex = Number.isInteger(options.shardIndex) ? options.shardIndex : crypto.randomInt(0, archive.shards.length);
    const arkFault = await this.corruptArkShard(ark, archive.generation, shardIndex);
    const arkRecovery = await ark.verifyAndRepair(archive.generation);

    const worldFile = path.join(dir, 'world.json');
    await fsp.writeFile(worldFile, world);
    const mirrors = new MirrorQuorum(path.join(dir, 'mirror-system'), Number(options.cells || 5));
    const capture = await mirrors.capture(dir, [worldFile]);
    const cells = mirrors.cells();
    const corruptCount = Math.min(Number(options.corruptMirrors ?? 2), cells.length);
    const mirrorFaults = [];
    for (let i = 0; i < corruptCount; i++) mirrorFaults.push(await this.corruptMirrorCell(mirrors, cells[i], 'world.json', i));
    const mirrorRecovery = await mirrors.scrub();

    const report = {
      format: 'JSONDB-EXTINCTION-DRILL-1', id, at: now(), expectedWorldSha256: expected,
      faults: { ark: arkFault, mirrors: mirrorFaults },
      recovery: {
        ark: { healthy: arkRecovery.healthy, recoverable: arkRecovery.recoverable, repaired: arkRecovery.repaired, restoredSha256: arkRecovery.restoredSha256 },
        mirrors: mirrorRecovery
      },
      survived: Boolean(arkRecovery.healthy && mirrorRecovery.healthy),
      canonicalTouched: false,
      note: 'All faults were injected into disposable drill copies only.'
    };
    await atomicJson(path.join(dir, 'report.json'), report);
    return report;
  }

  async impossibleMode(options = {}) {
    const report = await this.run({ ...options, corruptMirrors: options.corruptMirrors ?? 3 });
    report.mode = 'black-swan';
    report.lesson = report.survived ? 'The drill unexpectedly survived.' : 'Redundancy has limits; failure is reported instead of silently fabricating truth.';
    await atomicJson(path.join(this.root, report.id, 'report.json'), report);
    return report;
  }
}

module.exports = { ExtinctionLab, flipByte };
