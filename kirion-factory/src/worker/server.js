'use strict';

const http = require('http');
const { sendJson, readJsonBody } = require('../lib/http');
const { LlamaClient } = require('../llm/llama-client');
const { hardwareSnapshot, admissionForClass } = require('./hardware');

const MODES = new Set(['PAUSED', 'COURTESY', 'FACTORY']);

function tokenAllowed(req, config) {
  if (!config.worker.token) return true;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const explicit = String(req.headers['x-kirion-worker-token'] || '');
  return bearer === config.worker.token || explicit === config.worker.token;
}

function createWorkerServer(config, overrides = {}) {
  const llm = overrides.llm || new LlamaClient(config.llm);
  let mode = MODES.has(config.worker.mode) ? config.worker.mode : 'COURTESY';
  let activeJobs = 0;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://worker.local');
      if (req.method === 'GET' && url.pathname === '/health') {
        const hardware = hardwareSnapshot(config);
        return sendJson(res, 200, {
          service: 'KIRION_WORKER',
          profile: config.profile,
          mode,
          activeJobs,
          llm: { baseUrl: config.llm.baseUrl, model: config.llm.model },
          hardware
        });
      }

      if (!tokenAllowed(req, config)) return sendJson(res, 401, { error: 'WORKER_AUTH_REQUIRED' });

      if (req.method === 'POST' && url.pathname === '/v1/mode') {
        const body = await readJsonBody(req);
        const requested = String(body.mode || '').toUpperCase();
        if (!MODES.has(requested)) return sendJson(res, 400, { error: 'INVALID_WORKER_MODE' });
        mode = requested;
        return sendJson(res, 200, { mode });
      }

      if (req.method === 'POST' && url.pathname === '/v1/infer') {
        if (mode === 'PAUSED') return sendJson(res, 423, { error: 'WORKER_PAUSED' });
        if (activeJobs > 0) return sendJson(res, 429, { error: 'POTATO16_SINGLE_INFERENCE_ONLY' });

        const body = await readJsonBody(req, 2 * 1024 * 1024);
        const role = String(body.role || '').toUpperCase();
        if (!config.acceptedRoles.includes(role)) return sendJson(res, 400, { error: 'ROLE_NOT_ACCEPTED' });
        const jobClass = String(body.jobClass || 'LIGHT').toUpperCase();
        if (!['LIGHT', 'CODE'].includes(jobClass)) return sendJson(res, 400, { error: 'INVALID_JOB_CLASS' });

        const hardware = hardwareSnapshot(config);
        const admission = admissionForClass(hardware, jobClass);
        if (!admission.allowed) return sendJson(res, 503, { error: admission.reason, hardware });

        activeJobs += 1;
        const started = Date.now();
        try {
          const result = await llm.completeJson({
            role,
            system: String(body.system || ''),
            messages: Array.isArray(body.messages) ? body.messages : [],
            schema: body.schema,
            schemaName: String(body.schemaName || 'kirion_output'),
            maxTokens: body.maxTokens || null
          });
          return sendJson(res, 200, {
            ok: true,
            role,
            jobClass,
            durationMs: Date.now() - started,
            data: result.data,
            usage: result.usage
          });
        } finally {
          activeJobs -= 1;
        }
      }

      return sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message, code: err.code || null });
    }
  });
}

module.exports = { createWorkerServer };
