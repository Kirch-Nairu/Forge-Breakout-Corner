'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

function now() { return new Date().toISOString(); }
function uuid() { return crypto.randomUUID(); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); }
async function exists(file) { try { await fsp.access(file); return true; } catch { return false; } }
async function readText(file, fallback = '') { try { return await fsp.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
async function readJson(file, fallback = null) { const text = await readText(file, ''); if (!text) return fallback; return JSON.parse(text); }

async function fsyncDir(dir) {
  try {
    const handle = await fsp.open(dir, fs.constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Best effort: some platforms do not allow directory fsync.
  }
}

async function atomicText(file, body) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
  await fsyncDir(path.dirname(file));
}

async function atomicJson(file, value) {
  await atomicText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonl(file, value) {
  await ensureDir(path.dirname(file));
  const handle = await fsp.open(file, 'a');
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJsonl(file) {
  const text = await readText(file, '');
  if (!text.trim()) return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); }
    catch { out.push({ __corrupt: true, raw: line }); }
  }
  return out;
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  await new Promise((resolve, reject) => {
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

function hashValue(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function merkleRoot(hashes) {
  if (!hashes.length) return hashValue([]);
  let layer = [...hashes];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = layer[i + 1] || left;
      next.push(crypto.createHash('sha256').update(`${left}:${right}`).digest('hex'));
    }
    layer = next;
  }
  return layer[0];
}

async function listFilesRecursive(root) {
  const out = [];
  if (!(await exists(root))) return out;
  const walk = async dir => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  await walk(root);
  return out.sort();
}

async function copyDir(src, dst) {
  await ensureDir(dst);
  for (const entry of await fsp.readdir(src, { withFileTypes: true }).catch(() => [])) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else if (entry.isFile()) await fsp.copyFile(from, to);
  }
}

module.exports = {
  now, uuid, clone, ensureDir, exists, readText, readJson, readJsonl,
  atomicText, atomicJson, appendJsonl, hashFile, hashValue, merkleRoot,
  listFilesRecursive, copyDir, fsyncDir
};
