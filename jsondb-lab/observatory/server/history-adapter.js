'use strict';

const path = require('path');
const fsp = require('fs/promises');

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function listJson(dir) {
  try {
    const names = (await fsp.readdir(dir)).filter(name => name.endsWith('.json')).sort();
    const rows = [];
    for (const name of names.slice(-80)) {
      const doc = await readJson(path.join(dir, name), null);
      if (doc) rows.push(doc);
    }
    return rows;
  } catch { return []; }
}

async function historyMap(saviorRoot) {
  const omegaRoot = path.join(saviorRoot, 'omega-epochs');
  const weaveRoot = path.join(saviorRoot, 'time-weave');
  const fossilRoot = path.join(saviorRoot, 'semantic-delta-fossils');
  const [epochs, weaveIndex, fossils, fossilTip] = await Promise.all([
    listJson(path.join(omegaRoot, 'epochs')),
    readJson(path.join(weaveRoot, 'index.json'), { nodes: [] }),
    listJson(path.join(fossilRoot, 'records')),
    readJson(path.join(fossilRoot, 'latest.json'), null)
  ]);

  const epochRows = epochs
    .filter(epoch => epoch?.id)
    .map(epoch => ({
      id: epoch.id,
      createdAt: epoch.createdAt || epoch.sealedAt || null,
      label: epoch.label || 'OMEGA epoch',
      epochHash: epoch.epochHash || null,
      semanticWorldSha256: epoch.semanticWorldSha256 || null,
      worldTreeCommit: epoch.worldTreeCommit || epoch.worldTree?.commit || null
    }));

  const weaveRows = (weaveIndex?.nodes || []).map(node => ({
    position: Number(node.position || 0),
    epochId: node.epochId,
    epochHash: node.epochHash || null,
    weaveHash: node.weaveHash || null,
    semanticWorldSha256: node.semanticWorldSha256 || null
  }));

  const fossilRows = fossils
    .filter(row => row?.id)
    .map(row => ({
      id: row.id,
      format: row.format,
      createdAt: row.createdAt || null,
      parentFossil: row.parentFossil || null,
      changeCount: Number(row.changeCount || row.changes || 0),
      from: row.from || null,
      to: row.to || (row.toMemoryId ? { memoryId: row.toMemoryId, worldSha256: row.toWorldSha256 } : null),
      fossilHash: row.fossilHash || null
    }));

  return {
    format: 'JSONDB-OMEGA-OBSERVATORY-HISTORY-MAP-1',
    observedAt: new Date().toISOString(),
    authority: 'READ_ONLY_OBSERVER',
    epochs: epochRows,
    timeWeave: weaveRows,
    fossils: fossilRows,
    fossilTip: fossilTip ? { id: fossilTip.id || null, format: fossilTip.format || null } : null
  };
}

module.exports = { historyMap };
