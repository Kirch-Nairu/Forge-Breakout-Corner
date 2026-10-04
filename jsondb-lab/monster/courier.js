'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {
  now, uuid, ensureDir, readJson, readJsonl, atomicJson, appendJsonl,
  listFilesRecursive, hashFile, merkleRoot, copyDir
} = require('./jsonfs');
const { entryDigest } = require('./chronicle');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

class AirGapCourier {
  constructor({ savior, chronicle, braid, witnessCouncil = null, worldTree = null, polyhash = null }) {
    Object.assign(this, { savior, chronicle, braid, witnessCouncil, worldTree, polyhash });
    this.root = path.join(savior.root, 'airgap-courier');
    this.outbox = path.join(this.root, 'outbox');
    this.inbox = path.join(this.root, 'inbox-quarantine');
  }

  async init() { await ensureDir(this.outbox); await ensureDir(this.inbox); }

  async fileManifest(dir, excluded = new Set(['COURIER-MANIFEST.json'])) {
    const files = (await listFilesRecursive(dir)).filter(file => !excluded.has(path.basename(file)));
    const entries = [];
    for (const file of files) entries.push({ path: path.relative(dir,file).split(path.sep).join('/'), sha256: await hashFile(file), bytes: (await fsp.stat(file)).size });
    entries.sort((a,b)=>a.path.localeCompare(b.path));
    return { entries, merkleRoot: merkleRoot(entries.map(x=>x.sha256)), bytes: entries.reduce((n,x)=>n+x.bytes,0) };
  }

  async exportDelta(options = {}) {
    await this.init();
    await this.chronicle.init();
    const since = Math.max(0, Number(options.sinceSequence || 0));
    const all = await readJsonl(this.chronicle.chainFile);
    if (all.some(x=>x.__corrupt)) throw new Error('Cannot courier-export a Chronicle containing corrupt JSONL entries.');
    const entries = all.filter(x => Number(x.sequence) > since);
    const head = await readJson(this.chronicle.headFile, null);
    const genesis = since === 0 ? await readJson(this.chronicle.genesisFile, null) : null;
    const braid = await readJson(this.braid.head, null);
    const id = `${Date.now()}-${uuid().slice(0,8)}`;
    const dir = path.join(this.outbox, id);
    await ensureDir(dir);

    if (genesis) await atomicJson(path.join(dir, 'chronicle-genesis.json'), genesis);
    const deltaFile = path.join(dir, 'chronicle-delta.jsonl');
    await fsp.writeFile(deltaFile, '', 'utf8');
    for (const entry of entries) await appendJsonl(deltaFile, entry);
    await atomicJson(path.join(dir, 'chronicle-head.json'), head);
    if (braid) await atomicJson(path.join(dir, 'braid-head.json'), braid);

    let witness = null;
    if (this.witnessCouncil) {
      witness = await readJson(path.join(this.witnessCouncil.root, 'latest-round.json'), null);
      if (witness) await atomicJson(path.join(dir, 'witness-round.json'), witness);
      const registry = await this.witnessCouncil.init();
      await atomicJson(path.join(dir, 'witness-public.json'), {
        format: 'JSONDB-COURIER-WITNESS-PUBLIC-1', generation: registry.generation,
        threshold: registry.threshold,
        members: registry.members.map(m => ({ id: m.id, publicKeyPem: m.publicKeyPem, revokedAt: m.revokedAt || null }))
      });
    }

    let worldTreeRef = null;
    if (this.worldTree && options.worldTreeRef) {
      worldTreeRef = await this.worldTree.ref(options.worldTreeRef);
      if (worldTreeRef) await atomicJson(path.join(dir, 'world-tree-ref.json'), worldTreeRef);
    }

    const files = await this.fileManifest(dir);
    const first = entries[0] || null;
    const last = entries.at(-1) || null;
    const manifest = {
      format: 'JSONDB-AIRGAP-COURIER-1', id, createdAt: now(), label: options.label || 'courier',
      sourceNode: options.sourceNode || null,
      chronicle: {
        sinceSequence: since,
        entries: entries.length,
        firstSequence: first?.sequence ?? null,
        firstPreviousEntryHash: first?.previousEntryHash ?? null,
        lastSequence: last?.sequence ?? since,
        lastEntryHash: last?.entryHash ?? (since === head?.sequence ? head?.entryHash : null),
        finalWorldRoot: last?.afterRoot ?? head?.worldRoot ?? null,
        exportedHead: head
      },
      braid: braid ? { sequence: braid.sequence, epochHash: braid.epochHash, channelRoot: braid.channelRoot } : null,
      witnessRoundId: witness?.statement?.roundId || null,
      worldTreeRef,
      files: files.entries,
      filesMerkleRoot: files.merkleRoot,
      bytes: files.bytes,
      doctrine: 'Courier bundles are immutable quarantine evidence. Import never appends to local history automatically.'
    };
    if (this.polyhash) manifest.polyhash = await this.polyhash.envelope(manifest, { purpose: 'airgap-courier' });
    await atomicJson(path.join(dir, 'COURIER-MANIFEST.json'), manifest);
    await atomicJson(path.join(this.root, 'latest-outbox.json'), { id, directory: dir, createdAt: manifest.createdAt, lastSequence: manifest.chronicle.lastSequence, finalWorldRoot: manifest.chronicle.finalWorldRoot });
    return { id, directory: dir, entries: entries.length, files: files.entries.length, merkleRoot: files.merkleRoot, finalWorldRoot: manifest.chronicle.finalWorldRoot };
  }

  async verifyDirectory(dir) {
    const manifest = await readJson(path.join(dir, 'COURIER-MANIFEST.json'), null);
    if (!manifest) return { valid: false, status: 'MISSING_MANIFEST', directory: dir };
    const fileResults = [];
    for (const entry of manifest.files || []) {
      const file = path.join(dir, entry.path);
      try {
        const actual = await hashFile(file);
        fileResults.push({ path: entry.path, valid: actual === entry.sha256, expected: entry.sha256, actual });
      } catch (error) { fileResults.push({ path: entry.path, valid: false, error: error.message }); }
    }
    const computedMerkleRoot = merkleRoot((manifest.files || []).map(x=>x.sha256));
    const delta = await readJsonl(path.join(dir, 'chronicle-delta.jsonl')).catch(()=>[]);
    const chainFailures = [];
    let previous = manifest.chronicle.firstPreviousEntryHash;
    let expectedSequence = manifest.chronicle.firstSequence;
    for (const entry of delta) {
      if (entry.__corrupt) { chainFailures.push({ reason: 'corrupt JSONL entry' }); continue; }
      if (entry.sequence !== expectedSequence) chainFailures.push({ sequence: entry.sequence, reason: 'sequence discontinuity', expectedSequence });
      if (entry.previousEntryHash !== previous) chainFailures.push({ sequence: entry.sequence, reason: 'previousEntryHash mismatch', expected: previous, actual: entry.previousEntryHash });
      if (entryDigest(entry) !== entry.entryHash) chainFailures.push({ sequence: entry.sequence, reason: 'entry digest mismatch' });
      previous = entry.entryHash;
      expectedSequence++;
    }
    if (delta.length && previous !== manifest.chronicle.lastEntryHash) chainFailures.push({ reason: 'manifest lastEntryHash mismatch', expected: previous, actual: manifest.chronicle.lastEntryHash });
    let polyhash = null;
    if (this.polyhash && manifest.polyhash) { const copy = { ...manifest }; delete copy.polyhash; polyhash = await this.polyhash.verify(copy, manifest.polyhash); }
    const valid = fileResults.every(x=>x.valid) && computedMerkleRoot === manifest.filesMerkleRoot && chainFailures.length === 0 && (!polyhash || polyhash.valid);
    return { format: 'JSONDB-COURIER-VERIFY-1', valid, directory: dir, manifest, fileResults, computedMerkleRoot, chainFailures, polyhash };
  }

  async importToQuarantine(sourceDirectory, label = 'incoming') {
    await this.init();
    const verification = await this.verifyDirectory(sourceDirectory);
    if (!verification.valid) throw new Error('Courier bundle failed verification; refusing quarantine import.');
    const manifest = verification.manifest;
    const target = path.join(this.inbox, `${Date.now()}-${safeLabel(label)}-${manifest.id}`);
    await copyDir(sourceDirectory, target);

    const localHead = await readJson(this.chronicle.headFile, { sequence: 0, entryHash: null, worldRoot: null });
    const remote = manifest.chronicle;
    let relationship = 'FORK_OR_GAP';
    if (remote.lastSequence === localHead.sequence && remote.lastEntryHash === localHead.entryHash && remote.finalWorldRoot === localHead.worldRoot) relationship = 'SAME_HEAD';
    else if (remote.firstSequence === localHead.sequence + 1 && remote.firstPreviousEntryHash === localHead.entryHash) relationship = 'EXTENDS_LOCAL';
    else if (remote.lastSequence <= localHead.sequence) relationship = 'BEHIND_OR_DIVERGED';

    const receipt = {
      format: 'JSONDB-COURIER-QUARANTINE-1', importedAt: now(),
      sourceDirectory: path.resolve(sourceDirectory), quarantineDirectory: target,
      bundleId: manifest.id,
      relationship,
      localHead,
      remote: {
        firstSequence: remote.firstSequence, lastSequence: remote.lastSequence,
        firstPreviousEntryHash: remote.firstPreviousEntryHash,
        lastEntryHash: remote.lastEntryHash,
        finalWorldRoot: remote.finalWorldRoot
      },
      automaticMerge: false,
      doctrine: 'Air-gap imports never mutate Chronicle, Braid, World Tree, or canonical tables automatically. Divergence is preserved as evidence.'
    };
    receipt.receiptHash = digest(receipt);
    await atomicJson(path.join(target, 'QUARANTINE-RECEIPT.json'), receipt);
    await atomicJson(path.join(this.root, 'latest-inbox.json'), receipt);
    return receipt;
  }
}

function safeLabel(value) { return String(value || 'incoming').replace(/[^A-Za-z0-9_.-]/g,'_'); }

module.exports = { AirGapCourier };
