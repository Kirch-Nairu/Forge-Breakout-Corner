'use strict';

const PROTOCOL_VERSION = 'kirion-worker-v1';
const FORBIDDEN_SELF_CLAIMS = new Set(['ACCEPTED', 'INTEGRATED', 'PROMOTED', 'DEPLOYED', 'PRODUCTION_ACCEPTED']);
const RESULT_STATUSES = new Set(['COMPLETE', 'COMPLETE_WITH_LIMITATIONS', 'BLOCKED', 'FAILED']);

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
}

function assertSha(value, name) {
  if (!/^[0-9a-f]{40}$/i.test(String(value || ''))) {
    throw new Error(`${name} must be an exact 40-character Git SHA.`);
  }
}

function validateWorkerPacket(packet) {
  assertObject(packet, 'worker packet');
  if (packet.protocolVersion !== PROTOCOL_VERSION) throw new Error('Unsupported worker protocol version.');
  if (!packet.workerId || !packet.providerId) throw new Error('workerId and providerId are required.');
  if (!packet.episodeId) throw new Error('episodeId is required.');
  if (!packet.role) throw new Error('role is required.');
  assertSha(packet.source?.sha, 'source.sha');
  assertObject(packet.authority, 'authority');
  if (packet.authority.mayAccept || packet.authority.mayIntegrate || packet.authority.mayPromote || packet.authority.mayDeploy) {
    throw new Error('External workers cannot receive Forge acceptance, integration, promotion, or deployment authority.');
  }
  if (!packet.workPackage || typeof packet.workPackage !== 'object') throw new Error('workPackage is required.');
  if (!Array.isArray(packet.workPackage.ownedScope) || packet.workPackage.ownedScope.length === 0) {
    throw new Error('workPackage.ownedScope must be non-empty.');
  }
  return structuredClone(packet);
}

function validateWorkerResult(result, packet) {
  assertObject(result, 'worker result');
  if (result.protocolVersion !== PROTOCOL_VERSION) throw new Error('Unsupported worker result protocol version.');
  if (packet && result.episodeId !== packet.episodeId) throw new Error('Worker result episodeId mismatch.');
  if (!RESULT_STATUSES.has(result.status)) throw new Error('Invalid worker result status.');
  if (result.sourceSha != null) assertSha(result.sourceSha, 'result.sourceSha');

  const claims = Array.isArray(result.claims) ? result.claims.map(v => String(v).toUpperCase()) : [];
  const forbidden = claims.find(claim => FORBIDDEN_SELF_CLAIMS.has(claim));
  if (forbidden) throw new Error(`Worker attempted forbidden self-authority claim: ${forbidden}`);

  if (!Array.isArray(result.changedFiles)) throw new Error('changedFiles must be an array.');
  if (!Array.isArray(result.checks)) throw new Error('checks must be an array.');
  if (!Array.isArray(result.unresolved)) throw new Error('unresolved must be an array.');

  for (const check of result.checks) {
    assertObject(check, 'check');
    if (!check.name || !['PASS', 'FAIL', 'NOT_EXECUTED', 'UNVERIFIED'].includes(check.status)) {
      throw new Error('Each check requires name and a valid evidence status.');
    }
  }

  return structuredClone(result);
}

module.exports = {
  PROTOCOL_VERSION,
  FORBIDDEN_SELF_CLAIMS,
  RESULT_STATUSES,
  validateWorkerPacket,
  validateWorkerResult
};
