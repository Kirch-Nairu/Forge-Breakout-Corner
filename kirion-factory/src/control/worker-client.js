'use strict';

const { fetchJson } = require('../lib/http');

function headers(config) {
  const out = { 'content-type': 'application/json' };
  if (config.worker.token) out['x-kirion-worker-token'] = config.worker.token;
  return out;
}

async function workerHealth(config) {
  return fetchJson(`${config.worker.url}/health`, {}, 5000);
}

async function workerInfer(config, payload) {
  return fetchJson(`${config.worker.url}/v1/infer`, {
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify(payload)
  }, config.llm.timeoutMs + 5000);
}

module.exports = { workerHealth, workerInfer };
