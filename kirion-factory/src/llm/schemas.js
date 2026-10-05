'use strict';

const DISCOVERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    facts: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    uncertainties: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subject: { type: 'string' },
          question: { type: 'string' },
          why: { type: 'string' },
          risk: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          architectureImpact: { type: 'integer', minimum: 0, maximum: 5 },
          irreversibility: { type: 'integer', minimum: 0, maximum: 5 },
          unblocksImplementation: { type: 'integer', minimum: 0, maximum: 5 },
          guessingRisk: { type: 'integer', minimum: 0, maximum: 5 }
        },
        required: ['subject', 'question', 'why', 'risk', 'architectureImpact', 'irreversibility', 'unblocksImplementation', 'guessingRisk']
      }
    }
  },
  required: ['facts', 'uncertainties']
};

const WORK_PACKAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    goal: { type: 'string' },
    sourceSha: { type: 'string' },
    role: { type: 'string', enum: ['CODE_WRITER'] },
    ownedScope: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
    prohibitedScope: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    requiredChecks: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
    steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 30 },
    mutationBudget: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxFiles: { type: 'integer', minimum: 1, maximum: 100 },
        maxRounds: { type: 'integer', minimum: 1, maximum: 50 }
      },
      required: ['maxFiles', 'maxRounds']
    }
  },
  required: ['goal', 'sourceSha', 'role', 'ownedScope', 'prohibitedScope', 'requiredChecks', 'steps', 'mutationBudget']
};

const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['ASK_USER', 'SEARCH', 'READ', 'PLAN', 'PATCH', 'RUN_CHECKS', 'REVIEW', 'ESCALATE']
    },
    summary: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    target: { type: ['string', 'null'] },
    reason: { type: 'string' }
  },
  required: ['action', 'summary', 'confidence', 'target', 'reason']
};

module.exports = { DISCOVERY_SCHEMA, WORK_PACKAGE_SCHEMA, ACTION_SCHEMA };
