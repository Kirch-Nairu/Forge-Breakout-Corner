'use strict';

const { safeId, now } = require('../lib/atomic-json');

const RISK = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 4, CRITICAL: 6 });

function clamp(value, min = 0, max = 5) {
  const n = Number(value || 0);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : 0));
}

function normalizeUncertainty(raw = {}) {
  return {
    id: raw.id || safeId('uncertainty'),
    subject: String(raw.subject || 'Unspecified decision').trim(),
    question: String(raw.question || '').trim(),
    why: String(raw.why || '').trim(),
    risk: String(raw.risk || 'MEDIUM').toUpperCase(),
    architectureImpact: clamp(raw.architectureImpact),
    irreversibility: clamp(raw.irreversibility),
    unblocksImplementation: clamp(raw.unblocksImplementation),
    guessingRisk: clamp(raw.guessingRisk),
    repositoryAnswerable: Boolean(raw.repositoryAnswerable),
    status: raw.status || 'OPEN',
    answer: raw.answer ?? null,
    createdAt: raw.createdAt || now(),
    resolvedAt: raw.resolvedAt || null
  };
}

function scoreUncertainty(raw) {
  const u = normalizeUncertainty(raw);
  if (u.status === 'RESOLVED') return Number.NEGATIVE_INFINITY;
  if (u.repositoryAnswerable) return -1000;
  return (RISK[u.risk] || RISK.MEDIUM) * 5
    + u.architectureImpact * 4
    + u.irreversibility * 3
    + u.unblocksImplementation * 5
    + u.guessingRisk * 4;
}

function selectNextQuestion(uncertainties = []) {
  const ranked = uncertainties
    .map(normalizeUncertainty)
    .map(item => ({ item, score: scoreUncertainty(item) }))
    .filter(x => Number.isFinite(x.score) && x.score >= 0 && x.item.question)
    .sort((a, b) => b.score - a.score || a.item.createdAt.localeCompare(b.item.createdAt));
  return ranked[0] || null;
}

function resolveUncertainty(uncertainties, id, answer) {
  let found = false;
  const at = now();
  const next = uncertainties.map(raw => {
    const u = normalizeUncertainty(raw);
    if (u.id !== id) return u;
    found = true;
    return { ...u, status: 'RESOLVED', answer: String(answer || '').trim(), resolvedAt: at };
  });
  if (!found) throw Object.assign(new Error(`Unknown uncertainty: ${id}`), { status: 404 });
  return next;
}

function hasBlockingUserQuestions(uncertainties = []) {
  return uncertainties.some(raw => {
    const u = normalizeUncertainty(raw);
    return u.status !== 'RESOLVED' && !u.repositoryAnswerable && Boolean(u.question);
  });
}

module.exports = {
  normalizeUncertainty,
  scoreUncertainty,
  selectNextQuestion,
  resolveUncertainty,
  hasBlockingUserQuestions
};
