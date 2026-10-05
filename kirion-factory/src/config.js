'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid integer environment variable ${name}.`);
  return value;
}

function loadConfig() {
  const profileFile = process.env.KIRION_CONFIG || path.join(ROOT, 'config', 'potato-16.json');
  const base = JSON.parse(fs.readFileSync(profileFile, 'utf8'));

  const cfg = structuredClone(base);
  cfg.root = ROOT;
  cfg.stateDir = path.resolve(ROOT, process.env.KIRION_STATE_DIR || cfg.stateDir || '.state');

  cfg.controller.host = process.env.KIRION_CONTROL_HOST || cfg.controller.host;
  cfg.controller.port = intEnv('KIRION_CONTROL_PORT', cfg.controller.port);

  cfg.worker.host = process.env.KIRION_WORKER_HOST || cfg.worker.host;
  cfg.worker.port = intEnv('KIRION_WORKER_PORT', cfg.worker.port);
  cfg.worker.url = process.env.KIRION_WORKER_URL || `http://${cfg.worker.host === '0.0.0.0' ? '127.0.0.1' : cfg.worker.host}:${cfg.worker.port}`;
  cfg.worker.mode = String(process.env.KIRION_WORKER_MODE || cfg.worker.mode || 'COURTESY').toUpperCase();
  cfg.worker.token = process.env.KIRION_WORKER_TOKEN || '';

  cfg.llm.baseUrl = process.env.KIRION_LLM_BASE_URL || cfg.llm.baseUrl;
  cfg.llm.model = process.env.KIRION_LLM_MODEL || cfg.llm.model;
  cfg.llm.contextTokens = intEnv('KIRION_LLM_CONTEXT', cfg.llm.contextTokens);
  cfg.llm.maxOutputTokens = intEnv('KIRION_LLM_MAX_OUTPUT', cfg.llm.maxOutputTokens);
  cfg.llm.timeoutMs = intEnv('KIRION_LLM_TIMEOUT_MS', cfg.llm.timeoutMs);
  cfg.llm.allowRemote = process.env.KIRION_ALLOW_REMOTE_LLM === '1';

  const workerIsLoopback = ['127.0.0.1', 'localhost', '::1'].includes(cfg.worker.host);
  if (!workerIsLoopback && !cfg.worker.token) {
    throw new Error('KIRION_WORKER_TOKEN is required when the worker binds beyond loopback.');
  }

  return cfg;
}

module.exports = { ROOT, loadConfig };
