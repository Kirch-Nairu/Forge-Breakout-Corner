#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { MonsterEngine } = require('./monster/engine');
const { SaviorSystem } = require('./monster/savior');
const { TemporalQuorumGuardian } = require('./monster/guardian');
const { OrthogonalArk } = require('./monster/orthogonal');
const { SemanticChronicle } = require('./monster/chronicle');
const { TruthLattice } = require('./monster/truth');
const { WitnessCouncil } = require('./monster/witnesses');
const { JsonImmuneSystem } = require('./monster/immune');
const { TrinityArk } = require('./monster/trinity');
const { SurvivorGenome } = require('./monster/genome');
const { FractalQuorum } = require('./monster/fractal');
const { MetamorphicVerifier } = require('./monster/metamorphic');
const { CrossHistoryBraid } = require('./monster/braid');
const { SurvivalOracle } = require('./monster/oracle');
const { SurvivalFabric } = require('./monster/fabric');
const { FailureDomainTrustBudget } = require('./monster/trustbudget');
const { ChallengeScrubber } = require('./monster/challenge');
const { MemoryPalace } = require('./monster/memorypalace');
const { NVersionMutationGuard } = require('./monster/nversion');
const { RepairConstitution } = require('./monster/repairpolicy');
const { ProtectedCommitCoordinator } = require('./monster/protected');
const { BootSentinel } = require('./monster/bootsentinel');
const { SovereignClock } = require('./monster/clockguard');
const { DurabilityRealityCheck } = require('./monster/durability');
const { HashPolyglot } = require('./monster/polyhash');
const { FormatPolyglotCapsule } = require('./monster/formatpolyglot');
const { FountainArk } = require('./monster/fountain');
const { CivilizationSeed } = require('./monster/seed');

const ROOT = __dirname;
const engine = new MonsterEngine(ROOT);
const savior = new SaviorSystem(engine, { cells: 5 });
const guardian = new TemporalQuorumGuardian(savior);
const orthogonal = new OrthogonalArk(engine, savior);
const chronicle = new SemanticChronicle(engine, path.join(savior.root, 'semantic-chronicle'));
const truth = new TruthLattice(savior, guardian, orthogonal);
const council = new WitnessCouncil(path.join(savior.root, 'witness-council'), 7, 5);
const immune = new JsonImmuneSystem(engine, path.join(savior.root, 'immune'));
const trinity = new TrinityArk(engine, savior);
const genome = new SurvivorGenome({ engine, savior, orthogonal, council });
const fractal = new FractalQuorum(savior);
const metamorphic = new MetamorphicVerifier(engine, savior);
const braid = new CrossHistoryBraid({ savior, guardian, chronicle, council, truth, immune, orthogonal, trinity });
const trustBudget = new FailureDomainTrustBudget();
const challenge = new ChallengeScrubber({ savior, braid });
const memory = new MemoryPalace(engine, savior, { vaults: 3 });
const nversion = new NVersionMutationGuard(engine, savior);
const repair = new RepairConstitution(engine, savior);
const oracle = new SurvivalOracle({ savior, guardian, truth, orthogonal, council, immune, chronicle, braid, trinity, genome });
const fabric = new SurvivalFabric({ engine, savior, guardian, truth, council, immune, orthogonal, trinity, genome, fractal, metamorphic, chronicle, braid, oracle, trustBudget, challenge });
const protectedCommit = new ProtectedCommitCoordinator({ engine, savior, chronicle, guardian, council, orthogonal, braid, fabric, nversion, memoryPalace: memory });
const boot = new BootSentinel(savior);
const clock = new SovereignClock(savior);
const durability = new DurabilityRealityCheck(savior);
const polyhash = new HashPolyglot(path.join(savior.root, 'hash-polyglot'));
const formatCapsule = new FormatPolyglotCapsule(engine, savior);
const fountain = new FountainArk(path.join(savior.root, 'fountain-ark'));
const seed = new CivilizationSeed({ engine, savior, genome, council, braid, repair, polyhash, trinity, orthogonal, memoryPalace: memory, fountain, formatPolyglot: formatCapsule });

function out(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function readSpec(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
function usage() {
  console.log(`JSONDB OMEGA CLI

Runtime / trust
  status [--deep]
  boot-status
  clock-audit
  clock-ack <reason...>
  durability-probe
  oracle [--verify-archives]
  oracle-enforce [--verify-archives]
  trust-budget [--verify-archives]

Protected database
  tx <spec.json>
  nversion <spec.json>
  metamorphic <query.json>
  fabric-seal [label] [--ultimate]
  recovery-case [--fractal] [--challenge]
  emergency-seal <reason...>

Recovery media
  memory-snapshot [label]
  memory-verify [id]
  memory-ancestry [limit]
  format-archive [label]
  format-verify [id]
  fountain-archive [label] [sourceChunks] [redundancy]
  fountain-recover <directory>
  seed-create [label]
  seed-verify [id]

Hash agility / repair law
  hash-policy
  hash-envelope <value.json>
  repair-propose <proposal.json>

No package manager. No account. No external database.
`);
}

async function bootStack() {
  await engine.init();
  await fabric.init();
  await memory.init();
  await repair.init();
  await polyhash.init();
  await formatCapsule.init();
  await fountain.init();
  await seed.init();
}

async function worldBuffer(label = 'omega-cli') {
  const catalog = await engine.catalog();
  const meta = await engine.meta();
  const tables = {};
  for (const name of Object.keys(catalog.collections || {}).sort()) tables[name] = await engine.loadCurrent(name);
  return Buffer.from(JSON.stringify({ format: 'JSONDB-OMEGA-WORLD-1', label, catalog, meta, tables }));
}

async function main() {
  await bootStack();
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) return usage();

  if (cmd === 'status') return out({
    savior: await savior.status(),
    engine: await engine.status(),
    fabric: await fabric.status({ deep: args.includes('--deep') }),
    boot: await boot.status(),
    clock: await clock.audit({ freezeOnRollback: false })
  });
  if (cmd === 'boot-status') return out(await boot.status());
  if (cmd === 'clock-audit') return out(await clock.audit({ freezeOnRollback: false }));
  if (cmd === 'clock-ack') return out(await clock.acknowledge(args.join(' ') || 'OMEGA CLI acknowledgement'));
  if (cmd === 'durability-probe') return out(await durability.probe({ freezeOnFailure: true }));

  if (cmd === 'oracle' || cmd === 'oracle-enforce') {
    const options = { verifyArchives: args.includes('--verify-archives') };
    return out(cmd === 'oracle' ? await oracle.assess(options) : await oracle.enforce(options));
  }
  if (cmd === 'trust-budget') return out(trustBudget.evaluate(await oracle.assess({ verifyArchives: args.includes('--verify-archives') })));

  if (cmd === 'tx') return out(await protectedCommit.transact(readSpec(args[0])));
  if (cmd === 'nversion') { const spec = readSpec(args[0]); return out(await nversion.preflight(spec.ops || [], { freezeOnDivergence: false })); }
  if (cmd === 'metamorphic') return out(await fabric.verifyQuery(readSpec(args[0]), { freezeOnMismatch: true }));
  if (cmd === 'fabric-seal') return out(await fabric.seal(args.find(x => !x.startsWith('--')) || 'omega-cli', {
    level: args.includes('--ultimate') ? 'ULTIMATE' : 'NORMAL',
    trinity: args.includes('--ultimate'), genome: args.includes('--ultimate'), challenge: args.includes('--ultimate'),
    enforceTrustBudget: args.includes('--ultimate')
  }));
  if (cmd === 'recovery-case') return out(await fabric.recoveryCase({ fractalTables: args.includes('--fractal'), challenge: args.includes('--challenge') }));
  if (cmd === 'emergency-seal') return out(await fabric.emergencySeal(args.join(' ') || 'OMEGA CLI emergency seal'));

  if (cmd === 'memory-snapshot') return out(await memory.snapshot(args[0] || 'omega-cli'));
  if (cmd === 'memory-verify') { const result = await memory.verify(args[0] || null); delete result._buffer; return out(result); }
  if (cmd === 'memory-ancestry') return out(await memory.ancestry(Number(args[0] || 100)));

  if (cmd === 'format-archive') return out(await formatCapsule.archive(args[0] || 'omega-cli'));
  if (cmd === 'format-verify') { const result = await formatCapsule.verify(args[0] || null); delete result._worlds; return out(result); }

  if (cmd === 'fountain-archive') {
    const label = args[0] || 'omega-cli';
    return out(await fountain.archiveBuffer(label, await worldBuffer(label), { sourceChunks: Number(args[1] || 0) || undefined, redundancy: Number(args[2] || 0) || undefined }));
  }
  if (cmd === 'fountain-recover') { const result = await fountain.recoverDirectory(path.resolve(args[0])); delete result.buffer; return out(result); }

  if (cmd === 'seed-create') return out(await seed.create(args[0] || 'omega-cli'));
  if (cmd === 'seed-verify') return out(await seed.verify(args[0] || null));

  if (cmd === 'hash-policy') return out(await polyhash.init());
  if (cmd === 'hash-envelope') return out(await polyhash.envelope(readSpec(args[0]), { source: args[0] }));
  if (cmd === 'repair-propose') return out(await repair.propose(readSpec(args[0])));

  usage();
  process.exitCode = 2;
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
