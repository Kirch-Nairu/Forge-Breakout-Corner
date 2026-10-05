'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { atomicJson, ensureDir, now, readJson, safeId } = require('../lib/atomic-json');
const { transitionEpisode } = require('../core/lifecycle');

class EpisodeStore {
  constructor(root) {
    this.root = root;
    this.episodesDir = path.join(root, 'episodes');
    this.locks = new Map();
  }

  async init() {
    await ensureDir(this.episodesDir);
  }

  file(id) {
    if (!/^episode-[A-Za-z0-9-]+$/.test(id)) throw Object.assign(new Error('Invalid episode id.'), { status: 400 });
    return path.join(this.episodesDir, `${id}.json`);
  }

  async create({ goal, repositoryPath = '', repoFacts = null }) {
    const id = safeId('episode');
    const at = now();
    const episode = {
      id,
      version: 1,
      state: 'PLANNED',
      goal: String(goal || '').trim(),
      repositoryPath: String(repositoryPath || '').trim(),
      repoFacts,
      uncertainties: [],
      answers: [],
      workPackage: null,
      grants: { writeAuthorized: false, promotionAuthorized: false, deploymentAuthorized: false },
      createdAt: at,
      updatedAt: at,
      transitions: [],
      events: [{ type: 'EPISODE_CREATED', at }]
    };
    if (!episode.goal) throw Object.assign(new Error('goal is required'), { status: 400 });
    await atomicJson(this.file(id), episode);
    return episode;
  }

  async get(id) {
    const value = await readJson(this.file(id), null);
    if (!value) throw Object.assign(new Error(`Episode not found: ${id}`), { status: 404 });
    return value;
  }

  async list() {
    await this.init();
    const names = (await fsp.readdir(this.episodesDir)).filter(x => x.endsWith('.json')).sort();
    const rows = [];
    for (const name of names) {
      const value = await readJson(path.join(this.episodesDir, name), null);
      if (value) rows.push(value);
    }
    return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async mutate(id, fn) {
    const previous = this.locks.get(id) || Promise.resolve();
    const next = previous.then(async () => {
      const current = await this.get(id);
      const changed = await fn(structuredClone(current));
      const value = { ...changed, id: current.id, version: current.version + 1, updatedAt: now() };
      await atomicJson(this.file(id), value);
      return value;
    });
    this.locks.set(id, next.catch(() => {}));
    return next;
  }

  async transition(id, to, detail = {}) {
    return this.mutate(id, episode => transitionEpisode(episode, to, detail));
  }

  async event(id, type, detail = {}) {
    return this.mutate(id, episode => ({
      ...episode,
      events: [...(episode.events || []), { type, at: now(), ...detail }]
    }));
  }
}

module.exports = { EpisodeStore };
