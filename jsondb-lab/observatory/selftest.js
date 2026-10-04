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
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
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

    const html = await request('GET', '/');
    assert(html.status === 200 && /OMEGA OBSERVATORY/.test(html.body), 'GUI shell was not served.');
    assert(String(html.headers['content-security-policy'] || '').includes("default-src 'self'"), 'CSP header missing.');

    const head = await request('HEAD', '/styles.css');
    assert(head.status === 200, 'HEAD static request failed.');

    const post = await request('POST', '/api/snapshot');
    assert(post.status === 405, 'Mutation method was not denied.');

    const arbitrary = await request('GET', '/api/file?path=../../../../etc/passwd');
    assert(arbitrary.status === 404, 'Arbitrary file route unexpectedly exists.');

    const traversal = await request('GET', '/%2e%2e/%2e%2e/etc/passwd');
    assert(traversal.status === 404, 'Traversal request unexpectedly resolved.');

    const afterObservation = await canonicalSnapshot();
    assert(afterObservation.digest === before.digest, `Observer mutated canonical engine storage.\nbefore=${before.digest}\nafter=${afterObservation.digest}`);

    const observedPromise = waitForObservation(event => ['CHECKPOINT_CHANGED', 'SNAPSHOT_CHANGED', 'ENGINE_METADATA_CHANGED', 'INDEX_CHANGED'].includes(event.type));
    await new Promise(r => setTimeout(r, 500));
    await runNode(path.join(labRoot, 'monster-cli.js'), ['checkpoint']);
    const observed = await observedPromise;
    assert(observed.mode === 'LIVE', 'Observed event was not marked LIVE.');

    await new Promise(r => setTimeout(r, 700));
    const afterExternalMutation = await canonicalSnapshot();
    await request('GET', '/api/snapshot');
    await new Promise(r => setTimeout(r, 700));
    const afterPostMutationObservation = await canonicalSnapshot();
    assert(afterExternalMutation.digest === afterPostMutationObservation.digest, 'Observatory changed canonical storage after observing external activity.');

    const report = {
      format: 'JSONDB-OMEGA-OBSERVATORY-SELFTEST-1',
      ok: true,
      authority: 'READ_ONLY_OBSERVER',
      observerMutationBoundary: {
        before: before.digest,
        afterReadOnlyInteraction: afterObservation.digest,
        unchanged: before.digest === afterObservation.digest
      },
      liveObservation: {
        seen: true,
        type: observed.type,
        family: observed.family,
        source: observed.source,
        mutation: observed.mutation,
        from: observed.from,
        to: observed.to
      },
      postExternalObservationBoundary: {
        afterExternalMutation: afterExternalMutation.digest,
        afterObserverRead: afterPostMutationObservation.digest,
        unchanged: afterExternalMutation.digest === afterPostMutationObservation.digest
      },
      adversarialHttp: {
        postDenied: post.status === 405,
        arbitraryFileUnavailable: arbitrary.status === 404,
        traversalUnavailable: traversal.status === 404,
        cspPresent: true
      }
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 150));
    if (server.exitCode && server.exitCode !== 0) process.stderr.write(`${serverErr}\n${serverOut}\n`);
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
