'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, uuid, ensureDir, readJson, atomicJson } = require('./jsonfs');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }

class StatePassportOffice {
  constructor({
    engine, savior, canonicalQuorum, chronicle, braid, witnessCouncil,
    cryptoCouncil = null, trinity = null, conservation = null,
    oracle = null, trustBudget = null, polyhash = null, memory = null
  }) {
    Object.assign(this, {
      engine, savior, canonicalQuorum, chronicle, braid, witnessCouncil,
      cryptoCouncil, trinity, conservation, oracle, trustBudget, polyhash, memory
    });
    this.root = path.join(savior.root, 'state-passports');
    this.passports = path.join(this.root, 'passports');
  }

  async init() { await ensureDir(this.passports); }

  async world() {
    const catalog = await this.engine.catalog();
    const meta = await this.engine.meta();
    const tables = {};
    for (const name of Object.keys(catalog.collections || {}).sort()) tables[name] = await this.engine.loadCurrent(name);
    return { format: 'JSONDB-PASSPORT-WORLD-1', catalog, meta, tables };
  }

  confidenceClass(evidence) {
    const hardFail = [
      !evidence.canonical.unanimous,
      evidence.chronicle.valid !== true,
      evidence.chronicle.liveMatchesReplay === false,
      evidence.braid.valid !== true,
      evidence.conservation && evidence.conservation.status === 'VIOLATION',
      evidence.oracle && evidence.oracle.verdict === 'PANIC'
    ].some(Boolean);
    if (hardFail) return 'QUARANTINE';
    const sovereign = evidence.canonical.unanimous
      && evidence.chronicle.valid && evidence.chronicle.liveMatchesReplay
      && evidence.braid.valid
      && evidence.signatureFamilies?.status === 'DUAL_FAMILY_TRUST'
      && (!evidence.trinity || evidence.trinity.status === 'TRUSTED')
      && (!evidence.conservation || evidence.conservation.status === 'HEALTHY')
      && evidence.trustBudget?.verdict === 'DIVERSE_TRUST'
      && evidence.oracle?.verdict === 'SAFE';
    if (sovereign) return 'SOVEREIGN';
    const witnessed = evidence.canonical.unanimous
      && evidence.chronicle.valid
      && evidence.braid.valid
      && evidence.witnessCouncil.valid
      && ['SAFE','READ_ONLY'].includes(evidence.oracle?.verdict || 'READ_ONLY');
    if (witnessed) return 'WITNESSED';
    return 'DEGRADED';
  }

  async issue(label = 'state-passport', options = {}) {
    await this.init();
    const world = await this.world();
    const canonical = await this.canonicalQuorum.verify(world, { freezeOnDivergence: options.freezeOnDivergence !== false });
    const chronicle = await this.chronicle.verify();
    const braid = await this.braid.verify();
    const witnessCouncil = await this.witnessCouncil.verifyRound();
    const signatureFamilies = this.cryptoCouncil ? await this.cryptoCouncil.verify() : null;
    const trinity = this.trinity && options.verifyRecovery !== false ? await this.trinity.verify().catch(error=>({status:'ERROR',error:error.message})) : null;
    if (trinity?._buffers) delete trinity._buffers;
    const conservation = this.conservation ? await this.conservation.scan({ freezeOnViolation: options.freezeOnViolation !== false }) : null;
    const oracle = this.oracle ? await this.oracle.assess({ verifyArchives: options.verifyRecovery === true }) : null;
    const trustBudget = this.trustBudget && oracle ? this.trustBudget.evaluate(oracle) : null;
    const memoryLatest = this.memory ? await readJson(path.join(this.memory.root, 'latest.json'), null) : null;
    const evidence = {
      canonical: { unanimous: canonical.unanimous, semanticSha256: canonical.semanticSha256, outputs: canonical.outputs },
      chronicle: { valid: chronicle.valid, liveMatchesReplay: chronicle.liveMatchesReplay, sequence: chronicle.sequence, replayRoot: chronicle.replayRoot, liveRoot: chronicle.liveRoot },
      braid: { valid: braid.valid, epochs: braid.epochs, headHash: braid.headHash, currentContradictions: braid.currentContradictions },
      witnessCouncil: { valid: witnessCouncil.valid, validSignatures: witnessCouncil.validSignatures, threshold: witnessCouncil.threshold, roundId: witnessCouncil.statement?.roundId, worldRoot: witnessCouncil.statement?.worldRoot },
      signatureFamilies: signatureFamilies ? { valid: signatureFamilies.valid, status: signatureFamilies.status, familyQuorum: signatureFamilies.familyQuorum, worldRoot: signatureFamilies.worldRoot } : null,
      trinity: trinity ? { status: trinity.status, expectedSha256: trinity.expectedSha256, winner: trinity.winner } : null,
      conservation: conservation ? { status: conservation.status, laws: conservation.laws, violations: conservation.violations, criticalViolations: conservation.criticalViolations } : null,
      oracle: oracle ? { verdict: oracle.verdict, confidence: oracle.confidence, contradictions: oracle.contradictions } : null,
      trustBudget: trustBudget ? { verdict: trustBudget.verdict, independenceAdjustedConfidence: trustBudget.independenceAdjustedConfidence, activeDomains: trustBudget.activeDomains, healthyDomains: trustBudget.healthyDomains } : null,
      memoryPalace: memoryLatest ? { id: memoryLatest.id, worldSha256: memoryLatest.worldSha256, chunkMerkleRoot: memoryLatest.chunkMerkleRoot } : null
    };
    const confidenceClass = this.confidenceClass(evidence);
    const id = `${Date.now()}-${uuid().slice(0,8)}`;
    const passport = {
      format: 'JSONDB-STATE-PASSPORT-1', id, label, issuedAt: now(),
      worldSemanticSha256: canonical.semanticSha256,
      confidenceClass,
      evidence,
      policy: {
        classes: ['SOVEREIGN','WITNESSED','DEGRADED','QUARANTINE'],
        promotionAuthority: false,
        doctrine: 'A passport reports the evidence carried by a state. It does not grant canonical promotion authority.'
      }
    };
    passport.passportHash = digest(passport);
    if (this.polyhash) passport.polyhash = await this.polyhash.envelope(passport, { purpose: 'state-passport' });
    await atomicJson(path.join(this.passports, `${id}.json`), passport);
    await atomicJson(path.join(this.root, 'latest.json'), passport);
    return passport;
  }

  async verify(id = null, options = {}) {
    const readOnly = options.readOnly === true;
    if (!readOnly) await this.init();
    const passport = id ? await readJson(path.join(this.passports, `${id}.json`), null) : await readJson(path.join(this.root, 'latest.json'), null);
    if (!passport) return { valid: false, status: 'ABSENT', readOnly };
    const copy = { ...passport }; delete copy.passportHash; delete copy.polyhash;
    const staticHash = digest(copy);
    const staticValid = staticHash === passport.passportHash;
    let polyhash = null;
    if (this.polyhash && passport.polyhash) {
      const envelopeTarget = { ...copy, passportHash: passport.passportHash };
      polyhash = await this.polyhash.verify(envelopeTarget, passport.polyhash, { readOnly });
    }
    let live = null;
    if (options.live === true) {
      const world = await this.world();
      const canonical = await this.canonicalQuorum.verify(world, { freezeOnDivergence: false, readOnly });
      live = {
        worldSemanticSha256: canonical.semanticSha256,
        matchesPassport: canonical.semanticSha256 === passport.worldSemanticSha256,
        saviorMode: (await this.savior.status()).mode
      };
    }
    return {
      format: 'JSONDB-STATE-PASSPORT-VERIFY-3', id: passport.id,
      valid: staticValid && (!polyhash || polyhash.valid) && (!live || live.matchesPassport),
      readOnly,
      staticValid, polyhash, live,
      confidenceClass: passport.confidenceClass,
      worldSemanticSha256: passport.worldSemanticSha256,
      passportHash: passport.passportHash,
      computedPassportHash: staticHash
    };
  }
}

module.exports = { StatePassportOffice, digest, stable };
