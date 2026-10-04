#!/usr/bin/env node
'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { FederatedOmegaKernel } = require('./monster/federated-kernel');

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function treeEvidence(root) {
  const rows = [];
  async function walk(target, rel = '.') {
    let stat;
    try { stat = await fsp.lstat(target); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isDirectory()) {
      const entries = await fsp.readdir(target, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) await walk(path.join(target, entry.name), path.join(rel, entry.name));
      return;
    }
    if (stat.isFile()) {
      const body = await fsp.readFile(target);
      rows.push({ path: rel.split(path.sep).join('/'), bytes: body.length, sha256: sha(body) });
      return;
    }
    if (stat.isSymbolicLink()) {
      rows.push({ path: rel.split(path.sep).join('/'), symlink: await fsp.readlink(target) });
    }
  }
  await walk(root);
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return { rows, digest: sha(Buffer.from(JSON.stringify(rows))) };
}

async function canonicalStorageEvidence(engine) {
  const surfaces = [
    ['catalog.json', engine.catalogFile],
    ['meta.json', engine.metaFile],
    ['wal.jsonl', engine.wal],
    ['current', engine.current],
    ['indexes', engine.indexes],
    ['versions', engine.versions],
    ['segments', engine.segments],
    ['tx', engine.txdir],
    ['checkpoints', engine.checkpoints],
    ['snapshots', engine.snapshots],
    ['views', engine.views],
    ['integrity', engine.integrityDir]
  ];
  const rows = [];
  for (const [label, target] of surfaces) {
    const evidence = await treeEvidence(target);
    for (const row of evidence.rows) {
      const suffix = row.path === '.' ? '' : `/${row.path.replace(/^\.\//, '')}`;
      rows.push({ ...row, path: `${label}${suffix}` });
    }
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return { rows, digest: sha(Buffer.from(JSON.stringify(rows))) };
}

function evidenceDiff(before, after) {
  const A = new Map((before?.rows || []).map(row => [row.path, row]));
  const B = new Map((after?.rows || []).map(row => [row.path, row]));
  const paths = [...new Set([...A.keys(), ...B.keys()])].sort();
  const changed = [];
  for (const file of paths) {
    const a = A.get(file) || null;
    const b = B.get(file) || null;
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push({ path: file, before: a, after: b });
  }
  return changed;
}

async function main() {
  const kernel = new FederatedOmegaKernel(__dirname);
  await kernel.init();

  const archive = await kernel.lastSavior.create('authority-selftest', {
    scatter: false,
    deepMedia: false,
    verifyArchives: false,
    monteCarloIterations: 250,
    syndromeChecksPerNode: 2,
    shadowLawsPerCollection: 2,
    hologramWidth: 16,
    hologramProjections: 2,
    oligoBytes: 128,
    oligoGroupSize: 4,
    spacetimeEpochs: 2,
    spacetimeColumns: 2
  });
  if (!archive?.id) throw new Error('Authority-boundary LAST SAVIOR fixture creation failed.');

  const beforeWorld = await kernel.world();
  const beforeCanonical = await kernel.canonicalQuorum.verify(beforeWorld, { readOnly: true, freezeOnDivergence: false });
  if (!beforeCanonical.unanimous) throw new Error('Pre-ceremony canonicalization quorum diverged.');

  const baselineCanonicalStorage = await canonicalStorageEvidence(kernel.engine);
  const baselineRecoveryEvidence = await treeEvidence(kernel.savior.root);
  let previousCanonicalStorage = baselineCanonicalStorage;
  let previousRecoveryEvidence = baselineRecoveryEvidence;
  const storageCheckpoints = [];
  const checkpointStorage = async name => {
    const canonical = await canonicalStorageEvidence(kernel.engine);
    const recoveryEvidence = await treeEvidence(kernel.savior.root);
    const canonicalChangedSincePrevious = evidenceDiff(previousCanonicalStorage, canonical);
    const canonicalChangedSinceBaseline = evidenceDiff(baselineCanonicalStorage, canonical);
    const evidenceChangedSincePrevious = evidenceDiff(previousRecoveryEvidence, recoveryEvidence);
    const evidenceChangedSinceBaseline = evidenceDiff(baselineRecoveryEvidence, recoveryEvidence);
    storageCheckpoints.push({
      name,
      canonical: {
        digest: canonical.digest,
        unchangedSincePrevious: canonicalChangedSincePrevious.length === 0,
        unchangedSinceBaseline: canonicalChangedSinceBaseline.length === 0,
        changedSincePrevious: canonicalChangedSincePrevious,
        changedSinceBaseline: canonicalChangedSinceBaseline
      },
      recoveryEvidence: {
        digest: recoveryEvidence.digest,
        unchangedSincePrevious: evidenceChangedSincePrevious.length === 0,
        unchangedSinceBaseline: evidenceChangedSinceBaseline.length === 0,
        changedSincePrevious: evidenceChangedSincePrevious,
        changedSinceBaseline: evidenceChangedSinceBaseline
      }
    });
    previousCanonicalStorage = canonical;
    previousRecoveryEvidence = recoveryEvidence;
    return { canonical, recoveryEvidence };
  };

  const directCases = [
    ['recovery-navigator', 'PRESERVE_EVIDENCE', true],
    ['recovery-jury', 'NOMINATE_CANDIDATE', true],
    ['jury-promotion-gate', 'OPEN_PROMOTION_CEREMONY', true],
    ['promotion-ceremony', 'AUTHORIZE_INTENT', true],
    ['recovery-navigator', 'OPEN_PROMOTION_CEREMONY', false],
    ['recovery-navigator', 'AUTHORIZE_INTENT', false],
    ['recovery-navigator', 'PROMOTE_CANONICAL', false],
    ['recovery-jury', 'PROMOTE_CANONICAL', false],
    ['jury-promotion-gate', 'PROMOTE_CANONICAL', false],
    ['promotion-ceremony', 'PROMOTE_CANONICAL', false],
    ['recovery-jury', 'WRITE_CANONICAL_RECOVERY', false],
    ['promotion-ceremony', 'WRITE_CANONICAL_RECOVERY', false],
    ['recovery-jury', 'SILENTLY_RAISE_AUTHORITY', false],
    ['promotion-ceremony', 'SILENTLY_RAISE_AUTHORITY', false]
  ];
  const firewall = [];
  for (const [actor, action, expectedAllowed] of directCases) {
    const decision = await kernel.authorityFirewall.decide(actor, action, { purpose: 'authority-selftest' });
    firewall.push({ actor, action, expectedAllowed, allowed: decision.allowed, reason: decision.reason, sequence: decision.sequence, decisionHash: decision.decisionHash });
    if (decision.allowed !== expectedAllowed) {
      throw new Error(`Authority Firewall mismatch for ${actor} -> ${action}: expected ${expectedAllowed}, got ${decision.allowed}`);
    }
  }
  await checkpointStorage('after-direct-firewall-decisions');

  const sandboxFile = path.join(__dirname, 'authority-selftest-candidate.json');
  await fsp.writeFile(sandboxFile, `${JSON.stringify(beforeWorld, null, 2)}\n`, 'utf8');

  const jury = await kernel.recoveryJury.deliberate(sandboxFile, { archiveId: archive.id });
  const juryVerify = await kernel.recoveryJury.verify(jury.id);
  if (!juryVerify.valid) throw new Error('Recovery Jury fixture failed verification.');
  if (jury.verdict !== 'EXACT') throw new Error(`Expected EXACT Jury verdict, got ${jury.verdict}.`);
  await checkpointStorage('after-jury-deliberation');

  const gate = await kernel.juryGate.open(jury.id, { expiresMinutes: 30, target: 'canonical-world' });
  const gateBeforeApprovals = await kernel.juryGate.verify(gate.warrant.id);
  if (!gateBeforeApprovals.valid) throw new Error('Jury Promotion Gate warrant failed verification before approvals.');
  if (gateBeforeApprovals.promotion.authorized) throw new Error('Promotion unexpectedly authorized before human threshold approvals.');
  await checkpointStorage('after-gate-open');

  const operators = await kernel.promotion.init();
  const threshold = Number(operators.threshold || 0);
  const active = (operators.operators || []).filter(x => !x.revokedAt);
  if (threshold < 2 || active.length < threshold) throw new Error('Promotion operator threshold fixture is not usable.');

  const approvalResults = [];
  for (const operator of active.slice(0, threshold)) {
    const result = await kernel.promotion.approve(gate.proposal.id, operator.id);
    approvalResults.push({ operatorId: operator.id, authorized: result.authorized, validApprovals: result.validApprovals, threshold: result.threshold });
  }
  await checkpointStorage('after-human-approvals');

  const promotion = await kernel.promotion.verify(gate.proposal.id);
  if (!promotion.authorized || promotion.status !== 'AUTHORIZED_MANUAL_PROMOTION') {
    throw new Error('Human threshold ceremony failed to authorize intent.');
  }
  const certificate = await kernel.promotion.certificate(gate.proposal.id);
  if (certificate.executable !== false) throw new Error('Promotion certificate became executable.');
  const gateAfterApprovals = await kernel.juryGate.verify(gate.warrant.id);
  if (!gateAfterApprovals.valid || gateAfterApprovals.status !== 'HUMAN_THRESHOLD_AUTHORIZED') {
    throw new Error('Jury Promotion Gate did not report human-threshold authorization.');
  }
  await checkpointStorage('after-certificate');

  const postCeremonyDenials = [];
  for (const [actor, action] of [
    ['promotion-ceremony', 'PROMOTE_CANONICAL'],
    ['promotion-ceremony', 'WRITE_CANONICAL_RECOVERY'],
    ['jury-promotion-gate', 'PROMOTE_CANONICAL'],
    ['recovery-jury', 'PROMOTE_CANONICAL']
  ]) {
    const decision = await kernel.authorityFirewall.decide(actor, action, { purpose: 'authority-selftest-post-human-threshold' });
    postCeremonyDenials.push({ actor, action, allowed: decision.allowed, reason: decision.reason, sequence: decision.sequence, decisionHash: decision.decisionHash });
    if (decision.allowed) throw new Error(`Authority escalated after human threshold: ${actor} -> ${action}`);
  }
  const finalStorage = await checkpointStorage('after-post-threshold-denials');

  const afterWorld = await kernel.world();
  const afterCanonical = await kernel.canonicalQuorum.verify(afterWorld, { readOnly: true, freezeOnDivergence: false });
  const firewallCheck = await kernel.authorityFirewall.verifyLedger({ readOnly: true });

  const changedCanonicalStoragePaths = evidenceDiff(baselineCanonicalStorage, finalStorage.canonical);
  const changedRecoveryEvidencePaths = evidenceDiff(baselineRecoveryEvidence, finalStorage.recoveryEvidence);
  const assertions = {
    exactJuryVerdict: jury.verdict === 'EXACT' && juryVerify.valid === true,
    gateOpenedButDidNotAuthorizeEarly: gateBeforeApprovals.valid === true && gateBeforeApprovals.promotion.authorized === false,
    humanThresholdAuthorizedIntent: promotion.authorized === true && gateAfterApprovals.status === 'HUMAN_THRESHOLD_AUTHORIZED',
    certificateNonExecutable: certificate.executable === false,
    allMachinePromotionAttemptsDenied: firewall.filter(x => ['PROMOTE_CANONICAL','WRITE_CANONICAL_RECOVERY','SILENTLY_RAISE_AUTHORITY'].includes(x.action)).every(x => x.allowed === false),
    postThresholdPromotionStillDenied: postCeremonyDenials.every(x => x.allowed === false),
    canonicalSemanticStateUnchanged: beforeCanonical.semanticSha256 === afterCanonical.semanticSha256,
    canonicalStorageBytesUnchanged: changedCanonicalStoragePaths.length === 0,
    firewallLedgerValid: firewallCheck.valid === true
  };

  const report = {
    format: 'JSONDB-RECOVERY-AUTHORITY-SELFTEST-2',
    ok: Object.values(assertions).every(Boolean),
    archiveId: archive.id,
    jury: { id: jury.id, verdict: jury.verdict, confidence: jury.confidence, valid: juryVerify.valid },
    gate: { warrantId: gate.warrant.id, proposalId: gate.proposal.id, beforeApprovals: gateBeforeApprovals.status, afterApprovals: gateAfterApprovals.status },
    ceremony: { threshold, approvals: approvalResults, authorized: promotion.authorized, certificateId: certificate.certificateId, certificateExecutable: certificate.executable },
    canonical: {
      beforeSemanticSha256: beforeCanonical.semanticSha256,
      afterSemanticSha256: afterCanonical.semanticSha256,
      beforeStorageDigest: baselineCanonicalStorage.digest,
      afterStorageDigest: finalStorage.canonical.digest,
      changedStoragePaths: changedCanonicalStoragePaths
    },
    recoveryEvidence: {
      beforeStorageDigest: baselineRecoveryEvidence.digest,
      afterStorageDigest: finalStorage.recoveryEvidence.digest,
      changed: changedRecoveryEvidencePaths.length > 0,
      changedStoragePaths: changedRecoveryEvidencePaths
    },
    storageCheckpoints,
    assertions,
    firewall,
    postCeremonyDenials,
    doctrine: 'Recovery automation may preserve, reconstruct in sandbox, corroborate, nominate, and emit append-only audit evidence. Human threshold approval may authorize intent. Neither machine evidence nor human authorization mutates canonical engine storage; canonical promotion remains a separate manual boundary outside the recovery stack.'
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  await fsp.rm(sandboxFile, { force: true }).catch(() => {});
  if (!report.ok) {
    const failed = Object.entries(assertions).filter(([, ok]) => !ok).map(([name]) => name);
    throw new Error(`Recovery authority boundary assertions failed: ${failed.join(', ')}`);
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
