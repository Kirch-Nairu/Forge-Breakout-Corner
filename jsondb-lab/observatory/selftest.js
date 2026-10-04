'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fsp = require('fs/promises');
const { spawn } = require('child_process');

const root = __dirname;
const labRoot = path.resolve(root, '..');
const dataRoot = path.join(labRoot, 'monster-data');
const port = 17431;
const host = '127.0.0.1';

const canonicalSurfaces = [
  path.join(dataRoot, 'catalog.json'),
  path.join(dataRoot, 'meta.json'),
  path.join(dataRoot, 'wal.jsonl'),
  ...['current', 'indexes', 'versions', 'segments', 'tx', 'checkpoints', 'snapshots', 'views', 'integrity'].map(x => path.join(dataRoot, x))
];

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

async function walk(target, out) {
  let stat;
  try { stat = await fsp.lstat(target); } catch { return; }
  if (stat.isSymbolicLink()) throw new Error(`Canonical surface contains unexpected symlink: ${target}`);
  if (stat.isDirectory()) {
    const entries = await fsp.readdir(target, { withFileTypes: true });
    for (const entry of entries) await walk(path.join(target, entry.name), out);
    return;
  }
  if (!stat.isFile()) return;
  const bytes = await fsp.readFile(target);
  out.push({
    path: path.relative(dataRoot, target).split(path.sep).join('/'),
    bytes: stat.size,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    sha256: sha(bytes)
  });
}

async function canonicalSnapshot() {
  const files = [];
  for (const surface of canonicalSurfaces) await walk(surface, files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, digest: sha(Buffer.from(JSON.stringify(files))) };
}

function request(method, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path: pathname }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await request('GET', '/api/health');
      if (response.status === 200) return response;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Observatory server did not become healthy.');
}

function runNode(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: labRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Command failed (${code}): node ${script} ${args.join(' ')}\n${stderr}\n${stdout}`));
    });
  });
}

function runInline(code) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { cwd: labRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', exitCode => {
      if (exitCode === 0) resolve({ stdout, stderr });
      else reject(new Error(`Inline Node probe failed (${exitCode}).\n${stderr}\n${stdout}`));
    });
  });
}

function waitForObservation(predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: '/api/events', headers: { Accept: 'text/event-stream' } }, res => {
      let buffer = '';
      const finish = value => { clearTimeout(timer); req.destroy(); resolve(value); };
      res.on('data', chunk => {
        buffer += chunk.toString('utf8');
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const line = frame.split('\n').find(x => x.startsWith('data: '));
          if (!line) continue;
          try {
            const value = JSON.parse(line.slice(6));
            if (value.format === 'JSONDB-OMEGA-OBSERVATORY-EVENT-1' && predicate(value)) return finish(value);
          } catch {}
        }
      });
    });
    req.on('error', reject);
    const timer = setTimeout(() => { req.destroy(); reject(new Error('Timed out waiting for normalized Observatory event.')); }, timeoutMs);
  });
}

function assert(condition, message) { if (!condition) throw new Error(message); }

async function main() {
  const before = await canonicalSnapshot();
  const server = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: labRoot,
    env: { ...process.env, OBSERVATORY_HOST: host, OBSERVATORY_PORT: String(port), OBSERVATORY_SCAN_MS: '250' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOut = '', serverErr = '';
  server.stdout.on('data', x => { serverOut += x; });
  server.stderr.on('data', x => { serverErr += x; });

  try {
    const health = await waitForServer();
    const healthJson = JSON.parse(health.body);
    assert(healthJson.ok === true, 'Health endpoint is not healthy.');
    assert(healthJson.authority === 'READ_ONLY_OBSERVER', 'Health endpoint did not declare read-only authority.');

    const snapshot = await request('GET', '/api/snapshot');
    assert(snapshot.status === 200, `Snapshot endpoint returned ${snapshot.status}.`);
    const snapshotJson = JSON.parse(snapshot.body);
    assert(snapshotJson.authority === 'READ_ONLY_OBSERVER', 'Snapshot did not declare observer authority.');

    const recoveryResponse = await request('GET', '/api/recovery-graph');
    assert(recoveryResponse.status === 200, `Recovery graph endpoint returned ${recoveryResponse.status}.`);
    const recovery = JSON.parse(recoveryResponse.body);
    assert(recovery.authority === 'READ_ONLY_OBSERVER', 'Recovery graph did not declare observer authority.');
    assert(Array.isArray(recovery.nodes) && recovery.nodes.length > 0, 'Recovery graph returned no contract nodes.');
    assert(recovery.nodes.every(node => node.mayPromoteCanonical === false), 'Recovery graph exposed a contract with automatic canonical promotion authority.');
    assert(Array.isArray(recovery.edges), 'Recovery graph edges are missing.');

    const authorityResponse = await request('GET', '/api/authority-ledger');
    assert(authorityResponse.status === 200, `Authority ledger endpoint returned ${authorityResponse.status}.`);
    const authority = JSON.parse(authorityResponse.body);
    assert(authority.authority === 'READ_ONLY_OBSERVER', 'Authority ledger did not declare observer authority.');
    assert(Array.isArray(authority.decisions), 'Authority ledger decisions are missing.');

    const indexedCollection = snapshotJson.collections.find(collection => collection.rows > 0 && collection.indexes?.length) || snapshotJson.collections.find(collection => collection.rows > 0) || snapshotJson.collections[0];
    assert(indexedCollection, 'Bootstrap produced no collection for Observatory Index Lab.');

    const indexPath = `/api/index-lab?collection=${encodeURIComponent(indexedCollection.name)}`;
    const indexResponse = await request('GET', indexPath);
    assert(indexResponse.status === 200, `Index Lab endpoint returned ${indexResponse.status}.`);
    const indexJson = JSON.parse(indexResponse.body);
    assert(indexJson.authority === 'READ_ONLY_OBSERVER', 'Index Lab did not declare observer authority.');
    assert(indexJson.collection === indexedCollection.name, 'Index Lab returned a different collection.');
    assert(indexJson.truth?.engineIndexStructure === 'HASH_MAP', 'Index Lab did not identify the real engine index as HASH_MAP.');
    assert(indexJson.truth?.sortAnimation === 'EXPLAIN_ONLY', 'Index Lab failed to distinguish sorting explanation from engine truth.');
    assert(Array.isArray(indexJson.table?.rows) && indexJson.table.rows.length > 0, 'Index Lab returned no current rows for the selected collection.');
    if (indexedCollection.indexes?.length) assert(indexJson.indexArtifact?.indexes?.length > 0, 'Persisted engine indexes were not exposed by Index Lab.');

    const html = await request('GET', '/');
    assert(html.status === 200 && /<title>OMEGA Observatory<\/title>/.test(html.body) && /data-view="authority"/.test(html.body) && /id="wal-scrubber"/.test(html.body) && /id="recovery-graph"/.test(html.body), 'GUI shell was not served with the expanded Observatory theaters.');
    assert(String(html.headers['content-security-policy'] || '').includes("default-src 'self'"), 'CSP header missing.');

    const assets = await Promise.all(['/index-lab.js','/index-lab.css','/wal-theater.js','/recovery-theater.js','/recovery-theater.css'].map(route => request('GET', route)));
    assert(assets.every(x => x.status === 200), 'One or more Observatory theater assets were not served.');
    assert(/engineIndexStructure|IndexLab/.test(assets[0].body), 'Index Lab script identity missing.');
    assert(/wal-scrubber|WAL/.test(assets[2].body), 'WAL theater script identity missing.');
    assert(/recovery-graph|authority-ledger/.test(assets[3].body), 'Recovery theater script identity missing.');

    const post = await request('POST', '/api/snapshot');
    const indexPost = await request('POST', indexPath);
    const recoveryPost = await request('POST', '/api/recovery-graph');
    const authorityPost = await request('POST', '/api/authority-ledger');
    assert(post.status === 405 && indexPost.status === 405 && recoveryPost.status === 405 && authorityPost.status === 405, 'A read-only Observatory API accepted a mutation method.');

    const arbitrary = await request('GET', '/api/file?path=../../../../etc/passwd');
    const traversal = await request('GET', '/%2e%2e/%2e%2e/etc/passwd');
    const hostileCollection = await request('GET', '/api/index-lab?collection=..%2F..%2F..%2Fetc%2Fpasswd');
    const recoveryPathProbe = await request('GET', '/api/recovery-graph?path=../../../../etc/passwd');
    const authorityPathProbe = await request('GET', '/api/authority-ledger?path=../../../../etc/passwd');
    assert(arbitrary.status === 404, 'Arbitrary file route unexpectedly exists.');
    assert(traversal.status === 404, 'Traversal request unexpectedly resolved.');
    assert(hostileCollection.status === 404, 'Hostile Index Lab collection escaped the canonical catalog allowlist.');
    assert(recoveryPathProbe.status === 200 && JSON.parse(recoveryPathProbe.body).format === recovery.format, 'Recovery graph query parameter changed route semantics.');
    assert(authorityPathProbe.status === 200 && JSON.parse(authorityPathProbe.body).format === authority.format, 'Authority ledger query parameter changed route semantics.');

    const afterObservation = await canonicalSnapshot();
    assert(afterObservation.digest === before.digest, `Observer mutated canonical engine storage.\nbefore=${before.digest}\nafter=${afterObservation.digest}`);

    const probeRow = indexJson.table.rows[0];
    const originalIndexTx = Number(indexJson.indexArtifact?.tx || 0);
    const indexEventPromise = waitForObservation(event => event.type === 'INDEX_CHANGED' && event.source === `indexes/${indexedCollection.name}.json`);
    await new Promise(r => setTimeout(r, 450));
    const probeValue = Date.now();
    await runInline(`
      const { MonsterEngine } = require('./monster/engine');
      (async () => {
        const engine = new MonsterEngine(process.cwd());
        const result = await engine.transact([{ type: 'update', collection: ${JSON.stringify(indexedCollection.name)}, id: ${JSON.stringify(probeRow.id)}, patch: { _observatoryProbe: ${JSON.stringify(probeValue)} } }]);
        process.stdout.write(JSON.stringify(result));
      })().catch(error => { console.error(error.stack || error); process.exit(1); });
    `);
    const indexObserved = await indexEventPromise;
    assert(indexObserved.mode === 'LIVE' && indexObserved.family === 'index' && indexObserved.from === 'current' && indexObserved.to === 'index', 'Index event was not normalized as a live current -> index movement.');

    await new Promise(r => setTimeout(r, 650));
    const afterExternalIndexMutation = await canonicalSnapshot();
    const refreshedIndexResponse = await request('GET', indexPath);
    const refreshedIndex = JSON.parse(refreshedIndexResponse.body);
    assert(Number(refreshedIndex.indexArtifact?.tx || 0) > originalIndexTx, 'Index Lab did not observe the committed transaction in persisted index metadata.');
    assert(refreshedIndex.table.rows.some(row => row.id === probeRow.id && row._observatoryProbe === probeValue), 'Index Lab did not observe the externally committed row update.');
    await Promise.all([request('GET', '/api/snapshot'), request('GET', '/api/recovery-graph'), request('GET', '/api/authority-ledger'), request('GET', '/wal-theater.js'), request('GET', '/recovery-theater.js')]);
    await new Promise(r => setTimeout(r, 650));
    const afterIndexObservation = await canonicalSnapshot();
    assert(afterExternalIndexMutation.digest === afterIndexObservation.digest, 'Observatory changed canonical storage after observing real index activity.');

    const checkpointPromise = waitForObservation(event => ['CHECKPOINT_CHANGED', 'ENGINE_METADATA_CHANGED'].includes(event.type));
    await new Promise(r => setTimeout(r, 350));
    await runNode(path.join(labRoot, 'monster-cli.js'), ['checkpoint']);
    const checkpointObserved = await checkpointPromise;
    assert(checkpointObserved.mode === 'LIVE', 'Checkpoint observation was not marked LIVE.');

    await new Promise(r => setTimeout(r, 650));
    const afterExternalCheckpoint = await canonicalSnapshot();
    await Promise.all([request('GET', '/api/snapshot'), request('GET', '/api/recovery-graph'), request('GET', '/api/authority-ledger')]);
    await new Promise(r => setTimeout(r, 650));
    const afterCheckpointObservation = await canonicalSnapshot();
    assert(afterExternalCheckpoint.digest === afterCheckpointObservation.digest, 'Observatory changed canonical storage after observing external checkpoint activity.');

    const report = {
      format: 'JSONDB-OMEGA-OBSERVATORY-SELFTEST-3',
      ok: true,
      authority: 'READ_ONLY_OBSERVER',
      observerMutationBoundary: { before: before.digest, afterReadOnlyInteraction: afterObservation.digest, unchanged: before.digest === afterObservation.digest },
      walTheater: { mode: 'REPLAY_BROWSER_MEMORY_ONLY', entriesObserved: snapshotJson.wal?.length || 0, staticAssetServed: assets[2].status === 200 },
      recoveryGraph: { nodes: recovery.nodes.length, edges: recovery.edges.length, automaticPromoters: recovery.nodes.filter(node => node.mayPromoteCanonical).length, postDenied: recoveryPost.status === 405 },
      authorityTheater: { decisions: authority.decisions.length, headHash: authority.headHash, postDenied: authorityPost.status === 405 },
      indexLabTruthBoundary: { collection: indexedCollection.name, engineIndexStructure: indexJson.truth.engineIndexStructure, sortAnimation: indexJson.truth.sortAnimation, hostileCollectionDenied: hostileCollection.status === 404, postDenied: indexPost.status === 405 },
      liveIndexObservation: { seen: true, type: indexObserved.type, family: indexObserved.family, source: indexObserved.source, mutation: indexObserved.mutation, from: indexObserved.from, to: indexObserved.to, persistedIndexTxAdvanced: Number(refreshedIndex.indexArtifact?.tx || 0) > originalIndexTx, committedProbeVisible: true },
      postIndexObservationBoundary: { afterExternalMutation: afterExternalIndexMutation.digest, afterObserverReads: afterIndexObservation.digest, unchanged: afterExternalIndexMutation.digest === afterIndexObservation.digest },
      liveCheckpointObservation: { seen: true, type: checkpointObserved.type, family: checkpointObserved.family, source: checkpointObserved.source },
      postCheckpointObservationBoundary: { afterExternalMutation: afterExternalCheckpoint.digest, afterObserverRead: afterCheckpointObservation.digest, unchanged: afterExternalCheckpoint.digest === afterCheckpointObservation.digest },
      adversarialHttp: { snapshotPostDenied: post.status === 405, indexLabPostDenied: indexPost.status === 405, recoveryPostDenied: recoveryPost.status === 405, authorityPostDenied: authorityPost.status === 405, arbitraryFileUnavailable: arbitrary.status === 404, traversalUnavailable: traversal.status === 404, hostileCollectionDenied: hostileCollection.status === 404, recoveryPathInputIgnored: recoveryPathProbe.status === 200, authorityPathInputIgnored: authorityPathProbe.status === 200, cspPresent: true }
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 150));
    if (server.exitCode && server.exitCode !== 0) process.stderr.write(`${serverErr}\n${serverOut}\n`);
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
