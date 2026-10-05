'use strict';

const http = require('http');
const fsp = require('fs/promises');
const path = require('path');
const { sendJson, readJsonBody } = require('../lib/http');
const { EpisodeStore } = require('../state/episode-store');
const { inspectRepository } = require('./repo-inspector');
const { workerHealth, workerInfer } = require('./worker-client');
const { DISCOVERY_SCHEMA, WORK_PACKAGE_SCHEMA } = require('../llm/schemas');
const { normalizeUncertainty, selectNextQuestion, resolveUncertainty, hasBlockingUserQuestions } = require('../core/question-engine');
const { validateWorkPackage } = require('../core/work-package');
const { now } = require('../lib/atomic-json');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

function humanIntent(req, expected) {
  return String(req.headers['x-kirion-human-intent'] || '').toUpperCase() === expected;
}

function discoveryPrompt(episode) {
  return {
    role: 'INTERVIEWER',
    jobClass: 'LIGHT',
    schemaName: 'kirion_discovery',
    schema: DISCOVERY_SCHEMA,
    system: [
      'You are the KIRION product discovery interviewer.',
      'Do not write code.',
      'Do not ask generic questions that repository evidence already answers.',
      'Return only decisions that materially affect product behavior, authorization, architecture, data semantics, irreversible UX, security, deployment, or acceptance.',
      'If the evidence is insufficient, ask one concrete targeted question per uncertainty.',
      'Never claim evidence that is not present.'
    ].join('\n'),
    messages: [{
      role: 'user',
      content: JSON.stringify({ goal: episode.goal, repository: episode.repoFacts }, null, 2)
    }]
  };
}

function workPackagePrompt(episode) {
  return {
    role: 'PLANNER',
    jobClass: 'CODE',
    schemaName: 'kirion_work_package',
    schema: WORK_PACKAGE_SCHEMA,
    system: [
      'You are the KIRION bounded implementation planner.',
      'Produce a proposed Code Writer work package only; you do not have mutation authority.',
      'Use the exact repository HEAD SHA supplied as sourceSha.',
      'Keep ownedScope as narrow as possible and declare prohibitedScope explicitly.',
      'Include negative/regression checks when authorization, state transitions, persistence, or security are involved.',
      'Do not invent a different source SHA.'
    ].join('\n'),
    messages: [{
      role: 'user',
      content: JSON.stringify({
        goal: episode.goal,
        repository: episode.repoFacts,
        decisions: (episode.uncertainties || []).filter(x => x.status === 'RESOLVED').map(x => ({ subject: x.subject, answer: x.answer }))
      }, null, 2)
    }]
  };
}

function createControlServer(config, overrides = {}) {
  const store = overrides.store || new EpisodeStore(config.stateDir);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://control.local');

      if (req.method === 'GET' && STATIC.has(url.pathname)) {
        const [name, type] = STATIC.get(url.pathname);
        const body = await fsp.readFile(path.join(PUBLIC, name));
        res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store' });
        return res.end(body);
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        let worker;
        try { worker = await workerHealth(config); } catch (err) { worker = { online: false, error: err.message }; }
        return sendJson(res, 200, { service: 'KIRION_CONTROL', profile: config.profile, worker });
      }

      if (req.method === 'GET' && url.pathname === '/api/episodes') {
        return sendJson(res, 200, { episodes: await store.list() });
      }

      if (req.method === 'POST' && url.pathname === '/api/episodes') {
        const body = await readJsonBody(req);
        const repoFacts = body.repositoryPath ? await inspectRepository(body.repositoryPath) : null;
        let episode = await store.create({ goal: body.goal, repositoryPath: body.repositoryPath, repoFacts });
        episode = await store.transition(episode.id, 'DISCOVERY', { reason: 'SESSION_STARTED' });
        return sendJson(res, 201, episode);
      }

      const episodeMatch = url.pathname.match(/^\/api\/episodes\/(episode-[A-Za-z0-9-]+)$/);
      if (req.method === 'GET' && episodeMatch) return sendJson(res, 200, await store.get(episodeMatch[1]));

      const actionMatch = url.pathname.match(/^\/api\/episodes\/(episode-[A-Za-z0-9-]+)\/(discover|answer|work-package|authorize)$/);
      if (req.method === 'POST' && actionMatch) {
        const [, id, action] = actionMatch;
        let episode = await store.get(id);
        const body = await readJsonBody(req, 2 * 1024 * 1024);

        if (action === 'discover') {
          if (!['DISCOVERY', 'NEEDS_INFORMATION'].includes(episode.state)) return sendJson(res, 409, { error: 'DISCOVERY_NOT_ALLOWED_IN_STATE', state: episode.state });
          const result = await workerInfer(config, discoveryPrompt(episode));
          const uncertainties = (result.data.uncertainties || []).map(x => normalizeUncertainty({ ...x, repositoryAnswerable: false }));
          episode = await store.mutate(id, current => ({
            ...current,
            discoveryFacts: result.data.facts || [],
            uncertainties,
            events: [...(current.events || []), { type: 'DISCOVERY_COMPLETED', at: now(), uncertaintyCount: uncertainties.length }]
          }));
          const target = hasBlockingUserQuestions(uncertainties) ? 'NEEDS_INFORMATION' : 'DECISION_READY';
          if (episode.state !== target) episode = await store.transition(id, target, { reason: 'DISCOVERY_RESULT' });
          return sendJson(res, 200, { episode, nextQuestion: selectNextQuestion(episode.uncertainties) });
        }

        if (action === 'answer') {
          if (episode.state !== 'NEEDS_INFORMATION') return sendJson(res, 409, { error: 'NO_ACTIVE_QUESTION_PHASE', state: episode.state });
          const uncertainties = resolveUncertainty(episode.uncertainties || [], body.uncertaintyId, body.answer);
          episode = await store.mutate(id, current => ({
            ...current,
            uncertainties,
            answers: [...(current.answers || []), { uncertaintyId: body.uncertaintyId, answer: String(body.answer || ''), at: now() }]
          }));
          if (!hasBlockingUserQuestions(uncertainties)) episode = await store.transition(id, 'DECISION_READY', { reason: 'BLOCKING_QUESTIONS_RESOLVED' });
          return sendJson(res, 200, { episode, nextQuestion: selectNextQuestion(episode.uncertainties) });
        }

        if (action === 'work-package') {
          if (episode.state !== 'DECISION_READY') return sendJson(res, 409, { error: 'DECISION_READY_REQUIRED', state: episode.state });
          if (!episode.repoFacts?.head) return sendJson(res, 409, { error: 'REPOSITORY_EVIDENCE_REQUIRED' });
          const result = await workerInfer(config, workPackagePrompt(episode));
          const proposed = validateWorkPackage({ ...result.data, sourceSha: episode.repoFacts.head });
          episode = await store.mutate(id, current => ({
            ...current,
            workPackage: { ...proposed, status: 'PROPOSED', proposedAt: now() },
            events: [...(current.events || []), { type: 'WORK_PACKAGE_PROPOSED', at: now() }]
          }));
          return sendJson(res, 200, episode);
        }

        if (action === 'authorize') {
          if (!humanIntent(req, 'AUTHORIZE_IMPLEMENTATION')) return sendJson(res, 403, { error: 'EXPLICIT_HUMAN_INTENT_REQUIRED' });
          if (episode.state !== 'DECISION_READY' || !episode.workPackage) return sendJson(res, 409, { error: 'PROPOSED_WORK_PACKAGE_REQUIRED' });
          if (body.sourceSha !== episode.workPackage.sourceSha || body.sourceSha !== episode.repoFacts?.head) return sendJson(res, 409, { error: 'SOURCE_SHA_MISMATCH' });
          episode = await store.mutate(id, current => ({
            ...current,
            workPackage: { ...current.workPackage, status: 'AUTHORIZED', authorizedAt: now() },
            grants: { ...current.grants, writeAuthorized: true },
            events: [...(current.events || []), { type: 'HUMAN_WRITE_AUTHORITY_GRANTED', at: now(), sourceSha: body.sourceSha }]
          }));
          episode = await store.transition(id, 'AUTHORIZED', { reason: 'EXPLICIT_HUMAN_AUTHORIZATION', sourceSha: body.sourceSha });
          return sendJson(res, 200, episode);
        }
      }

      return sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message, code: err.code || null, details: err.errors || null });
    }
  });
}

module.exports = { createControlServer, discoveryPrompt, workPackagePrompt };
