#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { OmegaKernel } = require('./monster/omega-kernel');

const kernel = new OmegaKernel(__dirname);

function out(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function readSpec(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !k.startsWith('_')).map(([k,v]) => [k, clean(v)]));
  return value;
}
function firstNonFlag(args, fallback = null) { return args.find(x => !x.startsWith('--')) || fallback; }

function usage() {
  console.log(`JSONDB OMEGA CLI — LAST-SAVIOR OPERATOR SHELL

CORE / RUNTIME
  status [--deep]
  runtime-status
  clock-audit
  clock-ack <reason...>
  durability-probe
  reflex-sense [--verify-archives]
  reflex-respond [--verify-archives]
  reflex-reset <GREEN|YELLOW|ORANGE|RED|BLACK> <reason...>

TRUST / TRUTH
  oracle [--verify-archives]
  oracle-enforce [--verify-archives]
  trust-budget [--verify-archives]
  canonical <value.json>
  syndrome-build [checksPerNode]
  syndrome-diagnose [generation]
  conservation-register <law.json>
  conservation-learn <lawId> [label]
  conservation-scan

PROTECTED DATABASE
  tx <spec.json>
  nversion <spec.json>
  metamorphic <query.json>
  fabric-seal [label] [--ultimate]
  recovery-case [--fractal] [--challenge]
  emergency-seal <reason...>

WORLD TREE / HISTORY
  world-commit [label] [ref]
  world-branch <name> [from]
  world-log [ref] [limit]
  world-merge <ours-ref> <theirs-ref>
  courier-export [sinceSequence] [label]
  courier-verify <directory>
  courier-import <directory> [label]

RECOVERY MEDIA
  memory-snapshot [label]
  memory-verify [id]
  memory-ancestry [limit]
  format-archive [label]
  format-verify [id]
  fountain-archive [label] [sourceChunks] [redundancy]
  fountain-recover <directory>
  seed-create [label]
  seed-verify [id]

PHYSICAL MEDIA CONSTELLATION
  media-register <name> <path> [purpose]
  media-assess
  media-seed-export [label]
  media-fountain-scatter [copiesPerDroplet]
  media-inventory

CRYPTOGRAPHIC DIVERSITY
  crypto-attest [label]
  crypto-verify [id]
  hash-witness-public
  hash-policy
  hash-envelope <value.json>

THRESHOLD PROMOTION / KEY SHARDS
  promote-propose <sandbox-file> [expiresMinutes]
  promote-approve <proposalId> <operatorId>
  promote-verify <proposalId>
  promote-certificate <proposalId>
  keyshard-split <secret-file> [label] [threshold] [total]
  keyshard-recover <share-directory> <output-file>
  keyshard-export <groupId> <share-x> <target-directory>

COMPATIBILITY / REPAIR LAW
  compatibility-capture [label]
  compatibility-verify [id]
  migration-register <migration.json>
  migration-plan <from-format> <to-format>
  repair-propose <proposal.json>

No npm. No package manager. No account. No external database.
Automation may reduce authority. It never silently promotes recovered state.
`);
}

async function worldBuffer(label = 'omega-cli') {
  return Buffer.from(JSON.stringify(await kernel.world()));
}

async function main() {
  await kernel.init();
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) return usage();

  if (cmd === 'status') return out(await kernel.status({ deep: args.includes('--deep') }));
  if (cmd === 'runtime-status') return out(await kernel.runtime.status());
  if (cmd === 'clock-audit') return out(await kernel.clock.audit({ freezeOnRollback: false }));
  if (cmd === 'clock-ack') return out(await kernel.clock.acknowledge(args.join(' ') || 'OMEGA CLI acknowledgement'));
  if (cmd === 'durability-probe') return out(await kernel.durability.probe({ freezeOnFailure: true }));
  if (cmd === 'reflex-sense') return out(await kernel.reflex.sense({ verifyArchives: args.includes('--verify-archives') }));
  if (cmd === 'reflex-respond') return out(await kernel.reflex.respond({ verifyArchives: args.includes('--verify-archives') }));
  if (cmd === 'reflex-reset') return out(await kernel.reflex.operatorReset(args[0], args.slice(1).join(' ') || 'OMEGA CLI operator reset'));

  if (cmd === 'oracle' || cmd === 'oracle-enforce') {
    const options = { verifyArchives: args.includes('--verify-archives') };
    return out(cmd === 'oracle' ? await kernel.oracle.assess(options) : await kernel.oracle.enforce(options));
  }
  if (cmd === 'trust-budget') return out(kernel.trustBudget.evaluate(await kernel.oracle.assess({ verifyArchives: args.includes('--verify-archives') })));
  if (cmd === 'canonical') { const result = await kernel.canonicalQuorum.verify(readSpec(args[0]), { freezeOnDivergence: true }); return out(clean(result)); }
  if (cmd === 'syndrome-build') return out(await kernel.syndrome.build({ checksPerNode: Number(args[0] || 6) }));
  if (cmd === 'syndrome-diagnose') return out(await kernel.syndrome.diagnose(args[0] || null));
  if (cmd === 'conservation-register') return out(await kernel.conservation.register(readSpec(args[0])));
  if (cmd === 'conservation-learn') return out(await kernel.conservation.learn(args[0], args[1] || 'OMEGA CLI trusted baseline'));
  if (cmd === 'conservation-scan') return out(await kernel.conservation.scan({ freezeOnViolation: true }));

  if (cmd === 'tx') return out(await kernel.protectedCommit.transact(readSpec(args[0])));
  if (cmd === 'nversion') { const spec = readSpec(args[0]); return out(await kernel.nversion.preflight(spec.ops || [], { freezeOnDivergence: false })); }
  if (cmd === 'metamorphic') return out(await kernel.fabric.verifyQuery(readSpec(args[0]), { freezeOnMismatch: true }));
  if (cmd === 'fabric-seal') {
    const ultimate = args.includes('--ultimate');
    return out(await kernel.fabric.seal(firstNonFlag(args, 'omega-cli'), {
      level: ultimate ? 'ULTIMATE' : 'NORMAL', trinity: ultimate, genome: ultimate,
      challenge: ultimate, enforceTrustBudget: ultimate
    }));
  }
  if (cmd === 'recovery-case') return out(await kernel.fabric.recoveryCase({ fractalTables: args.includes('--fractal'), challenge: args.includes('--challenge') }));
  if (cmd === 'emergency-seal') return out(await kernel.fabric.emergencySeal(args.join(' ') || 'OMEGA CLI emergency seal'));

  if (cmd === 'world-commit') return out(await kernel.worldTree.commitCurrent(args[0] || 'omega-cli', args[1] || 'main'));
  if (cmd === 'world-branch') return out(await kernel.worldTree.branch(args[0], args[1] || 'main'));
  if (cmd === 'world-log') return out(await kernel.worldTree.log(args[0] || 'main', Number(args[1] || 100)));
  if (cmd === 'world-merge') return out(await kernel.worldTree.mergePreview(args[0], args[1]));
  if (cmd === 'courier-export') return out(await kernel.courier.exportDelta({ sinceSequence: Number(args[0] || 0), label: args[1] || 'omega-cli', worldTreeRef: 'main' }));
  if (cmd === 'courier-verify') return out(await kernel.courier.verifyDirectory(path.resolve(args[0])));
  if (cmd === 'courier-import') return out(await kernel.courier.importToQuarantine(path.resolve(args[0]), args[1] || 'incoming'));

  if (cmd === 'memory-snapshot') return out(await kernel.memory.snapshot(args[0] || 'omega-cli'));
  if (cmd === 'memory-verify') return out(clean(await kernel.memory.verify(args[0] || null)));
  if (cmd === 'memory-ancestry') return out(await kernel.memory.ancestry(Number(args[0] || 100)));
  if (cmd === 'format-archive') return out(await kernel.formatCapsule.archive(args[0] || 'omega-cli'));
  if (cmd === 'format-verify') return out(clean(await kernel.formatCapsule.verify(args[0] || null)));
  if (cmd === 'fountain-archive') {
    const label = args[0] || 'omega-cli';
    return out(await kernel.fountain.archiveBuffer(label, await worldBuffer(label), { sourceChunks: Number(args[1] || 0) || undefined, redundancy: Number(args[2] || 0) || undefined }));
  }
  if (cmd === 'fountain-recover') return out(clean(await kernel.fountain.recoverDirectory(path.resolve(args[0]))));
  if (cmd === 'seed-create') return out(await kernel.civilizationSeed.create(args[0] || 'omega-cli'));
  if (cmd === 'seed-verify') return out(await kernel.civilizationSeed.verify(args[0] || null));

  if (cmd === 'media-register') return out(await kernel.constellation.register(args[0], path.resolve(args[1]), { purpose: args[2] || 'survival-media' }));
  if (cmd === 'media-assess') return out(await kernel.constellation.assess());
  if (cmd === 'media-seed-export') return out(await kernel.constellation.exportSeed({ label: args[0] || 'omega-cli', createNew: true }));
  if (cmd === 'media-fountain-scatter') return out(await kernel.constellation.scatterFountain({ copiesPerDroplet: Number(args[0] || 2) }));
  if (cmd === 'media-inventory') return out(await kernel.constellation.inventory());

  if (cmd === 'crypto-attest') {
    const temporal = await kernel.guardian.witnessRound(args[0] || 'omega-crypto-attest');
    return out(await kernel.cryptoCouncil.attest(temporal.worldRoot, { label: args[0] || 'omega-cli', temporalRoundHash: temporal.roundHash }));
  }
  if (cmd === 'crypto-verify') return out(await kernel.cryptoCouncil.verify(args[0] || null));
  if (cmd === 'hash-witness-public') return out(await kernel.hashWitnessCouncil.publicBundle());
  if (cmd === 'hash-policy') return out(await kernel.polyhash.init());
  if (cmd === 'hash-envelope') return out(await kernel.polyhash.envelope(readSpec(args[0]), { source: args[0] }));

  if (cmd === 'promote-propose') return out(await kernel.promotion.propose({ sandboxFile: path.resolve(args[0]), expiresMinutes: Number(args[1] || 60), evidence: { source: 'OMEGA CLI' } }));
  if (cmd === 'promote-approve') return out(await kernel.promotion.approve(args[0], args[1]));
  if (cmd === 'promote-verify') return out(await kernel.promotion.verify(args[0]));
  if (cmd === 'promote-certificate') return out(await kernel.promotion.certificate(args[0]));
  if (cmd === 'keyshard-split') return out(await kernel.keyShards.splitFile(path.resolve(args[0]), args[1] || 'secret', { threshold: Number(args[2] || 3), total: Number(args[3] || 5) }));
  if (cmd === 'keyshard-recover') return out(await kernel.keyShards.reconstructDirectory(path.resolve(args[0]), path.resolve(args[1])));
  if (cmd === 'keyshard-export') return out(await kernel.keyShards.exportShare(args[0], Number(args[1]), path.resolve(args[2])));

  if (cmd === 'compatibility-capture') return out(await kernel.compatibility.capture(args[0] || 'omega-cli'));
  if (cmd === 'compatibility-verify') return out(await kernel.compatibility.verify(args[0] || null));
  if (cmd === 'migration-register') return out(await kernel.compatibility.registerMigration(readSpec(args[0])));
  if (cmd === 'migration-plan') return out(await kernel.compatibility.migrationPlan(args[0], args[1]));
  if (cmd === 'repair-propose') return out(await kernel.repair.propose(readSpec(args[0])));

  usage();
  process.exitCode = 2;
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
