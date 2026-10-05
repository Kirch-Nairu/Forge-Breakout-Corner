'use strict';

const { normalizeRepoPath } = require('../lib/glob');

const SHA40 = /^[0-9a-f]{40}$/i;

function uniq(values) { return [...new Set(values)]; }

function normalizeWorkPackage(input = {}) {
  return {
    id: String(input.id || '').trim(),
    goal: String(input.goal || '').trim(),
    sourceSha: String(input.sourceSha || '').trim(),
    role: String(input.role || 'CODE_WRITER').trim().toUpperCase(),
    ownedScope: uniq((input.ownedScope || []).map(normalizeRepoPath).filter(Boolean)),
    prohibitedScope: uniq((input.prohibitedScope || []).map(normalizeRepoPath).filter(Boolean)),
    requiredChecks: uniq((input.requiredChecks || []).map(String).map(x => x.trim()).filter(Boolean)),
    steps: (input.steps || []).map(String).map(x => x.trim()).filter(Boolean),
    mutationBudget: {
      maxFiles: Number(input.mutationBudget?.maxFiles || 15),
      maxRounds: Number(input.mutationBudget?.maxRounds || 8)
    }
  };
}

function validateWorkPackage(input) {
  const wp = normalizeWorkPackage(input);
  const errors = [];
  if (!wp.goal) errors.push('goal is required');
  if (!SHA40.test(wp.sourceSha)) errors.push('sourceSha must be an exact 40-character Git SHA');
  if (!wp.ownedScope.length) errors.push('ownedScope must not be empty');
  if (!wp.requiredChecks.length) errors.push('requiredChecks must not be empty');
  if (!wp.steps.length) errors.push('steps must not be empty');
  if (!Number.isInteger(wp.mutationBudget.maxFiles) || wp.mutationBudget.maxFiles < 1 || wp.mutationBudget.maxFiles > 100) errors.push('invalid maxFiles');
  if (!Number.isInteger(wp.mutationBudget.maxRounds) || wp.mutationBudget.maxRounds < 1 || wp.mutationBudget.maxRounds > 50) errors.push('invalid maxRounds');
  if (errors.length) {
    const err = new Error(`Invalid work package: ${errors.join('; ')}`);
    err.status = 400;
    err.errors = errors;
    throw err;
  }
  return wp;
}

module.exports = { normalizeWorkPackage, validateWorkPackage };
