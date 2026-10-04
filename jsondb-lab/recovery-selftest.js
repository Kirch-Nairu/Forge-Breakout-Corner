#!/usr/bin/env node
'use strict';

const { FederatedOmegaKernel } = require('./monster/federated-kernel');

const kernel = new FederatedOmegaKernel(__dirname);

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

async function main() {
  await kernel.init();

  const checks = [];
  checks.push(await check('recovery-contracts', () => kernel.recoveryContracts.analyze()));
  checks.push(await check('authority-firewall-ledger', () => kernel.authorityFirewall.verifyLedger()));
  checks.push(await check('forward-witness-chain', () => kernel.forwardWitness.verifyAll()));
  checks.push(await check('time-weave', () => kernel.timeWeave.verifyAll()));
  checks.push(await check('latest-policy-checkpoint', () => kernel.policyCheckpoint.verify()));
  checks.push(await check('latest-proof-plan', () => kernel.proofPlan.verify()));
  checks.push(await check('latest-plan-mutation', () => kernel.planMutation.verify()));
  checks.push(await check('independent-mutation-audit', () => kernel.mutationAudit.verify()));
  checks.push(await check('latest-history-court', () => kernel.historyCourt.verify()));
  checks.push(await check('latest-last-savior', () => kernel.lastSavior.verify(null, { live: false })));

  const presentFailures = checks.filter(x => !x.ok);
  const report = {
    format: 'JSONDB-RECOVERY-SELFTEST-1',
    ok: presentFailures.length === 0,
    checks: checks.map(x => ({
      name: x.name,
      ok: x.ok,
      absent: x.absent,
      status: x.value?.status || null,
      valid: x.value?.valid,
      error: x.error || x.value?.error || null
    })),
    failures: presentFailures.map(x => x.name),
    doctrine: 'ABSENT optional artifacts do not fail the self-test. Any present artifact that verifies false does.'
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
