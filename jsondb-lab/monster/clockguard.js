'use strict';

const path = require('path');
const { now, ensureDir, readJson, atomicJson, appendJsonl } = require('./jsonfs');

class SovereignClock {
  constructor(savior, options = {}) {
    this.savior = savior;
    this.root = path.join(savior.root, 'sovereign-clock');
    this.stateFile = path.join(this.root, 'state.json');
    this.events = path.join(this.root, 'events.jsonl');
    this.rollbackToleranceMs = Math.max(0, Number(options.rollbackToleranceMs || 2_000));
  }

  async init() {
    await ensureDir(this.root);
    let state = await readJson(this.stateFile, null);
    if (!state) {
      const wall = Date.now();
      state = {
        format: 'JSONDB-SOVEREIGN-CLOCK-1', generation: 1,
        lastWallMs: wall, logical: 0, ticks: 0,
        createdAt: now(), uncertain: false, anomalies: 0
      };
      await atomicJson(this.stateFile, state);
    }
    return state;
  }

  async tick(label = 'tick', metadata = {}) {
    const state = await this.init();
    const wall = Date.now();
    const rollbackMs = Math.max(0, Number(state.lastWallMs || 0) - wall);
    let anomaly = null;
    if (rollbackMs > this.rollbackToleranceMs) {
      state.uncertain = true;
      state.anomalies = Number(state.anomalies || 0) + 1;
      anomaly = { type: 'WALL_CLOCK_ROLLBACK', rollbackMs, priorWallMs: state.lastWallMs, observedWallMs: wall };
    }

    if (wall > Number(state.lastWallMs || 0)) {
      state.lastWallMs = wall;
      state.logical = 0;
    } else {
      state.logical = Number(state.logical || 0) + 1;
    }
    state.ticks = Number(state.ticks || 0) + 1;
    state.updatedAt = now();
    const stamp = `${String(state.lastWallMs).padStart(16,'0')}-${String(state.logical).padStart(8,'0')}-${String(state.ticks).padStart(12,'0')}`;
    const event = {
      format: 'JSONDB-SOVEREIGN-TICK-1', stamp, label,
      wallObservedMs: wall, monotonicWallMs: state.lastWallMs,
      logical: state.logical, tick: state.ticks,
      uncertain: state.uncertain, anomaly, metadata
    };
    await atomicJson(this.stateFile, state);
    await appendJsonl(this.events, event);
    return event;
  }

  async audit(options = {}) {
    const state = await this.init();
    const wall = Date.now();
    const rollbackMs = Math.max(0, Number(state.lastWallMs || 0) - wall);
    const severe = rollbackMs > this.rollbackToleranceMs;
    const result = {
      format: 'JSONDB-SOVEREIGN-CLOCK-AUDIT-1', at: now(),
      severe, rollbackMs, rollbackToleranceMs: this.rollbackToleranceMs,
      state, observedWallMs: wall,
      doctrine: 'Ordering authority comes from persisted monotonic wall/logical epochs. Wall time is metadata and may be declared uncertain.'
    };
    if (severe && options.freezeOnRollback !== false) await this.savior.setMode('read-only', `Sovereign Clock detected ${rollbackMs}ms wall-clock rollback.`);
    return result;
  }

  async acknowledge(reason = 'operator acknowledged clock anomaly') {
    const state = await this.init();
    state.uncertain = false;
    state.acknowledgedAt = now();
    state.acknowledgementReason = reason;
    state.generation = Number(state.generation || 0) + 1;
    await atomicJson(this.stateFile, state);
    await appendJsonl(this.events, { type: 'CLOCK_ACKNOWLEDGEMENT', at: now(), generation: state.generation, reason });
    return state;
  }
}

module.exports = { SovereignClock };
