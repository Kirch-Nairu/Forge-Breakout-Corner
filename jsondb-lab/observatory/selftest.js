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
    assert(healthJson.ok === true && healthJson.authority === 'READ_ONLY_OBSERVER', 'Health endpoint did not declare healthy read-only authority.');

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
    assert(authority.authority === 'READ_ONLY_OBSERVER' && Array.isArray(authority.decisions), 'Authority ledger shape is invalid.');

    const historyResponse = await request('GET', '/api/history-map');
    assert(historyResponse.status === 200, `History map endpoint returned ${historyResponse.status}.`);
    const history = JSON.parse(historyResponse.body);
    assert(history.authority === 'READ_ONLY_OBSERVER', 'History map did not declare observer authority.');
    assert(Array.isArray(history.epochs) && Array.isArray(history.timeWeave) && Array.isArray(history.fossils), 'History map is missing timeline families.');

    const artifactListResponse = await request('GET', '/api/artifacts');
    assert(artifactListResponse.status === 200, `Artifact registry returned ${artifactListResponse.status}.`);
    const artifactList = JSON.parse(artifactListResponse.body);
    assert(artifactList.authority === 'READ_ONLY_OBSERVER' && Array.isArray(artifactList.artifacts), 'Artifact registry shape is invalid.');
    assert(artifactList.artifacts.every(item => /^artifact-[a-f0-9]{16}$/.test(item.id)), 'Artifact registry emitted a non-opaque ID.');
    assert(new Set(artifactList.artifacts.map(item => item.id)).size === artifactList.artifacts.length, 'Artifact registry emitted duplicate IDs.');
    const previewable = artifactList.artifacts.find(item => item.previewable);
    assert(previewable, 'Bootstrap produced no previewable artifact.');
    const artifactResponse = await request('GET', `/api/artifact?id=${encodeURIComponent(previewable.id)}`);
    assert(artifactResponse.status === 200, `Opaque artifact preview returned ${artifactResponse.status}.`);
    const artifact = JSON.parse(artifactResponse.body);
    assert(artifact.authority === 'READ_ONLY_OBSERVER' && artifact.artifact?.id === previewable.id && typeof artifact.content === 'string', 'Opaque artifact preview shape is invalid.');

    const indexedCollection = snapshotJson.collections.find(collection => collection.rows > 0 && collection.indexes?.length) || snapshotJson.collections.find(collection => collection.rows > 0) || snapshotJson.collections[0];
    assert(indexedCollection, 'Bootstrap produced no collection for Observatory Index Lab.');
    const indexPath = `/api/index-lab?collection=${encodeURIComponent(indexedCollection.name)}`;
    const indexResponse = await request('GET', indexPath);
    assert(indexResponse.status === 200, `Index Lab endpoint returned ${indexResponse.status}.`);
    const indexJson = JSON.parse(indexResponse.body);
    assert(indexJson.authority === 'READ_ONLY_OBSERVER' && indexJson.collection === indexedCollection.name, 'Index Lab identity mismatch.');
    assert(indexJson.truth?.engineIndexStructure === 'HASH_MAP' && indexJson.truth?.sortAnimation === 'EXPLAIN_ONLY', 'Index Lab failed to distinguish real hash indexing from sort explanation.');
    assert(Array.isArray(indexJson.table?.rows) && indexJson.table.rows.length > 0, 'Index Lab returned no current rows.');

    const html = await request('GET', '/');
    assert(html.status === 200 && /<title>OMEGA Observatory<\/title>/.test(html.body) && /data-view="authority"/.test(html.body) && /data-view="history"/.test(html.body) && /data-view="files"/.test(html.body) && /data-view="lab"/.test(html.body), 'Expanded Observatory GUI shell is missing views.');
    assert(String(html.headers['content-security-policy'] || '').includes("default-src 'self'"), 'CSP header missing.');

    const assetRoutes = ['/index-lab.js','/index-lab.css','/wal-theater.js','/recovery-theater.js','/recovery-theater.css','/history-lab.js','/artifacts.js','/failure-lab.js','/advanced-theater.css'];
    const assets = await Promise.all(assetRoutes.map(route => request('GET', route)));
    assert(assets.every(x => x.status === 200), 'One or more Observatory theater assets were not served.');

    const posts = await Promise.all(['/api/snapshot', indexPath, '/api/recovery-graph', '/api/authority-ledger', '/api/history-map', '/api/artifacts', `/api/artifact?id=${previewable.id}`].map(route => request('POST', route)));
    assert(posts.every(x => x.status === 405), 'A read-only Observatory API accepted a mutation method.');

    const arbitrary = await request('GET', '/api/file?path=../../../../etc/passwd');
    const traversal = await request('GET', '/%2e%2e/%2e%2e/etc/passwd');
    const hostileCollection = await request('GET', '/api/index-lab?collection=..%2F..%2F..%2Fetc%2Fpasswd');
    const hostileArtifact = await request('GET', '/api/artifact?id=..%2F..%2F..%2Fetc%2Fpasswd');
    const pathInsteadOfId = await request('GET', '/api/artifact?path=../../../../etc/passwd');
    assert(arbitrary.status === 404 && traversal.status === 404, 'Arbitrary path/traversal unexpectedly resolved.');
    assert(hostileCollection.status === 404, 'Hostile Index Lab collection escaped the canonical catalog allowlist.');
    assert(hostileArtifact.status === 404 && pathInsteadOfId.status === 404, 'Artifact endpoint accepted non-opaque path input.');

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
    const refreshedIndex = JSON.parse((await request('GET', indexPath)).body);
    assert(Number(refreshedIndex.indexArtifact?.tx || 0) > originalIndexTx, 'Index Lab did not observe committed transaction metadata.');
    assert(refreshedIndex.table.rows.some(row => row.id === probeRow.id && row._observatoryProbe === probeValue), 'Index Lab did not observe the externally committed row update.');
    await Promise.all([request('GET', '/api/snapshot'), request('GET', '/api/recovery-graph'), request('GET', '/api/authority-ledger'), request('GET', '/api/history-map'), request('GET', '/api/artifacts'), request('GET', `/api/artifact?id=${previewable.id}`)]);
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
    await Promise.all([request('GET', '/api/snapshot'), request('GET', '/api/history-map'), request('GET', '/api/artifacts')]);
    await new Promise(r => setTimeout(r, 650));
    const afterCheckpointObservation = await canonicalSnapshot();
    assert(afterExternalCheckpoint.digest === afterCheckpointObservation.digest, 'Observatory changed canonical storage after observing external checkpoint activity.');

    const report = {
      format: 'JSONDB-OMEGA-OBSERVATORY-SELFTEST-4',
      ok: true,
      authority: 'READ_ONLY_OBSERVER',
      observerMutationBoundary: { before: before.digest, afterReadOnlyInteraction: afterObservation.digest, unchanged: before.digest === afterObservation.digest },
      walTheater: { mode: 'REPLAY_BROWSER_MEMORY_ONLY', entriesObserved: snapshotJson.wal?.length || 0 },
      recoveryGraph: { nodes: recovery.nodes.length, edges: recovery.edges.length, automaticPromoters: recovery.nodes.filter(node => node.mayPromoteCanonical).length },
      authorityTheater: { decisions: authority.decisions.length, headHash: authority.headHash },
      historyTheater: { epochs: history.epochs.length, weaveNodes: history.timeWeave.length, fossils: history.fossils.length },
      artifactBoundary: { count: artifactList.artifacts.length, opaqueId: previewable.id, previewPath: previewable.path, hostileIdDenied: hostileArtifact.status === 404, rawPathInputDenied: pathInsteadOfId.status === 404 },
      failureLab: { mode: 'BROWSER_ONLY_COUNTERFACTUAL', serverMutationApiExists: false },
      indexLabTruthBoundary: { collection: indexedCollection.name, engineIndexStructure: indexJson.truth.engineIndexStructure, sortAnimation: indexJson.truth.sortAnimation },
      liveIndexObservation: { seen: true, source: indexObserved.source, from: indexObserved.from, to: indexObserved.to, persistedIndexTxAdvanced: Number(refreshedIndex.indexArtifact?.tx || 0) > originalIndexTx },
      postIndexObservationBoundary: { unchanged: afterExternalIndexMutation.digest === afterIndexObservation.digest },
      liveCheckpointObservation: { seen: true, type: checkpointObserved.type, family: checkpointObserved.family, source: checkpointObserved.source },
      postCheckpointObservationBoundary: { unchanged: afterExternalCheckpoint.digest === afterCheckpointObservation.digest },
      adversarialHttp: { allPostsDenied: posts.every(x => x.status === 405), arbitraryFileUnavailable: arbitrary.status === 404, traversalUnavailable: traversal.status === 404, hostileCollectionDenied: hostileCollection.status === 404, hostileArtifactDenied: hostileArtifact.status === 404, rawArtifactPathDenied: pathInsteadOfId.status === 404, cspPresent: true }
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 150));
    if (server.exitCode && server.exitCode !== 0) process.stderr.write(`${serverErr}\n${serverOut}\n`);
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
