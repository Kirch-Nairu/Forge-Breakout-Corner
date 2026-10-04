#!/usr/bin/env node
'use strict';

const path = require('path');
const { MonsterEngine } = require('./monster/engine');
const { SaviorSystem } = require('./monster/savior');
const { TemporalQuorumGuardian } = require('./monster/guardian');
const { OrthogonalArk } = require('./monster/orthogonal');
const { TruthLattice } = require('./monster/truth');
const { WitnessCouncil } = require('./monster/witnesses');
const { JsonImmuneSystem } = require('./monster/immune');
const { SurvivalOracle } = require('./monster/oracle');

const engine = new MonsterEngine(__dirname);
const savior = new SaviorSystem(engine, { cells: 5 });
const guardian = new TemporalQuorumGuardian(savior);
const orthogonal = new OrthogonalArk(engine, savior);
const truth = new TruthLattice(savior, guardian, orthogonal);
const council = new WitnessCouncil(path.join(savior.root, 'witness-council'), 7, 5);
const immune = new JsonImmuneSystem(engine, path.join(savior.root, 'immune'));
const oracle = new SurvivalOracle({ savior, guardian, truth, orthogonal, council, immune });

async function boot(){await engine.init();await savior.init();await guardian.init();await orthogonal.init();await council.init();await immune.init()}
function out(v){console.log(JSON.stringify(v,null,2))}
function usage(){console.log(`JSONDB SURVIVAL ORACLE\n\nCommands:\n  attest [label]\n  assess [--verify-archives]\n  enforce [--verify-archives]\n  council-verify\n  council-revoke <witness-id> [reason]\n  immune-learn [label]\n  immune-scan [profile-id]\n`)}
async function main(){await boot();const [cmd,...args]=process.argv.slice(2);if(!cmd)return usage();
  if(cmd==='attest')return out(await oracle.attest(args[0]||'cli-oracle'));
  if(cmd==='assess')return out(await oracle.assess({verifyArchives:args.includes('--verify-archives')}));
  if(cmd==='enforce')return out(await oracle.enforce({verifyArchives:args.includes('--verify-archives')}));
  if(cmd==='council-verify')return out(await council.verifyRound());
  if(cmd==='council-revoke')return out(await council.revoke(args[0],args.slice(1).join(' ')||'CLI revocation'));
  if(cmd==='immune-learn')return out(await immune.learn(args[0]||'trusted-cli-baseline'));
  if(cmd==='immune-scan')return out(await immune.scan(args[0]||null));
  usage();process.exitCode=2;
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
