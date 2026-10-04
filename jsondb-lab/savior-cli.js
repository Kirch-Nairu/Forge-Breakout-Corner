#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { MonsterEngine } = require('./monster/engine');
const { SaviorSystem } = require('./monster/savior');
const { TemporalQuorumGuardian } = require('./monster/guardian');
const { QuantumInspiredLab } = require('./monster/quantum');
const { ExtinctionLab } = require('./monster/apocalypse');
const { OrthogonalArk } = require('./monster/orthogonal');
const { TruthLattice } = require('./monster/truth');

const root = __dirname;
const engine = new MonsterEngine(root);
const savior = new SaviorSystem(engine, { cells: 5 });
const guardian = new TemporalQuorumGuardian(savior);
const quantum = new QuantumInspiredLab(engine, savior);
const apocalypse = new ExtinctionLab(engine, savior);
const orthogonal = new OrthogonalArk(engine, savior);
const truth = new TruthLattice(savior, guardian, orthogonal);

async function boot() {
  await engine.init();
  await savior.init();
  await guardian.init();
  await apocalypse.init();
  await orthogonal.init();
}
function out(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function usage() {
  console.log(`JSONDB SAVIOR CLI\n\nCommands:\n  status\n  guardian\n  witness [label]\n  verify-witness\n  truth\n  truth-file <relative-path>\n  capture\n  scrub\n  capsule [label]\n  orthogonal-archive [label]\n  orthogonal-verify [id]\n  infer-catalog\n  reconstruct-catalog\n  canary\n  mode <read-write|read-only|panic> [reason]\n  panic [reason]\n  extinction\n  black-swan\n  quantum-dry <spec.json>\n  quantum-collapse <spec.json>\n`);
}
function readSpec(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }

async function main() {
  await boot();
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) return usage();
  if (cmd === 'status') return out({ engine: await engine.status(), savior: await savior.status(), witness: await guardian.verifyChain(), truth: await truth.worldVerdict() });
  if (cmd === 'guardian') {
    const low = await savior.guardianCycle({ capture: true, autoFreeze: true });
    const lattice = await truth.worldVerdict();
    if (['FROZEN', 'UNKNOWN'].includes(lattice.status)) await savior.setMode('read-only', `Truth Lattice ${lattice.status} at confidence ${lattice.confidence}`);
    return out({ guardian: low, truth: lattice, state: await savior.status() });
  }
  if (cmd === 'witness') return out(await guardian.witnessRound(args[0] || 'cli'));
  if (cmd === 'verify-witness') return out(await guardian.verifyChain());
  if (cmd === 'truth') return out(await truth.worldVerdict());
  if (cmd === 'truth-file') return out(await truth.verdict(args[0]));
  if (cmd === 'capture') return out(await savior.captureMirrors());
  if (cmd === 'scrub') return out(await savior.mirrors.scrub());
  if (cmd === 'capsule') return out(await savior.capsule(args[0] || 'cli'));
  if (cmd === 'orthogonal-archive') return out(await orthogonal.archive(args[0] || 'cli'));
  if (cmd === 'orthogonal-verify') return out(await orthogonal.verify(args[0] || null));
  if (cmd === 'infer-catalog') return out(await savior.inferCatalog());
  if (cmd === 'reconstruct-catalog') return out(await savior.rebuildCatalogFromWorld());
  if (cmd === 'canary') return out(await savior.canary());
  if (cmd === 'mode') return out(await savior.setMode(args[0], args.slice(1).join(' ') || 'CLI operator mode change'));
  if (cmd === 'panic') {
    const capsule = await savior.capsule('cli-panic');
    const dual = await orthogonal.archive('cli-panic');
    const witness = await guardian.witnessRound('cli-panic');
    const state = await savior.setMode('panic', args.join(' ') || 'CLI panic');
    return out({ state, capsule, orthogonal: dual, witness: witness.roundHash });
  }
  if (cmd === 'extinction') return out(await apocalypse.run({ dataShards: 6, cells: 5, corruptMirrors: 2 }));
  if (cmd === 'black-swan') return out(await apocalypse.impossibleMode({ dataShards: 6, cells: 5, corruptMirrors: 3 }));
  if (cmd === 'quantum-dry' || cmd === 'quantum-collapse') {
    const spec = readSpec(args[0]);
    spec.dryRun = cmd === 'quantum-dry';
    const result = cmd === 'quantum-dry' ? await quantum.superpose(spec) : await quantum.collapse(spec);
    if (result.collapsed) { await savior.captureMirrors(); await guardian.witnessRound('cli-quantum-collapse'); }
    return out(result);
  }
  usage();
  process.exitCode = 2;
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
