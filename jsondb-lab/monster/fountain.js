'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function xorInto(target, source) { for (let i = 0; i < target.length; i++) target[i] ^= source[i]; return target; }
function prng(seed) {
  let counter = 0;
  return () => {
    const b = crypto.createHash('sha256').update(`${seed}:${counter++}`).digest();
    return b.readUInt32BE(0) / 0x100000000;
  };
}
function chooseIndexes(k, degree, seed) {
  const random = prng(seed);
  const set = new Set();
  while (set.size < Math.min(k, degree)) set.add(Math.floor(random() * k));
  return [...set].sort((a,b)=>a-b);
}
function randomDegree(k, seed) {
  const r = prng(`degree:${seed}`)();
  if (r < .25) return 1;
  if (r < .58) return Math.min(k, 2);
  if (r < .80) return Math.min(k, 3);
  if (r < .92) return Math.min(k, 4);
  if (r < .98) return Math.min(k, 6);
  return Math.min(k, Math.max(8, Math.ceil(Math.sqrt(k))));
}

class FountainArk {
  constructor(root) {
    this.root = root;
    this.generations = path.join(root, 'generations');
  }
  async init() { await ensureDir(this.generations); }

  split(buffer, k) {
    const chunkSize = Math.ceil(buffer.length / k) || 1;
    const padded = Buffer.alloc(chunkSize * k);
    buffer.copy(padded);
    return Array.from({ length: k }, (_, i) => Buffer.from(padded.subarray(i * chunkSize, (i + 1) * chunkSize)));
  }

  dropletPayload(chunks, indexes) {
    const out = Buffer.alloc(chunks[0].length);
    for (const index of indexes) xorInto(out, chunks[index]);
    return out;
  }

  async archiveBuffer(label, buffer, options = {}) {
    await this.init();
    const k = Math.max(4, Math.min(256, Number(options.sourceChunks || Math.ceil(buffer.length / (32 * 1024)) || 8)));
    const chunks = this.split(buffer, k);
    const chunkSize = chunks[0].length;
    const originalSha256 = sha256(buffer);
    const generation = `${Date.now()}-${originalSha256.slice(0,12)}`;
    const dir = path.join(this.generations, generation);
    await ensureDir(dir);
    const redundancy = Math.max(1, Math.min(8, Number(options.redundancy || 2.5)));
    const randomCount = Math.ceil(k * redundancy);
    const packets = [];

    const writePacket = async (ordinal, indexes, seed, kind) => {
      const bytes = this.dropletPayload(chunks, indexes);
      const packet = {
        format: 'JSONDB-FOUNTAIN-DROPLET-1', generation, label,
        originalSha256, originalBytes: buffer.length,
        sourceChunks: k, chunkSize,
        ordinal, kind, seed, indexes,
        payloadSha256: sha256(bytes),
        base64: bytes.toString('base64')
      };
      const descriptor = { ...packet }; delete descriptor.base64;
      packet.descriptorSha256 = sha256(Buffer.from(JSON.stringify(descriptor)));
      const file = `droplet-${String(ordinal).padStart(6,'0')}.json`;
      await atomicJson(path.join(dir, file), packet);
      packets.push(file);
    };

    for (let i = 0; i < k; i++) await writePacket(i, [i], `systematic:${i}`, 'systematic');
    for (let i = 0; i < randomCount; i++) {
      const seed = `${generation}:random:${i}`;
      const degree = randomDegree(k, seed);
      await writePacket(k + i, chooseIndexes(k, degree, seed), seed, 'fountain');
    }

    const summary = {
      format: 'JSONDB-FOUNTAIN-ARK-1', generation, label, createdAt: now(),
      originalSha256, originalBytes: buffer.length, sourceChunks: k, chunkSize,
      systematicPackets: k, fountainPackets: randomCount, totalPackets: packets.length,
      redundancy,
      doctrine: 'Droplets are self-describing. Reconstruction uses surviving equations; the summary is convenient but not required by scan-directory recovery.'
    };
    await atomicJson(path.join(dir, 'summary.json'), summary);
    await atomicJson(path.join(this.root, 'latest.json'), summary);
    return summary;
  }

  async readPackets(directory) {
    const files = (await fsp.readdir(directory).catch(() => [])).filter(x => x.endsWith('.json') && x.startsWith('droplet-'));
    const packets = [];
    for (const file of files) {
      try {
        const packet = await readJson(path.join(directory, file), null);
        if (!packet?.base64 || !Array.isArray(packet.indexes)) continue;
        const buffer = Buffer.from(packet.base64, 'base64');
        if (sha256(buffer) !== packet.payloadSha256) continue;
        packets.push({ ...packet, file, buffer });
      } catch {}
    }
    return packets;
  }

  groupPackets(packets) {
    const groups = new Map();
    for (const packet of packets) {
      const key = `${packet.generation}|${packet.originalSha256}|${packet.sourceChunks}|${packet.chunkSize}|${packet.originalBytes}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(packet);
    }
    return [...groups.values()].sort((a,b)=>b.length-a.length);
  }

  peel(group) {
    if (!group.length) return { complete: false, solved: 0, sourceChunks: 0, buffer: null };
    const meta = group[0];
    const k = Number(meta.sourceChunks);
    const equations = group.map(p => ({ indexes: new Set(p.indexes), bytes: Buffer.from(p.buffer), packet: p.file }));
    const solved = new Map();
    let progress = true;
    while (progress) {
      progress = false;
      for (const equation of equations) {
        for (const [index, bytes] of solved) {
          if (!equation.indexes.has(index)) continue;
          equation.indexes.delete(index);
          xorInto(equation.bytes, bytes);
        }
        if (equation.indexes.size === 1) {
          const index = [...equation.indexes][0];
          if (!solved.has(index)) {
            solved.set(index, Buffer.from(equation.bytes));
            progress = true;
          }
        }
      }
    }
    if (solved.size !== k) return { complete: false, solved: solved.size, sourceChunks: k, missing: Array.from({length:k},(_,i)=>i).filter(i=>!solved.has(i)), buffer: null };
    const ordered = Array.from({ length: k }, (_, i) => solved.get(i));
    const buffer = Buffer.concat(ordered).subarray(0, Number(meta.originalBytes));
    const actual = sha256(buffer);
    return { complete: actual === meta.originalSha256, solved: solved.size, sourceChunks: k, actualSha256: actual, expectedSha256: meta.originalSha256, buffer };
  }

  async recoverDirectory(directory) {
    const packets = await this.readPackets(directory);
    const groups = this.groupPackets(packets);
    const attempts = [];
    for (const group of groups) {
      const peeled = this.peel(group);
      attempts.push({ generation: group[0]?.generation, packets: group.length, complete: peeled.complete, solved: peeled.solved, sourceChunks: peeled.sourceChunks, missing: peeled.missing, expectedSha256: peeled.expectedSha256, actualSha256: peeled.actualSha256, _buffer: peeled.buffer });
      if (peeled.complete) return { status: 'RECOVERED', directory, packetsRead: packets.length, attempts: attempts.map(({_buffer,...x})=>x), winner: attempts.at(-1), buffer: peeled.buffer };
    }
    return { status: 'INCOMPLETE', directory, packetsRead: packets.length, attempts: attempts.map(({_buffer,...x})=>x), buffer: null };
  }

  async restoreDirectory(directory, target) {
    const result = await this.recoverDirectory(directory);
    if (result.status !== 'RECOVERED' || !result.buffer) throw new Error('Fountain ARK could not peel enough equations to reconstruct the world.');
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, result.buffer);
    return { target, status: result.status, sha256: result.winner.actualSha256, packetsRead: result.packetsRead, generation: result.winner.generation };
  }
}

module.exports = { FountainArk, chooseIndexes, randomDegree, xorInto, sha256 };
