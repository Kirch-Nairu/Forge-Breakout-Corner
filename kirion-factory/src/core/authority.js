'use strict';

const { matchesAny, normalizeRepoPath } = require('../lib/glob');

const CAPABILITIES = Object.freeze({
  SECOND_BRAIN: new Set(['READ_REPO', 'ASK_USER', 'PROPOSE_PLAN']),
  MAINTAINER: new Set(['READ_REPO', 'PROPOSE_PLAN', 'PROPOSE_WORK_PACKAGE']),
  CODE_WRITER: new Set(['READ_REPO', 'CREATE_WORKTREE', 'PATCH_FILE', 'RUN_CHECK']),
  REVIEWER: new Set(['READ_REPO', 'RUN_CHECK', 'REVIEW']),
  ACCEPTANCE: new Set(['READ_REPO', 'RUN_CHECK', 'REVIEW', 'ACCEPT']),
  INTEGRATOR: new Set(['READ_REPO', 'RUN_CHECK', 'INTEGRATE']),
  DEPLOYER: new Set(['READ_REPO', 'RUN_CHECK', 'PROMOTE', 'DEPLOY'])
});

const WRITE_ACTIONS = new Set(['CREATE_WORKTREE', 'PATCH_FILE', 'INTEGRATE', 'PROMOTE', 'DEPLOY']);

function pathDecision(file, workPackage) {
  const normalized = normalizeRepoPath(file);
  const prohibited = workPackage?.prohibitedScope || [];
  const owned = workPackage?.ownedScope || [];
  if (matchesAny(normalized, prohibited)) return { allowed: false, reason: 'PROHIBITED_SCOPE' };
  if (!matchesAny(normalized, owned)) return { allowed: false, reason: 'OUTSIDE_OWNED_SCOPE' };
  return { allowed: true, reason: 'OWNED_SCOPE' };
}

function evaluateAction({ role, action, episode, workPackage, file = null, human = {} }) {
  const caps = CAPABILITIES[role];
  if (!caps || !caps.has(action)) return { allowed: false, reason: 'ROLE_CAPABILITY_DENIED' };

  if (WRITE_ACTIONS.has(action) && !human.writeAuthorized && !['PROMOTE', 'DEPLOY'].includes(action)) {
    return { allowed: false, reason: 'HUMAN_WRITE_AUTHORITY_REQUIRED' };
  }

  if (['CREATE_WORKTREE', 'PATCH_FILE'].includes(action)) {
    const allowedStates = new Set(['AUTHORIZED', 'ACTIVE', 'REWORK']);
    if (!allowedStates.has(episode?.state)) return { allowed: false, reason: 'EPISODE_NOT_WRITE_AUTHORIZED' };
  }

  if (file && action === 'PATCH_FILE') {
    const scope = pathDecision(file, workPackage);
    if (!scope.allowed) return scope;
  }

  if (action === 'INTEGRATE' && episode?.state !== 'ACCEPTED') {
    return { allowed: false, reason: 'ACCEPTANCE_REQUIRED' };
  }

  if (action === 'PROMOTE') {
    if (!human.promotionAuthorized) return { allowed: false, reason: 'HUMAN_PROMOTION_AUTHORITY_REQUIRED' };
    if (episode?.state !== 'INTEGRATED') return { allowed: false, reason: 'INTEGRATION_REQUIRED' };
  }

  if (action === 'DEPLOY' && !human.deploymentAuthorized) {
    return { allowed: false, reason: 'HUMAN_DEPLOYMENT_AUTHORITY_REQUIRED' };
  }

  return { allowed: true, reason: 'AUTHORIZED' };
}

module.exports = { CAPABILITIES, WRITE_ACTIONS, pathDecision, evaluateAction };
