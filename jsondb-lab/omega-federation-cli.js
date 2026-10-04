#!/usr/bin/env node
'use strict';

const path = require('path');
const { FederatedOmegaKernel } = require('./monster/federated-kernel');
const { readJson } = require('./monster/jsonfs');

const kernel = new FederatedOmegaKernel(__dirname);
function out(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function flag(args, name) { return args.includes(name); }
function nonflags(args) { return args.filter(x => !x.startsWith('--')); }
function option(args, prefix, fallback = null) { const hit = args.find(x => x.startsWith(`${prefix}=`)); return hit ? hit.slice(prefix.length + 1) : fallback; }
async function authorize(actor, action, detail = {}) { return kernel.authorityFirewall.assert(actor, action, { surface: 'omega-federation-cli', ...detail }); }

function usage() {
  console.log(`JSONDB OMEGA FEDERATION CLI\n\n  status [--deep]\n\nEPOCHS\n  epoch-seal [label] [--deep-media] [--verify-archives]\n  epoch-verify [id] [--live]\n\nFEDERATION\n  federation-seal [label] [--compare=<ref>] [--merge-preview] [--window=N]\n  federation-verify [id] [--live]\n  continuity-proof <fromEpochId> [toEpochId]\n\nTIME WEAVE / FORWARD WITNESS\n  weave-verify\n  weave-proof <fromEpochId> [toEpochId]\n  forward-witness <subjectHash> [label]\n  forward-witness-verify\n\nTEMPORAL PARITY\n  parity-seal [window]\n  parity-inspect [id]\n  parity-recover [id] [--repair-in-place]\n\nSPACETIME ARK\n  spacetime-seal [label] [epochs] [dataColumns]\n  spacetime-recover [id]\n  spacetime-scatter [id] [copiesPerCell]\n\nSEMANTIC DELTA FOSSILS\n  fossil-capture [label]\n  fossil-verify [id]\n  fossil-reconstruct <id> <forward|inverse> <output-file>\n\nHISTORY COURT\n  court <lineageA> <lineageB> [--merge-preview]\n  court-verify [id]\n\nCORROBORATION\n  shadow-capture [label] [lawsPerCollection]\n  shadow-challenge [id]\n  hologram-capture [label]\n  hologram-compare [id]\n\nRECOVERY GEOMETRY / CONTRACTS / NAVIGATOR\n  geometry [--remove=capabilityA,capabilityB]\n  contracts\n  contracts-analyze\n  contracts-reset\n  navigate [--goal=world|historical-epoch|tooling|any] [--remove=capabilityA,capabilityB] [--minimum-corroborators=N]\n  navigate-verify [planId]\n  mutate-plans [label] [--goal=world] [--pairs=N] [--minimum-corroborators=N]\n  mutate-plans-verify [id]\n\nAUTHORITY FIREWALL / POLICY CHECKPOINTS\n  firewall-decide <actor> <action>\n  firewall-verify\n  policy-checkpoint [label]\n  policy-verify [id]\n\nPROOF-CARRYING RECOVERY PLAN\n  proof-plan [label] [--plan=<navigatorPlanId>] [--allow-blocked]\n  proof-plan-verify [id]\n\nRECOVERY JURY / PROMOTION GATE\n  jury <candidate-world.json> [archiveId]\n  jury-verify [juryId]\n  jury-open-promotion [juryId] [expiresMinutes]\n  jury-gate-verify [warrantId]\n\nQUATERNARY COLD STORAGE\n  quaternary-archive [label] [oligoBytes] [groupSize]\n  quaternary-recover [generation]\n  quaternary-restore <output-file> [generation]\n\nROSETTA RECOVERY SPEC\n  rosetta-create [label]\n  rosetta-verify [id]\n\nEVIDENCE DIASPORA\n  diaspora-bundle [label]\n  diaspora-scatter [bundleId] [copies]\n  diaspora-verify [placementId]\n\nLAST SAVIOR\n  last-savior [label] [--no-scatter] [--verify-archives]\n  last-savior-verify [id] [--live]\n\nNo npm. No package manager. No external database.\nDangerous recovery surfaces are deny-by-default through Recovery Contracts + Authority Firewall.\nHistory may be reconstructed into sandboxes; ambiguity is preserved instead of silently collapsed.\n`);
}

async function latestEvidenceSources() {
  const rows = [];
  const add = async (name, file) => { if (await readJson(file, null).catch(() => null)) rows.push({ name, path: file }); };
  await add('FEDERATION.json', path.join(kernel.federation.root, 'latest.json'));
  await add('OMEGA-EPOCH.json', path.join(kernel.epochSealer.root, 'latest.json'));
  await add('TIME-WEAVE.json', path.join(kernel.timeWeave.root, 'latest.json'));
  await add('TEMPORAL-PARITY.json', path.join(kernel.temporalParity.root, 'latest.json'));
  await add('SPACETIME-ARK.json', path.join(kernel.spacetime.root, 'latest.json'));
  await add('SEMANTIC-FOSSIL.json', path.join(kernel.fossils.root, 'latest.json'));
  await add('RECOVERY-GEOMETRY.json', path.join(kernel.recoveryGeometry.root, 'latest.json'));
  await add('RECOVERY-CONTRACTS.json', kernel.recoveryContracts.file);
  await add('AUTHORITY-FIREWALL-HEAD.json', kernel.authorityFirewall.head);
  await add('RECOVERY-NAVIGATOR.json', path.join(kernel.recoveryNavigator.root, 'latest.json'));
  await add('POLICY-CHECKPOINT.json', path.join(kernel.policyCheckpoint.root, 'latest.json'));
  await add('PROOF-CARRYING-PLAN.json', path.join(kernel.proofPlan.root, 'latest.json'));
  await add('RECOVERY-PLAN-MUTATION.json', path.join(kernel.planMutation.root, 'latest.json'));
  await add('SEMANTIC-HOLOGRAM.json', path.join(kernel.hologram.root, 'latest.json'));
  await add('SHADOW-LAWS.json', path.join(kernel.shadowLaws.root, 'latest.json'));
  await add('FORWARD-WITNESS.json', path.join(kernel.forwardWitness.root, 'latest.json'));
  await add('HISTORY-COURT.json', path.join(kernel.historyCourt.root, 'latest.json'));
  await add('CIVILIZATION-SEED.json', path.join(kernel.civilizationSeed.root, 'latest.json'));
  await add('ROSETTA.json', path.join(kernel.rosetta.root, 'latest.json'));
  return rows;
}

async function main() {
  await kernel.init();
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) return usage();
  const plain = nonflags(args);

  if (cmd === 'status') return out(await kernel.status({ deep: flag(args, '--deep') }));

  if (cmd === 'epoch-seal') return out(await kernel.epochSealer.seal(plain[0] || 'federated-cli', { deepMedia: flag(args, '--deep-media'), verifyArchives: flag(args, '--verify-archives') }));
  if (cmd === 'epoch-verify') return out(await kernel.epochSealer.verify(plain[0] || null, { live: flag(args, '--live') }));

  if (cmd === 'federation-seal') return out(await kernel.federation.seal(plain[0] || 'federated-cli', { compareLineage: option(args, '--compare'), previewMerge: flag(args, '--merge-preview'), temporalWindow: Number(option(args, '--window', 8)), epoch: { deepMedia: true, verifyArchives: false } }));
  if (cmd === 'federation-verify') return out(await kernel.federation.verify(plain[0] || null, { live: flag(args, '--live') }));
  if (cmd === 'continuity-proof') return out(await kernel.federation.continuityProof(plain[0], plain[1] || null));

  if (cmd === 'weave-verify') return out(await kernel.timeWeave.verifyAll());
  if (cmd === 'weave-proof') return out(await kernel.timeWeave.proof(plain[0], plain[1] || null));
  if (cmd === 'forward-witness') return out(await kernel.forwardWitness.attest(plain[0], { label: plain[1] || 'federated-cli' }));
  if (cmd === 'forward-witness-verify') return out(await kernel.forwardWitness.verifyAll());

  if (cmd === 'parity-seal') return out(await kernel.temporalParity.seal({ window: Number(plain[0] || 8) }));
  if (cmd === 'parity-inspect') {
    const result = await kernel.temporalParity.inspect(plain[0] || null);
    result.states = result.states.map(({ buffer, ...x }) => x);
    result.parity = result.parity.map(({ buffer, ...x }) => x);
    return out(result);
  }
  if (cmd === 'parity-recover') {
    await authorize('temporal-parity', 'RECONSTRUCT_SANDBOX', { generation: plain[0] || null });
    if (flag(args, '--repair-in-place')) await authorize('temporal-parity', 'AUTO_REPAIR', { repair: 'historical-epoch-only-with-explicit-in-place-flag', generation: plain[0] || null });
    return out(await kernel.temporalParity.recover(plain[0] || null, { repairInPlace: flag(args, '--repair-in-place') }));
  }

  if (cmd === 'spacetime-seal') return out(await kernel.spacetime.seal(plain[0] || 'federated-cli', { epochs: Number(plain[1] || 8), dataColumns: Number(plain[2] || 6) }));
  if (cmd === 'spacetime-recover') {
    await authorize('spacetime-ark', 'RECONSTRUCT_SANDBOX', { generation: plain[0] || null });
    return out(await kernel.spacetime.recover(plain[0] || null));
  }
  if (cmd === 'spacetime-scatter') {
    await authorize('evidence-diaspora', 'TRANSPORT_EVIDENCE', { transport: 'spacetime-ark', generation: plain[0] || null });
    return out(await kernel.spacetime.scatter(plain[0] || null, { copiesPerCell: Number(plain[1] || 1) }));
  }

  if (cmd === 'fossil-capture') return out(await kernel.fossils.capture(plain[0] || 'federated-cli'));
  if (cmd === 'fossil-verify') return out(await kernel.fossils.verify(plain[0] || null));
  if (cmd === 'fossil-reconstruct') {
    await authorize('semantic-delta-fossils', 'RECONSTRUCT_SANDBOX', { fossilId: plain[0], direction: plain[1] || 'forward', output: path.resolve(plain[2]) });
    return out(await kernel.fossils.reconstruct(plain[0], plain[1] || 'forward', path.resolve(plain[2])));
  }

  if (cmd === 'court') return out(await kernel.historyCourt.compare(plain[0], plain[1], { previewMerge: flag(args, '--merge-preview') }));
  if (cmd === 'court-verify') return out(await kernel.historyCourt.verify(plain[0] || null));

  if (cmd === 'shadow-capture') return out(await kernel.shadowLaws.capture(plain[0] || 'federated-cli', { lawsPerCollection: Number(plain[1] || 12) }));
  if (cmd === 'shadow-challenge') return out(await kernel.shadowLaws.challenge(null, plain[0] || null));
  if (cmd === 'hologram-capture') return out(await kernel.hologram.capture(plain[0] || 'federated-cli'));
  if (cmd === 'hologram-compare') return out(await kernel.hologram.compare(null, plain[0] || null));

  if (cmd === 'geometry') return out(await kernel.recoveryGeometry.analyze({ remove: String(option(args, '--remove', '')).split(',').map(x => x.trim()).filter(Boolean) }));
  if (cmd === 'contracts') return out(await kernel.recoveryContracts.init());
  if (cmd === 'contracts-analyze') return out(await kernel.recoveryContracts.analyze());
  if (cmd === 'contracts-reset') return out(await kernel.recoveryContracts.reset());
  if (cmd === 'navigate') return out(await kernel.recoveryNavigator.plan({ goal: option(args, '--goal', 'world'), remove: String(option(args, '--remove', '')).split(',').map(x => x.trim()).filter(Boolean), minimumCorroborators: Number(option(args, '--minimum-corroborators', 2)) }));
  if (cmd === 'navigate-verify') return out(await kernel.recoveryNavigator.verify(plain[0] || null));
  if (cmd === 'mutate-plans') return out(await kernel.planMutation.run(plain[0] || 'federated-cli', { goal: option(args, '--goal', 'world'), pairLimit: Number(option(args, '--pairs', 12)), minimumCorroborators: Number(option(args, '--minimum-corroborators', 2)) }));
  if (cmd === 'mutate-plans-verify') return out(await kernel.planMutation.verify(plain[0] || null));

  if (cmd === 'firewall-decide') return out(await kernel.authorityFirewall.decide(plain[0], plain[1], { requestedFrom: 'omega-federation-cli' }));
  if (cmd === 'firewall-verify') return out(await kernel.authorityFirewall.verifyLedger());
  if (cmd === 'policy-checkpoint') return out(await kernel.policyCheckpoint.capture(plain[0] || 'federated-cli'));
  if (cmd === 'policy-verify') return out(await kernel.policyCheckpoint.verify(plain[0] || null));

  if (cmd === 'proof-plan') return out(await kernel.proofPlan.create(plain[0] || 'federated-cli', { planId: option(args, '--plan'), allowBlocked: flag(args, '--allow-blocked') }));
  if (cmd === 'proof-plan-verify') return out(await kernel.proofPlan.verify(plain[0] || null));

  if (cmd === 'jury') {
    await authorize('recovery-jury', 'NOMINATE_CANDIDATE', { candidate: path.resolve(plain[0]), archiveId: plain[1] || null });
    return out(await kernel.recoveryJury.deliberate(path.resolve(plain[0]), { archiveId: plain[1] || null }));
  }
  if (cmd === 'jury-verify') return out(await kernel.recoveryJury.verify(plain[0] || null));
  if (cmd === 'jury-open-promotion') return out(await kernel.juryGate.open(plain[0] || null, { expiresMinutes: Number(plain[1] || 60) }));
  if (cmd === 'jury-gate-verify') return out(await kernel.juryGate.verify(plain[0] || null));

  if (cmd === 'quaternary-archive') return out(await kernel.archiveWorldQuaternary(plain[0] || 'federated-cli', { oligoBytes: Number(plain[1] || 512), groupSize: Number(plain[2] || 8) }));
  if (cmd === 'quaternary-recover') {
    await authorize('quaternary-cold-codec', 'RECONSTRUCT_SANDBOX', { generation: plain[0] || null, mode: 'inspect-recovery' });
    const result = await kernel.quaternary.recover(plain[0] || null); delete result.buffer; return out(result);
  }
  if (cmd === 'quaternary-restore') {
    await authorize('quaternary-cold-codec', 'RECONSTRUCT_SANDBOX', { output: path.resolve(plain[0]), generation: plain[1] || null });
    return out(await kernel.quaternary.restore(path.resolve(plain[0]), plain[1] || null));
  }

  if (cmd === 'rosetta-create') return out(await kernel.rosetta.create(plain[0] || 'federated-cli'));
  if (cmd === 'rosetta-verify') return out(await kernel.rosetta.verify(plain[0] || null));

  if (cmd === 'diaspora-bundle') return out(await kernel.diaspora.createBundle(plain[0] || 'federated-cli', await latestEvidenceSources(), { source: 'omega-federation-cli' }));
  if (cmd === 'diaspora-scatter') {
    await authorize('evidence-diaspora', 'TRANSPORT_EVIDENCE', { bundleId: plain[0] || null, copies: plain[1] ? Number(plain[1]) : undefined });
    return out(await kernel.diaspora.scatter(plain[0] || null, { copies: plain[1] ? Number(plain[1]) : undefined }));
  }
  if (cmd === 'diaspora-verify') return out(await kernel.diaspora.verifyPlacement(plain[0] || null));

  if (cmd === 'last-savior') {
    if (!flag(args, '--no-scatter')) await authorize('evidence-diaspora', 'TRANSPORT_EVIDENCE', { transport: 'last-savior-evidence' });
    return out(await kernel.lastSavior.create(plain[0] || 'federated-cli', { scatter: !flag(args, '--no-scatter'), verifyArchives: flag(args, '--verify-archives') }));
  }
  if (cmd === 'last-savior-verify') return out(await kernel.lastSavior.verify(plain[0] || null, { live: flag(args, '--live') }));

  usage();
  process.exitCode = 2;
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
