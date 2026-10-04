#!/usr/bin/env node
'use strict';

const { FederatedOmegaKernel } = require('./monster/federated-kernel');

const kernel = new FederatedOmegaKernel(__dirname);
function out(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function flag(args, name) { return args.includes(name); }
function nonflags(args) { return args.filter(x => !x.startsWith('--')); }

function usage() {
  console.log(`JSONDB OMEGA FEDERATION CLI\n\n  status [--deep]\n\nEPOCHS\n  epoch-seal [label] [--deep-media] [--verify-archives]\n  epoch-verify [id] [--live]\n\nFEDERATION\n  federation-seal [label] [--compare=<ref>] [--merge-preview] [--window=N]\n  federation-verify [id] [--live]\n  continuity-proof <fromEpochId> [toEpochId]\n\nTIME WEAVE\n  weave-verify\n  weave-proof <fromEpochId> [toEpochId]\n\nTEMPORAL PARITY\n  parity-seal [window]\n  parity-inspect [id]\n  parity-recover [id] [--repair-in-place]\n\nHISTORY COURT\n  court <lineageA> <lineageB> [--merge-preview]\n  court-verify [id]\n\nNo npm. No package manager. No external database.\nHistory may be reconstructed into sandboxes; ambiguity is preserved instead of silently collapsed.\n`);
}

async function main() {
  await kernel.init();
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) return usage();
  const plain = nonflags(args);

  if (cmd === 'status') return out(await kernel.status({ deep: flag(args, '--deep') }));

  if (cmd === 'epoch-seal') return out(await kernel.epochSealer.seal(plain[0] || 'federated-cli', {
    deepMedia: flag(args, '--deep-media'),
    verifyArchives: flag(args, '--verify-archives')
  }));
  if (cmd === 'epoch-verify') return out(await kernel.epochSealer.verify(plain[0] || null, { live: flag(args, '--live') }));

  if (cmd === 'federation-seal') {
    const compareArg = args.find(x => x.startsWith('--compare='));
    const windowArg = args.find(x => x.startsWith('--window='));
    return out(await kernel.federation.seal(plain[0] || 'federated-cli', {
      compareLineage: compareArg ? compareArg.split('=').slice(1).join('=') : null,
      previewMerge: flag(args, '--merge-preview'),
      temporalWindow: windowArg ? Number(windowArg.split('=')[1]) : 8,
      epoch: { deepMedia: true, verifyArchives: false }
    }));
  }
  if (cmd === 'federation-verify') return out(await kernel.federation.verify(plain[0] || null, { live: flag(args, '--live') }));
  if (cmd === 'continuity-proof') return out(await kernel.federation.continuityProof(plain[0], plain[1] || null));

  if (cmd === 'weave-verify') return out(await kernel.timeWeave.verifyAll());
  if (cmd === 'weave-proof') return out(await kernel.timeWeave.proof(plain[0], plain[1] || null));

  if (cmd === 'parity-seal') return out(await kernel.temporalParity.seal({ window: Number(plain[0] || 8) }));
  if (cmd === 'parity-inspect') {
    const result = await kernel.temporalParity.inspect(plain[0] || null);
    result.states = result.states.map(({ buffer, ...x }) => x);
    result.parity = result.parity.map(({ buffer, ...x }) => x);
    return out(result);
  }
  if (cmd === 'parity-recover') return out(await kernel.temporalParity.recover(plain[0] || null, { repairInPlace: flag(args, '--repair-in-place') }));

  if (cmd === 'court') return out(await kernel.historyCourt.compare(plain[0], plain[1], { previewMerge: flag(args, '--merge-preview') }));
  if (cmd === 'court-verify') return out(await kernel.historyCourt.verify(plain[0] || null));

  usage();
  process.exitCode = 2;
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
