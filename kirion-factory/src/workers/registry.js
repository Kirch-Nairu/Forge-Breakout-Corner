'use strict';

const WORKERS = Object.freeze({
  'local-llama': Object.freeze({
    id: 'local-llama',
    provider: 'LOCAL_LLAMA_CPP',
    transport: 'OPENAI_COMPATIBLE_HTTP',
    trust: 'PROPOSAL_ONLY',
    roles: ['SECOND_BRAIN', 'MAINTAINER', 'CODE_WRITER', 'REVIEWER'],
    notes: 'Local model worker. Forge remains the authority boundary.'
  }),
  'google-ai-studio': Object.freeze({
    id: 'google-ai-studio',
    provider: 'GOOGLE_AI_STUDIO_GEMINI',
    transport: 'MANUAL_PROMPT_BRIDGE',
    trust: 'UNTRUSTED_EXTERNAL_WORKER',
    roles: ['SECOND_BRAIN', 'MAINTAINER', 'CODE_WRITER', 'REVIEWER'],
    notes: 'Human-mediated AI Studio worker. Output is evidence input, never acceptance authority.'
  }),
  'kimi-forge': Object.freeze({
    id: 'kimi-forge',
    provider: 'KIMI_EXTERNAL',
    transport: 'GITHUB_CANDIDATE',
    trust: 'UNTRUSTED_EXTERNAL_WORKER',
    roles: ['SECOND_BRAIN', 'MAINTAINER', 'CODE_WRITER', 'REVIEWER'],
    notes: 'External Kimi worker or candidate repository. Forge independently verifies repository truth.'
  })
});

function listWorkers() {
  return Object.values(WORKERS).map(v => structuredClone(v));
}

function getWorkerProfile(id) {
  const profile = WORKERS[String(id || '')];
  if (!profile) throw new Error(`Unknown worker profile: ${id}`);
  return structuredClone(profile);
}

module.exports = { WORKERS, listWorkers, getWorkerProfile };
