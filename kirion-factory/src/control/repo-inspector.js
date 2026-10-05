'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

function run(command, args, cwd, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(Object.assign(new Error(`${command} ${args.join(' ')} failed: ${stderr.trim()}`), { code: 'COMMAND_FAILED' }));
      resolve(stdout.trim());
    });
  });
}

async function exists(file) {
  try { await fsp.access(file); return true; } catch { return false; }
}

async function inspectRepository(repositoryPath) {
  const root = path.resolve(String(repositoryPath || ''));
  if (!repositoryPath || !(await exists(root))) throw Object.assign(new Error('Repository path does not exist.'), { status: 400 });

  const top = await run('git', ['rev-parse', '--show-toplevel'], root);
  if (path.resolve(top) !== root) throw Object.assign(new Error('Repository path must point at the Git worktree root.'), { status: 400 });

  const [head, branch, dirty, trackedRaw] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], root),
    run('git', ['branch', '--show-current'], root),
    run('git', ['status', '--porcelain'], root),
    run('git', ['ls-files'], root)
  ]);

  const tracked = trackedRaw.split(/\r?\n/).filter(Boolean);
  const manifests = {};
  for (const name of ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod']) {
    if (tracked.includes(name) && await exists(path.join(root, name))) manifests[name] = true;
  }

  let packageSummary = null;
  if (manifests['package.json']) {
    try {
      const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
      packageSummary = {
        name: pkg.name || null,
        scripts: Object.keys(pkg.scripts || {}).sort().slice(0, 50),
        dependencies: Object.keys(pkg.dependencies || {}).sort().slice(0, 80),
        devDependencies: Object.keys(pkg.devDependencies || {}).sort().slice(0, 80)
      };
    } catch {
      packageSummary = { parseError: true };
    }
  }

  return {
    root,
    head,
    branch: branch || '(detached)',
    dirty: Boolean(dirty),
    trackedFileCount: tracked.length,
    representativeFiles: tracked.slice(0, 250),
    manifests,
    packageSummary
  };
}

module.exports = { inspectRepository, run };
