'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { now, uuid, ensureDir, readJson, atomicJson, hashFile } = require('./jsonfs');

const P = 257;
function mod(n) { n %= P; return n < 0 ? n + P : n; }
function mul(a,b) { return mod(a*b); }
function pow(base, exponent) {
  let b = mod(base), e = exponent, out = 1;
  while (e > 0) { if (e & 1) out = mul(out,b); b = mul(b,b); e >>= 1; }
  return out;
}
function inv(a) { if (mod(a) === 0) throw new Error('No inverse for zero.'); return pow(a, P - 2); }
function randomField() {
  while (true) {
    const n = crypto.randomBytes(2).readUInt16BE(0);
    if (n < 65535) return n % P;
  }
}
function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function evaluatePolynomial(coeffs, x) {
  let out = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) out = mod(mul(out, x) + coeffs[i]);
  return out;
}

function packField(values) {
  const out = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => out.writeUInt16BE(value, i * 2));
  return out;
}
function unpackField(buffer) {
  if (buffer.length % 2) throw new Error('Invalid field share byte length.');
  const out = [];
  for (let i = 0; i < buffer.length; i += 2) {
    const value = buffer.readUInt16BE(i);
    if (value >= P) throw new Error(`Field value outside GF(257): ${value}`);
    out.push(value);
  }
  return out;
}

function splitSecret(secret, total = 5, threshold = 3) {
  total = Number(total); threshold = Number(threshold);
  if (!Buffer.isBuffer(secret)) secret = Buffer.from(secret);
  if (threshold < 2 || total < threshold || total > 255) throw new Error('Need 2 <= threshold <= total <= 255.');
  const shareValues = Array.from({ length: total }, () => []);
  for (const byte of secret) {
    const coeffs = [byte];
    for (let j = 1; j < threshold; j++) coeffs.push(randomField());
    for (let i = 0; i < total; i++) shareValues[i].push(evaluatePolynomial(coeffs, i + 1));
  }
  return shareValues.map((values, i) => ({ x: i + 1, values }));
}

function reconstructSecret(shares, threshold) {
  if (!Array.isArray(shares) || shares.length < threshold) throw new Error(`Need at least ${threshold} shares.`);
  const selected = shares.slice(0, threshold);
  const xs = selected.map(x => Number(x.x));
  if (new Set(xs).size !== xs.length) throw new Error('Duplicate share coordinates.');
  const length = selected[0].values.length;
  if (!selected.every(x => x.values.length === length)) throw new Error('Share lengths disagree.');
  const bytes = Buffer.alloc(length);
  for (let position = 0; position < length; position++) {
    let value = 0;
    for (let i = 0; i < selected.length; i++) {
      const xi = xs[i];
      let numerator = 1;
      let denominator = 1;
      for (let j = 0; j < selected.length; j++) {
        if (j === i) continue;
        const xj = xs[j];
        numerator = mul(numerator, -xj);
        denominator = mul(denominator, xi - xj);
      }
      const basis = mul(numerator, inv(denominator));
      value = mod(value + mul(selected[i].values[position], basis));
    }
    if (value > 255) throw new Error('Reconstruction produced non-byte field element; shares are inconsistent.');
    bytes[position] = value;
  }
  return bytes;
}

class ThresholdKeyShardVault {
  constructor(root) {
    this.root = root;
    this.groups = path.join(root, 'groups');
  }

  async init() { await ensureDir(this.groups); }

  descriptorHash(share) {
    const copy = { ...share }; delete copy.payloadBase64; delete copy.descriptorSha256;
    return sha(Buffer.from(JSON.stringify(copy)));
  }

  async splitFile(sourceFile, label = 'secret', options = {}) {
    await this.init();
    const total = Math.max(3, Math.min(16, Number(options.total || 5)));
    const threshold = Math.max(2, Math.min(total, Number(options.threshold || 3)));
    const secret = await fsp.readFile(sourceFile);
    const secretSha256 = sha(secret);
    const groupId = `${Date.now()}-${uuid().slice(0,8)}`;
    const group = path.join(this.groups, groupId);
    const sharesDir = path.join(group, 'shares');
    await ensureDir(sharesDir);
    const pieces = splitSecret(secret, total, threshold);
    const files = [];
    for (const piece of pieces) {
      const packed = packField(piece.values);
      const share = {
        format: 'JSONDB-THRESHOLD-KEY-SHARD-1', groupId, label, createdAt: now(),
        x: piece.x, total, threshold,
        sourceName: path.basename(sourceFile),
        sourceBytes: secret.length,
        secretSha256,
        field: 'GF(257)',
        payloadSha256: sha(packed),
        payloadBase64: packed.toString('base64'),
        warning: 'A share is sensitive recovery material even though fewer than threshold shares cannot reconstruct the secret.'
      };
      share.descriptorSha256 = this.descriptorHash(share);
      const file = path.join(sharesDir, `share-${String(piece.x).padStart(2,'0')}.json`);
      await atomicJson(file, share);
      files.push(file);
    }
    const manifest = {
      format: 'JSONDB-THRESHOLD-KEY-GROUP-1', groupId, label, createdAt: now(),
      total, threshold, sourceName: path.basename(sourceFile), sourceBytes: secret.length,
      secretSha256,
      shares: files.map(file => path.basename(file)),
      doctrine: 'Move shares to independent media/failure domains. This local folder is a staging area, not independence by itself.'
    };
    await atomicJson(path.join(group, 'manifest.json'), manifest);
    await atomicJson(path.join(this.root, 'latest.json'), manifest);
    return { ...manifest, directory: group };
  }

  async parseShare(file) {
    const share = await readJson(file, null);
    if (!share?.payloadBase64 || share.format !== 'JSONDB-THRESHOLD-KEY-SHARD-1') throw new Error('Not a JSONDB threshold key share.');
    const packed = Buffer.from(share.payloadBase64, 'base64');
    const descriptorValid = this.descriptorHash(share) === share.descriptorSha256;
    const payloadValid = sha(packed) === share.payloadSha256;
    if (!descriptorValid || !payloadValid) throw new Error(`Share integrity failed: ${path.basename(file)}`);
    return { share, values: unpackField(packed), file };
  }

  async scanDirectory(directory) {
    const files = (await fsp.readdir(directory).catch(() => [])).filter(x => x.endsWith('.json'));
    const groups = new Map();
    const rejected = [];
    for (const name of files) {
      const file = path.join(directory, name);
      try {
        const parsed = await this.parseShare(file);
        const slot = groups.get(parsed.share.groupId) || [];
        slot.push(parsed); groups.set(parsed.share.groupId, slot);
      } catch (error) { rejected.push({ file, error: error.message }); }
    }
    return { groups, rejected };
  }

  async reconstructDirectory(directory, target) {
    const scan = await this.scanDirectory(directory);
    const attempts = [];
    for (const [groupId, parsed] of [...scan.groups.entries()].sort((a,b)=>b[1].length-a[1].length)) {
      const first = parsed[0].share;
      const compatible = parsed.filter(x => x.share.secretSha256 === first.secretSha256 && x.share.threshold === first.threshold && x.share.total === first.total);
      if (compatible.length < first.threshold) {
        attempts.push({ groupId, shares: compatible.length, threshold: first.threshold, status: 'INSUFFICIENT' });
        continue;
      }
      try {
        const secret = reconstructSecret(compatible.map(x => ({ x: x.share.x, values: x.values })), first.threshold).subarray(0, first.sourceBytes);
        const actual = sha(secret);
        const valid = actual === first.secretSha256;
        attempts.push({ groupId, shares: compatible.length, threshold: first.threshold, status: valid ? 'RECOVERED' : 'HASH_MISMATCH', expected: first.secretSha256, actual });
        if (!valid) continue;
        await ensureDir(path.dirname(target));
        await fsp.writeFile(target, secret);
        return {
          format: 'JSONDB-THRESHOLD-KEY-RECOVERY-1', recovered: true,
          groupId, target, sha256: actual, sharesUsed: first.threshold,
          attempts, rejected: scan.rejected,
          warning: 'Reconstructed secret exists at the explicit target path. Handle and erase it according to operator policy.'
        };
      } catch (error) {
        attempts.push({ groupId, shares: compatible.length, threshold: first.threshold, status: 'ERROR', error: error.message });
      }
    }
    return { format: 'JSONDB-THRESHOLD-KEY-RECOVERY-1', recovered: false, attempts, rejected: scan.rejected };
  }

  async exportShare(groupId, x, targetDirectory) {
    const source = path.join(this.groups, groupId, 'shares', `share-${String(x).padStart(2,'0')}.json`);
    await this.parseShare(source);
    await ensureDir(targetDirectory);
    const target = path.join(targetDirectory, `${groupId}-share-${String(x).padStart(2,'0')}.json`);
    await fsp.copyFile(source, target);
    return { source, target, sha256: await hashFile(target) };
  }
}

module.exports = {
  ThresholdKeyShardVault, splitSecret, reconstructSecret,
  packField, unpackField, P
};
