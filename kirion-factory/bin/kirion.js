#!/usr/bin/env node
'use strict';

const { loadConfig } = require('../src/config');
const { createControlServer } = require('../src/control/server');
const { createWorkerServer } = require('../src/worker/server');
const { hardwareSnapshot } = require('../src/worker/hardware');

async function main() {
  const command = String(process.argv[2] || '').toLowerCase();
  const config = loadConfig();

  if (command === 'control') {
    const server = createControlServer(config);
    server.listen(config.controller.port, config.controller.host, () => {
      console.log(`KIRION CONTROL ${config.profile} http://${config.controller.host}:${config.controller.port}`);
    });
    return;
  }

  if (command === 'worker') {
    const server = createWorkerServer(config);
    server.listen(config.worker.port, config.worker.host, () => {
      console.log(`KIRION WORKER ${config.profile} ${config.worker.host}:${config.worker.port} mode=${config.worker.mode}`);
      console.log(`LLM ${config.llm.baseUrl} model=${config.llm.model}`);
    });
    return;
  }

  if (command === 'profile') {
    console.log(JSON.stringify({ profile: config.profile, hardware: hardwareSnapshot(config), llm: config.llm, budgets: config.budgets }, null, 2));
    return;
  }

  console.error('Usage: node ./bin/kirion.js <control|worker|profile>');
  process.exitCode = 2;
}

main().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
