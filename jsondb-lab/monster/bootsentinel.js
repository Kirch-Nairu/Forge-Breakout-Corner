'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson, appendJsonl } = require('./jsonfs');

class BootSentinel {
  constructor(savior, options = {}) {
    this.savior = savior;
    this.root = path.join(savior.root, 'boot-sentinel');
    this.activeFile = path.join(this.root, 'ACTIVE.json');
    this.lastClean = path.join(this.root, 'LAST-CLEAN.json');
    this.history = path.join(this.root, 'boots.jsonl');
    this.staleMs = Math.max(5_000, Number(options.staleMs || 30_000));
    this.bootId = null;
  }

  async init() { await ensureDir(this.root); }

  async begin(metadata = {}) {
    await this.init();
    const prior = await readJson(this.activeFile, null);
    const currentTime = Date.now();
    const priorHeartbeatMs = prior?.heartbeatAt ? Date.parse(prior.heartbeatAt) : NaN;
    const freshPriorLease = Boolean(prior && Number.isFinite(priorHeartbeatMs) && currentTime - priorHeartbeatMs < this.staleMs);
    const dirtyPrior = Boolean(prior && !freshPriorLease);
    const concurrentPrior = Boolean(prior && freshPriorLease);

    this.bootId = crypto.randomUUID();
    const record = {
      format: 'JSONDB-BOOT-SENTINEL-1', bootId: this.bootId,
      startedAt: now(), heartbeatAt: now(), pid: process.pid,
      metadata,
      prior: prior ? { bootId: prior.bootId, pid: prior.pid, heartbeatAt: prior.heartbeatAt } : null,
      diagnosis: concurrentPrior ? 'POSSIBLE_CONCURRENT_OWNER' : dirtyPrior ? 'UNCLEAN_PREVIOUS_SHUTDOWN' : 'CLEAN_START'
    };
    await atomicJson(this.activeFile, record);
    await appendJsonl(this.history, { type: 'BOOT_BEGIN', ...record });

    if (concurrentPrior) {
      await this.savior.setMode('read-only', `Boot Sentinel saw fresh lease from boot ${prior.bootId}; possible concurrent owner.`);
    } else if (dirtyPrior) {
      await this.savior.setMode('read-only', `Boot Sentinel detected unclean previous boot ${prior.bootId}; survival review required.`);
    }
    return { ...record, concurrentPrior, dirtyPrior, authorityReduced: concurrentPrior || dirtyPrior };
  }

  async heartbeat(extra = {}) {
    await this.init();
    const active = await readJson(this.activeFile, null);
    if (!active || active.bootId !== this.bootId) return { ok: false, reason: 'active lease is absent or owned by another boot', activeBootId: active?.bootId || null, thisBootId: this.bootId };
    active.heartbeatAt = now();
    active.extra = extra;
    await atomicJson(this.activeFile, active);
    return { ok: true, bootId: this.bootId, heartbeatAt: active.heartbeatAt };
  }

  async cleanShutdown(reason = 'graceful shutdown') {
    await this.init();
    const active = await readJson(this.activeFile, null);
    const record = {
      format: 'JSONDB-CLEAN-SHUTDOWN-1', at: now(), reason,
      bootId: this.bootId || active?.bootId || null,
      pid: process.pid
    };
    await atomicJson(this.lastClean, record);
    await appendJsonl(this.history, { type: 'BOOT_CLEAN_SHUTDOWN', ...record });
    if (active && (!this.bootId || active.bootId === this.bootId)) await fsp.unlink(this.activeFile).catch(() => {});
    return record;
  }

  async status() {
    await this.init();
    return {
      active: await readJson(this.activeFile, null),
      lastClean: await readJson(this.lastClean, null),
      thisBootId: this.bootId,
      staleMs: this.staleMs
    };
  }
}

module.exports = { BootSentinel };
