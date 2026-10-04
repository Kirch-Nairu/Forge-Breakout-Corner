#!/usr/bin/env node
'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { FederatedOmegaKernel } = require('./monster/federated-kernel');

const kernel = new FederatedOmegaKernel(__dirname);
const bootstrap = process.argv.includes('--bootstrap');

function isAbsent(value) {
  return value?.status === 'ABSENT' || value?.status === 'NOT_PRESENT';
}

async function check(name, fn, options = {}) {
  try {
    const value = await fn();
    const absent = isAbsent(value);
    const ok = absent ? options.absentOkay !== false : value?.valid !== false;
    return { name, ok, absent, value };
  } catch (error) {
    return { name, ok: false, absent: false, error: error.stack || error.message };
  }
}

async function sha256File(file) {
  const body = await fsp.readFile(file);
  return crypto.createHash('sha256').update(body).digest('hex');
}

function statEvidence(stat) {
  return {
    mode: stat.mode,
    ino: Number(stat.ino || 0),
    dev: Number(stat.dev || 0),
    nlink: Number(stat.nlink || 0),
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  };
}

async function snapshotTree(root) {
  const rows = [];
  const walk = async (target, rel = '.') => {
    let stat;
    try { stat = await fsp.lstat(target); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const metadata = statEvidence(stat);
    if (stat.isDirectory()) {
      rows.push({ path: rel, type: 'dir', ...metadata });
      const entries = await fsp.readdir(target, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) await walk(path.join(target, entry.name), path.join(rel, entry.name));
      return;
    }
    if (stat.isFile()) {
      rows.push({ path: rel, type: 'file', size: stat.size, sha256: await sha256File(target), ...metadata });
      return;
    }
    if (stat.isSymbolicLink()) {
      rows.push({ path: rel, type: 'symlink', target: await fsp.readlink(target), ...metadata });
      return;
    }
    rows.push({ path: rel, type: 'other', ...metadata });
  };
  await walk(root);
  return rows;
}

async function snapshotPolicySurface() {
  const surfaces = {
    recoveryContracts: kernel.recoveryContracts.root,
    authorityFirewall: kernel.authorityFirewall.root,
    recoveryNavigator: kernel.recoveryNavigator.root,
    policyCheckpoint: kernel.policyCheckpoint.root,
    proofPlan: kernel.proofPlan.root,
    planMutation: kernel.planMutation.root,
    mutationAudit: kernel.mutationAudit.root,
    lastSavior: kernel.lastSavior.root
  };
  const out = {};
  for (const [name, root] of Object.entries(surfaces)) out[name] = await snapshotTree(root);
  return out;
}

function sameSnapshot(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function changedSurfaces(before, after) {
  const names = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...names].filter(name => JSON.stringify(before?.[name] || []) !== JSON.stringify(after?.[name] || []));
}

async function main() {
  const readOnly = !bootstrap;
  const before = readOnly ? await snapshotPolicySurface() : null;

  if (bootstrap) await kernel.init();

  const checks = [];
  checks.push(await check('recovery-contracts', () => bootstrap ? kernel.recoveryContracts.analyze() : kernel.recoveryContracts.inspect()));
  checks.push(await check('authority-firewall-ledger', () => kernel.authorityFirewall.verifyLedger({ readOnly })));
  checks.push(await check('forward-witness-chain', () => kernel.forwardWitness.verifyAll()));
  checks.push(await check('time-weave', () => kernel.timeWeave.verifyAll()));
  checks.push(await check('latest-policy-checkpoint', () => kernel.policyCheckpoint.verify(null, { readOnly })));
  checks.push(await check('latest-proof-plan', () => kernel.proofPlan.verify(null, { readOnly })));
  checks.push(await check('latest-plan-mutation', () => kernel.planMutation.verify(null, { readOnly })));
  checks.push(await check('independent-mutation-audit', () => kernel.mutationAudit.verify(null, { readOnly })));
  checks.push(await check('latest-history-court', () => kernel.historyCourt.verify()));
  checks.push(await check('latest-last-savior', () => kernel.lastSavior.verify(null, { live: false, readOnly })));

  const after = readOnly ? await snapshotPolicySurface() : null;
  const policySurfaceUnchanged = readOnly ? sameSnapshot(before, after) : null;
  const mutatedSurfaces = readOnly ? changedSurfaces(before, after) : [];
  if (readOnly) {
    checks.push({
      name: 'forensic-policy-surface-unchanged',
      ok: policySurfaceUnchanged,
      absent: false,
      value: {
        valid: policySurfaceUnchanged,
        status: policySurfaceUnchanged ? 'UNCHANGED' : 'MUTATED',
        mutatedSurfaces
      }
    });
  }

  const presentFailures = checks.filter(x => !x.ok);
  const report = {
    format: 'JSONDB-RECOVERY-SELFTEST-3',
    mode: bootstrap ? 'BOOTSTRAP_AND_VERIFY' : 'FORENSIC_READ_ONLY',
    readOnly,
    ok: presentFailures.length === 0,
    policySurfaceUnchanged,
    mutatedSurfaces,
    checks: checks.map(x => ({
      name: x.name,
      ok: x.ok,
      absent: x.absent,
      status: x.value?.status || null,
      valid: x.value?.valid,
      error: x.error || x.value?.error || null
    })),
    failures: presentFailures.map(x => x.name),
    doctrine: bootstrap
      ? 'Bootstrap mode may initialize and migrate recovery metadata before verification.'
      : 'Forensic mode does not initialize the federated kernel. It compares hashes plus inode/device/link/mode/mtime/ctime metadata and fails if the policy/recovery evidence surface changes during verification. Access time is intentionally excluded. ABSENT optional artifacts do not fail the self-test; any present artifact that verifies false does.'
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
