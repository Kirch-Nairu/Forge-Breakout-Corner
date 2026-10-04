#!/usr/bin/env node
'use strict';

const { FederatedOmegaKernel } = require('./monster/federated-kernel');

const kernel = new FederatedOmegaKernel(__dirname);

function out(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  await kernel.init();
  const [cmd, id] = process.argv.slice(2);
  if (!cmd || cmd === 'help') {
    console.log(`JSONDB RECOVERY MUTATION AUDIT\n\n  audit [mutationId]\n\nReopens every Navigator plan referenced by a mutation artifact and independently recomputes REROUTED / BLOCKED_SAFE / UNSAFE.\n`);
    return;
  }
  if (cmd === 'audit') return out(await kernel.mutationAudit.verify(id || null));
  throw new Error(`Unknown command: ${cmd}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
