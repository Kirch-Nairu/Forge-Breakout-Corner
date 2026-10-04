'use strict';

const path = require('path');
const crypto = require('crypto');
const fsp = require('fs/promises');

function idFor(rel) {
  return `artifact-${crypto.createHash('sha256').update(rel).digest('hex').slice(0, 16)}`;
}

async function walk(root, target, out, budget) {
  if (budget.count >= budget.max) return;
  let stat;
  try { stat = await fsp.lstat(target); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    let entries;
    try { entries = await fsp.readdir(target, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (budget.count >= budget.max) break;
      await walk(root, path.join(target, entry.name), out, budget);
    }
    return;
  }
  if (!stat.isFile()) return;
  const rel = path.relative(root, target).split(path.sep).join('/');
  if (rel.startsWith('..')) return;
  budget.count++;
  out.push({
    id: idFor(rel),
    rel,
    file: target,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    extension: path.extname(target).toLowerCase()
  });
}

async function buildRegistry(dataRoot, surfaces) {
  const rows = [];
  const budget = { count: 0, max: 4000 };
  for (const surface of surfaces) await walk(dataRoot, surface, rows, budget);
  const unique = new Map();
  for (const row of rows) unique.set(row.id, row);
  return [...unique.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

function publicRow(row) {
  return {
    id: row.id,
    path: row.rel,
    bytes: row.bytes,
    mtimeMs: row.mtimeMs,
    extension: row.extension,
    previewable: ['.json', '.jsonl', '.txt', '.md'].includes(row.extension) && row.bytes <= 512 * 1024
  };
}

async function listArtifacts(dataRoot, surfaces) {
  const registry = await buildRegistry(dataRoot, surfaces);
  return {
    format: 'JSONDB-OMEGA-OBSERVATORY-ARTIFACT-LIST-1',
    observedAt: new Date().toISOString(),
    authority: 'READ_ONLY_OBSERVER',
    count: registry.length,
    artifacts: registry.map(publicRow)
  };
}

async function readArtifact(dataRoot, surfaces, id) {
  if (!/^artifact-[a-f0-9]{16}$/.test(String(id || ''))) {
    return { status: 404, body: { error: 'ARTIFACT_NOT_FOUND' } };
  }
  const registry = await buildRegistry(dataRoot, surfaces);
  const row = registry.find(item => item.id === id);
  if (!row) return { status: 404, body: { error: 'ARTIFACT_NOT_FOUND' } };
  const meta = publicRow(row);
  if (!meta.previewable) {
    return { status: 415, body: { error: 'ARTIFACT_NOT_PREVIEWABLE', artifact: meta } };
  }
  let text;
  try { text = await fsp.readFile(row.file, 'utf8'); }
  catch { return { status: 404, body: { error: 'ARTIFACT_NOT_FOUND' } }; }
  return {
    status: 200,
    body: {
      format: 'JSONDB-OMEGA-OBSERVATORY-ARTIFACT-1',
      observedAt: new Date().toISOString(),
      authority: 'READ_ONLY_OBSERVER',
      artifact: meta,
      content: text
    }
  };
}

module.exports = { listArtifacts, readArtifact };
