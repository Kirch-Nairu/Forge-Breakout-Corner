'use strict';

const { PROTOCOL_VERSION, validateWorkerPacket, validateWorkerResult } = require('./contracts');
const { getWorkerProfile } = require('./registry');

function buildWorkerPacket({ workerId, episode, workPackage, source, context = [], objective = '' }) {
  const profile = getWorkerProfile(workerId);
  const role = String(workPackage?.role || 'CODE_WRITER').toUpperCase();
  if (!profile.roles.includes(role)) throw new Error(`Worker ${profile.id} does not support role ${role}.`);

  const packet = {
    protocolVersion: PROTOCOL_VERSION,
    workerId: profile.id,
    providerId: profile.provider,
    transport: profile.transport,
    trust: profile.trust,
    episodeId: String(episode?.id || ''),
    role,
    objective: String(objective || workPackage?.goal || ''),
    source: {
      repository: String(source?.repository || ''),
      sha: String(source?.sha || workPackage?.sourceSha || '')
    },
    authority: {
      mayRead: true,
      mayPropose: true,
      mayMutateCandidate: role === 'CODE_WRITER',
      mayAccept: false,
      mayIntegrate: false,
      mayPromote: false,
      mayDeploy: false
    },
    workPackage: structuredClone(workPackage),
    context: Array.isArray(context) ? structuredClone(context) : [],
    resultContract: {
      status: ['COMPLETE', 'COMPLETE_WITH_LIMITATIONS', 'BLOCKED', 'FAILED'],
      checks: ['PASS', 'FAIL', 'NOT_EXECUTED', 'UNVERIFIED'],
      forbiddenClaims: ['ACCEPTED', 'INTEGRATED', 'PROMOTED', 'DEPLOYED', 'PRODUCTION_ACCEPTED']
    }
  };
  return validateWorkerPacket(packet);
}

function renderManualPrompt(packet) {
  const p = validateWorkerPacket(packet);
  return [
    'KIRION FORGE — EXTERNAL WORKER PACKET',
    '',
    `Protocol: ${p.protocolVersion}`,
    `Worker: ${p.workerId} / ${p.providerId}`,
    `Trust: ${p.trust}`,
    `Episode: ${p.episodeId}`,
    `Role: ${p.role}`,
    `Source repository: ${p.source.repository || '(not supplied)'}`,
    `Exact source SHA: ${p.source.sha}`,
    '',
    'AUTHORITY:',
    '- You are a worker, not Forge authority.',
    '- Do not claim ACCEPTED, INTEGRATED, PROMOTED, DEPLOYED, or PRODUCTION_ACCEPTED.',
    '- Do not mutate canonical main unless the work package explicitly supplies an isolated candidate mechanism.',
    '- Do not expand beyond owned scope.',
    '- Prohibited scope is absolute.',
    '- Test claims require actual observed evidence.',
    '- If a check was not executed, report NOT_EXECUTED.',
    '- Do not expose private chain-of-thought. Return inspectable engineering artifacts only.',
    '',
    'OBJECTIVE:',
    p.objective,
    '',
    'WORK PACKAGE JSON:',
    JSON.stringify(p.workPackage, null, 2),
    '',
    'CONTEXT ARTIFACTS:',
    JSON.stringify(p.context, null, 2),
    '',
    'RETURN ONLY A WORKER RESULT JSON OBJECT WITH:',
    '{',
    `  "protocolVersion": "${PROTOCOL_VERSION}",`,
    `  "episodeId": "${p.episodeId}",`,
    '  "status": "COMPLETE | COMPLETE_WITH_LIMITATIONS | BLOCKED | FAILED",',
    `  "sourceSha": "${p.source.sha}",`,
    '  "summary": "...",',
    '  "claims": [],',
    '  "changedFiles": [],',
    '  "checks": [{"name":"...","status":"PASS|FAIL|NOT_EXECUTED|UNVERIFIED","evidence":"..."}],',
    '  "unresolved": [],',
    '  "candidate": {"repository":"","branch":"","sha":""},',
    '  "handoff": "..."',
    '}',
    '',
    'FORGE WILL INDEPENDENTLY VERIFY ALL CLAIMS.'
  ].join('\n');
}

function importWorkerResult(raw, packet) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return validateWorkerResult(parsed, packet);
}

module.exports = { buildWorkerPacket, renderManualPrompt, importWorkerResult };
