'use strict';

const { now } = require('./jsonfs');

class RuntimeGuard {
  constructor({ savior, bootSentinel, clock, heartbeatMs = 10_000 }) {
    this.savior = savior;
    this.boot = bootSentinel;
    this.clock = clock;
    this.heartbeatMs = Math.max(2_000, Number(heartbeatMs || 10_000));
    this.timer = null;
    this.started = null;
    this.lastHeartbeat = null;
    this.errors = [];
  }

  async begin(metadata = {}) {
    const clockAudit = await this.clock.audit({ freezeOnRollback: true });
    const boot = await this.boot.begin({ ...metadata, clockUncertain: clockAudit.state?.uncertain || false });
    const tick = await this.clock.tick('runtime-begin', { bootId: boot.bootId });
    this.started = { at: now(), boot, clockAudit, tick };
    return this.started;
  }

  startHeartbeat() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.heartbeat().catch(error => this.errors.push({ at: now(), stage: 'heartbeat', error: error.message }));
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  async heartbeat() {
    const state = await this.savior.status();
    const clockTick = await this.clock.tick('runtime-heartbeat', { mode: state.mode });
    const lease = await this.boot.heartbeat({ mode: state.mode, sovereignStamp: clockTick.stamp });
    if (!lease.ok) await this.savior.setMode('read-only', `Runtime Guard lost boot lease: ${lease.reason}`);
    this.lastHeartbeat = { at: now(), lease, clockTick };
    return this.lastHeartbeat;
  }

  async shutdown(reason = 'graceful runtime shutdown') {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const tick = await this.clock.tick('runtime-shutdown', { reason }).catch(error => ({ error: error.message }));
    const clean = await this.boot.cleanShutdown(reason);
    return { at: now(), reason, tick, clean };
  }

  async status() {
    return {
      format: 'JSONDB-RUNTIME-GUARD-1', heartbeatMs: this.heartbeatMs,
      started: this.started, lastHeartbeat: this.lastHeartbeat,
      boot: await this.boot.status(),
      clock: await this.clock.audit({ freezeOnRollback: false }),
      errors: this.errors.slice(-50)
    };
  }
}

module.exports = { RuntimeGuard };
