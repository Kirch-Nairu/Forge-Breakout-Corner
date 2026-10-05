'use strict';

const TRANSITIONS = Object.freeze({
  PLANNED: ['DISCOVERY', 'BLOCKED'],
  DISCOVERY: ['NEEDS_INFORMATION', 'DECISION_READY', 'BLOCKED'],
  NEEDS_INFORMATION: ['DISCOVERY', 'DECISION_READY', 'BLOCKED'],
  DECISION_READY: ['AUTHORIZED', 'BLOCKED'],
  AUTHORIZED: ['ACTIVE', 'BLOCKED'],
  ACTIVE: ['BLOCKED', 'READY', 'QUARANTINED'],
  BLOCKED: ['ACTIVE', 'REWORK', 'REJECTED'],
  READY: ['UNDER_REVIEW', 'BLOCKED'],
  UNDER_REVIEW: ['ACCEPTED', 'REWORK', 'REJECTED', 'QUARANTINED'],
  REWORK: ['ACTIVE', 'BLOCKED', 'REJECTED'],
  ACCEPTED: ['INTEGRATED', 'REWORK'],
  REJECTED: [],
  QUARANTINED: ['REWORK', 'REJECTED'],
  INTEGRATED: ['PROMOTED', 'REWORK'],
  PROMOTED: ['OBSERVED', 'QUARANTINED'],
  OBSERVED: []
});

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

function transitionEpisode(episode, to, detail = {}) {
  const from = episode.state;
  if (!canTransition(from, to)) {
    const err = new Error(`Illegal KIRION lifecycle transition: ${from} -> ${to}`);
    err.code = 'ILLEGAL_TRANSITION';
    throw err;
  }
  const at = new Date().toISOString();
  return {
    ...episode,
    state: to,
    updatedAt: at,
    transitions: [
      ...(episode.transitions || []),
      { from, to, at, ...detail }
    ]
  };
}

module.exports = { TRANSITIONS, canTransition, transitionEpisode };
