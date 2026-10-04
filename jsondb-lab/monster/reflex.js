'use strict';

const path = require('path');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

const LEVELS = ['GREEN','YELLOW','ORANGE','RED','BLACK'];
function severity(level) { return Math.max(0, LEVELS.indexOf(level)); }

class SelfPreservationReflex {
  constructor({
    savior, oracle, trustBudget, fabric, challenge = null, memory = null,
    trinity = null, formatCapsule = null, civilizationSeed = null,
    runtime = null, clock = null, durability = null
  }) {
    Object.assign(this, {
      savior, oracle, trustBudget, fabric, challenge, memory, trinity,
      formatCapsule, civilizationSeed, runtime, clock, durability
    });
    this.root = path.join(savior.root, 'self-preservation-reflex');
    this.stateFile = path.join(this.root, 'state.json');
  }

  async init() {
    await ensureDir(this.root);
    let state = await readJson(this.stateFile, null);
    if (!state) {
      state = {
        format: 'JSONDB-REFLEX-STATE-1', createdAt: now(),
        latchedLevel: 'GREEN', currentObservation: 'UNKNOWN',
        operatorResetRequiredToDeescalate: true,
        history: []
      };
      await atomicJson(this.stateFile, state);
    }
    return state;
  }

  async sense(options = {}) {
    await this.init();
    const oracle = await this.oracle.assess({ verifyArchives: options.verifyArchives === true }).catch(error => ({ verdict: 'PANIC', confidence: 0, contradictions: [{ type: 'ORACLE_ERROR', penalty: 100, error: error.message }] }));
    const diversity = this.trustBudget.evaluate(oracle);
    const runtime = this.runtime ? await this.runtime.status().catch(error => ({ error: error.message })) : null;
    const clock = this.clock ? await this.clock.audit({ freezeOnRollback: false }).catch(error => ({ severe: true, error: error.message })) : null;
    const challengeLatest = this.challenge ? await readJson(path.join(this.challenge.root, 'latest.json'), null) : null;
    const durabilityLatest = this.durability ? await readJson(path.join(this.durability.root, 'latest.json'), null) : null;
    const recovery = {
      trinity: this.trinity ? await readJson(path.join(this.trinity.root, 'latest.json'), null) : null,
      memory: this.memory ? await readJson(path.join(this.memory.root, 'latest.json'), null) : null,
      seed: this.civilizationSeed ? await readJson(path.join(this.civilizationSeed.root, 'latest.json'), null) : null
    };

    const reasons = [];
    let level = 'GREEN';
    const raise = (candidate, reason) => {
      if (severity(candidate) > severity(level)) level = candidate;
      reasons.push({ level: candidate, reason });
    };

    if (oracle.verdict === 'READ_ONLY') raise('ORANGE', `Oracle=${oracle.verdict} confidence=${oracle.confidence}`);
    if (oracle.verdict === 'PANIC') raise('RED', `Oracle=${oracle.verdict} confidence=${oracle.confidence}`);
    if (oracle.confidence < 35) raise('BLACK', `Oracle confidence critically low: ${oracle.confidence}`);
    else if (oracle.confidence < 60) raise('RED', `Oracle confidence low: ${oracle.confidence}`);
    else if (oracle.confidence < 82) raise('YELLOW', `Oracle confidence below normal: ${oracle.confidence}`);

    if (diversity.verdict === 'UNTRUSTED') raise('BLACK', `Failure-domain trust=${diversity.verdict} ${diversity.independenceAdjustedConfidence}%`);
    else if (diversity.verdict === 'INSUFFICIENT_DIVERSITY') raise('ORANGE', `Failure-domain diversity insufficient: ${diversity.independenceAdjustedConfidence}%`);
    else if (diversity.verdict === 'NARROW_TRUST') raise('YELLOW', `Trust is concentrated: ${diversity.independenceAdjustedConfidence}%`);

    if (clock?.severe) raise('RED', `Sovereign Clock rollback ${clock.rollbackMs}ms`);
    if (runtime?.boot?.active && runtime.boot.active.bootId !== runtime.boot.thisBootId) raise('BLACK', 'Runtime lease is not owned by this boot.');
    if (runtime?.errors?.length) raise('YELLOW', `${runtime.errors.length} runtime-guard errors recorded.`);
    if (challengeLatest && challengeLatest.healthy === false) raise('ORANGE', `Latest challenge scrub: ${challengeLatest.disagreements} disagreements, ${challengeLatest.unreadable} unreadable.`);
    if (durabilityLatest && durabilityLatest.healthy === false) raise('BLACK', 'Latest durability reality check failed critical primitives.');
    if ((oracle.contradictions || []).some(x => ['LIVE_CHRONICLE_REPLAY_CONTRADICTION','SIGNED_TEMPORAL_ROOT_CONTRADICTION','BRAID_CHAIN_INVALID'].includes(x.type))) raise('BLACK', 'Direct independent-history contradiction exists.');

    if (!recovery.trinity && level !== 'GREEN') raise('ORANGE', 'No Trinity recovery generation exists while system is degraded.');
    if (!recovery.memory && severity(level) >= severity('ORANGE')) raise('RED', 'No Memory Palace snapshot exists during elevated survival state.');

    return {
      format: 'JSONDB-REFLEX-SENSE-1', at: now(), level, reasons,
      oracle, diversity,
      runtime: runtime ? { errors: runtime.errors?.length || 0, boot: runtime.boot, clock: runtime.clock } : null,
      clock,
      challengeLatest: challengeLatest ? { id: challengeLatest.id, healthy: challengeLatest.healthy, disagreements: challengeLatest.disagreements, unreadable: challengeLatest.unreadable } : null,
      durabilityLatest: durabilityLatest ? { id: durabilityLatest.id, healthy: durabilityLatest.healthy } : null,
      recovery: {
        trinity: recovery.trinity?.id || null,
        memory: recovery.memory?.id || null,
        seed: recovery.seed?.id || null
      }
    };
  }

  async executeSafely(label, fn) {
    try { return { action: label, ok: true, result: await fn() }; }
    catch (error) { return { action: label, ok: false, error: error.message }; }
  }

  async respond(options = {}) {
    const state = await this.init();
    const sensed = await this.sense(options);
    const observedSeverity = severity(sensed.level);
    const latchedSeverity = severity(state.latchedLevel || 'GREEN');
    const effectiveLevel = LEVELS[Math.max(observedSeverity, latchedSeverity)];
    const actions = [];

    if (effectiveLevel === 'YELLOW') {
      actions.push(await this.executeSafely('CAPTURE_MIRRORS', () => this.savior.captureMirrors()));
      if (this.memory) actions.push(await this.executeSafely('MEMORY_SNAPSHOT', () => this.memory.snapshot('reflex-yellow')));
      actions.push(await this.executeSafely('BRAID_SEAL', () => this.fabric.seal('reflex-yellow', { level: 'NORMAL' })));
    }

    if (effectiveLevel === 'ORANGE') {
      if ((await this.savior.status()).mode === 'read-write') actions.push(await this.executeSafely('FREEZE_WRITES', () => this.savior.setMode('read-only', 'Self-Preservation Reflex ORANGE')));
      actions.push(await this.executeSafely('CAPTURE_MIRRORS', () => this.savior.captureMirrors()));
      if (this.challenge) actions.push(await this.executeSafely('CHALLENGE_SCRUB', () => this.challenge.challenge({ perFile: 8, freezeOnFailure: false })));
      if (this.memory) actions.push(await this.executeSafely('MEMORY_SNAPSHOT', () => this.memory.snapshot('reflex-orange')));
      if (this.trinity) actions.push(await this.executeSafely('TRINITY_ARCHIVE', () => this.trinity.archive('reflex-orange')));
      if (this.formatCapsule) actions.push(await this.executeSafely('FORMAT_POLYGLOT', () => this.formatCapsule.archive('reflex-orange')));
    }

    if (effectiveLevel === 'RED') {
      if ((await this.savior.status()).mode === 'read-write') actions.push(await this.executeSafely('FREEZE_WRITES', () => this.savior.setMode('read-only', 'Self-Preservation Reflex RED')));
      if (this.memory) actions.push(await this.executeSafely('MEMORY_SNAPSHOT', () => this.memory.snapshot('reflex-red')));
      if (this.trinity) actions.push(await this.executeSafely('TRINITY_ARCHIVE', () => this.trinity.archive('reflex-red')));
      if (this.formatCapsule) actions.push(await this.executeSafely('FORMAT_POLYGLOT', () => this.formatCapsule.archive('reflex-red')));
      if (this.civilizationSeed) actions.push(await this.executeSafely('CIVILIZATION_SEED', () => this.civilizationSeed.create('reflex-red')));
      if (this.challenge) actions.push(await this.executeSafely('DEEP_CHALLENGE_SCRUB', () => this.challenge.challenge({ perFile: 16, freezeOnFailure: false })));
    }

    if (effectiveLevel === 'BLACK') {
      actions.push(await this.executeSafely('EMERGENCY_SEAL', () => this.fabric.emergencySeal('Self-Preservation Reflex BLACK')));
      if (this.memory) actions.push(await this.executeSafely('MEMORY_SNAPSHOT', () => this.memory.snapshot('reflex-black')));
      if (this.trinity) actions.push(await this.executeSafely('TRINITY_ARCHIVE', () => this.trinity.archive('reflex-black')));
      if (this.formatCapsule) actions.push(await this.executeSafely('FORMAT_POLYGLOT', () => this.formatCapsule.archive('reflex-black')));
      if (this.civilizationSeed) actions.push(await this.executeSafely('CIVILIZATION_SEED', () => this.civilizationSeed.create('reflex-black')));
      if ((await this.savior.status()).mode !== 'panic') actions.push(await this.executeSafely('ENTER_PANIC', () => this.savior.setMode('panic', 'Self-Preservation Reflex BLACK')));
    }

    state.currentObservation = sensed.level;
    state.latchedLevel = effectiveLevel;
    state.lastAt = now();
    state.history = [...(state.history || []), { at: state.lastAt, observed: sensed.level, latched: effectiveLevel, actions: actions.map(x => ({ action: x.action, ok: x.ok })) }].slice(-200);
    await atomicJson(this.stateFile, state);
    return {
      format: 'JSONDB-REFLEX-RESPONSE-1', at: now(),
      observedLevel: sensed.level, previousLatchedLevel: LEVELS[latchedSeverity], latchedLevel: effectiveLevel,
      sensed, actions,
      doctrine: 'Reflex automation may add redundancy and reduce authority. It never reopens writes, promotes recovered state, or lowers the latched survival level without explicit operator reset.'
    };
  }

  async operatorReset(level = 'GREEN', reason = 'operator reset') {
    if (!LEVELS.includes(level)) throw new Error(`Invalid reflex level: ${level}`);
    const state = await this.init();
    state.latchedLevel = level;
    state.operatorResetAt = now();
    state.operatorResetReason = reason;
    await atomicJson(this.stateFile, state);
    return state;
  }
}

module.exports = { SelfPreservationReflex, LEVELS, severity };
