'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

class RecoveryJury {
  constructor(kernel) {
    this.k = kernel;
    this.root = path.join(kernel.savior.root, 'recovery-jury');
    this.cases = path.join(this.root, 'cases');
  }

  async init() { await ensureDir(this.cases); }

  async candidate(value) {
    if (typeof value === 'string') {
      const text = await fsp.readFile(path.resolve(value), 'utf8');
      return { world: JSON.parse(text), source: path.resolve(value) };
    }
    return { world: value, source: 'in-memory' };
  }

  async lastSavior(id = null) {
    return id ? readJson(path.join(this.k.lastSavior.receipts, `${id}.json`), null) : readJson(path.join(this.k.lastSavior.root, 'latest.json'), null);
  }

  async deliberate(candidateValue, options = {}) {
    await this.init();
    const archive = await this.lastSavior(options.archiveId || null);
    if (!archive) throw new Error('Recovery Jury requires a LAST SAVIOR archive as the evidence target.');
    const candidate = await this.candidate(candidateValue);

    const canonical = await this.k.canonicalQuorum.verify(candidate.world, { freezeOnDivergence: false }).catch(error => ({ unanimous: false, error: error.message }));
    const expectedSemantic = archive.world?.semanticSha256 || null;
    const exactSemantic = Boolean(canonical.unanimous && expectedSemantic && canonical.semanticSha256 === expectedSemantic);

    const hologramId = archive.corroborationFamilies?.semanticHologram?.id || null;
    const hologram = hologramId
      ? await this.k.hologram.compare(candidate.world, hologramId).catch(error => ({ status: 'ERROR', confidence: 0, error: error.message }))
      : { status: 'ABSENT', confidence: 0 };

    const shadowLawId = archive.corroborationFamilies?.shadowLaws?.id || null;
    const shadowRecord = shadowLawId
      ? await this.k.shadowLaws.verifyRecord(shadowLawId).catch(error => ({ valid: false, error: error.message }))
      : { valid: false, status: 'ABSENT' };
    const shadow = shadowRecord.valid
      ? await this.k.shadowLaws.challenge(candidate.world, shadowLawId).catch(error => ({ status: 'ERROR', confidence: 0, error: error.message }))
      : { status: 'UNAVAILABLE', confidence: 0 };

    const archiveCheck = await this.k.lastSavior.verify(archive.id, { live: false }).catch(error => ({ valid: false, error: error.message }));
    const federation = await this.k.federation.verify(archive.world?.federationId || null, { live: false }).catch(error => ({ valid: false, error: error.message }));

    let ancestry = null;
    if (options.candidateCommit) {
      try {
        const candidateCommit = await this.k.worldTree.resolve(options.candidateCommit);
        const targetCommit = await this.k.worldTree.resolve(archive.world.worldTreeCommit);
        const common = await this.k.worldTree.commonAncestor(candidateCommit.id, targetCommit.id);
        ancestry = {
          candidate: candidateCommit.id,
          target: targetCommit.id,
          commonAncestor: common,
          sameCommit: candidateCommit.id === targetCommit.id,
          sameWorldSha256: candidateCommit.worldSha256 === targetCommit.worldSha256
        };
      } catch (error) { ancestry = { error: error.message }; }
    }

    const evidence = [];
    let score = 0;
    const award = (channel, possible, earned, details) => { score += earned; evidence.push({ channel, possible, earned, details }); };
    award('exact-semantic-world', 40, exactSemantic ? 40 : 0, { expected: expectedSemantic, actual: canonical.semanticSha256, unanimous: canonical.unanimous });
    const hologramPoints = hologram.status === 'IDENTICAL_SHADOW' ? 20 : hologram.confidence >= 90 ? 16 : hologram.confidence >= 70 ? 10 : hologram.confidence >= 40 ? 4 : 0;
    award('semantic-hologram', 20, hologramPoints, { status: hologram.status, confidence: hologram.confidence });
    const shadowPoints = shadow.status === 'SATISFIED' ? 20 : shadow.confidence >= 90 ? 15 : shadow.confidence >= 50 ? 5 : 0;
    award('shadow-laws', 20, shadowPoints, { status: shadow.status, confidence: shadow.confidence, lawRecordTrusted: shadowRecord.valid });
    award('archive-integrity', 10, archiveCheck.valid ? 10 : 0, { valid: archiveCheck.valid, healthyChannels: archiveCheck.healthyChannels });
    award('federation-lineage', 10, federation.valid ? 10 : 0, { valid: federation.valid, id: federation.id });

    const contradictions = [];
    if (canonical.unanimous && expectedSemantic && canonical.semanticSha256 !== expectedSemantic) contradictions.push({ type: 'EXACT_WORLD_HASH_MISMATCH', severity: 'critical', expected: expectedSemantic, actual: canonical.semanticSha256 });
    if (shadowRecord.valid && shadow.status === 'FAILED') contradictions.push({ type: 'SHADOW_LAWS_TOTAL_FAILURE', severity: 'critical' });
    if (hologram.status === 'ALIEN') contradictions.push({ type: 'HOLOGRAM_ALIEN', severity: 'high' });
    if (ancestry && ancestry.sameWorldSha256 === false && ancestry.commonAncestor == null) contradictions.push({ type: 'NO_DEFENSIBLE_LINEAGE_CONNECTION', severity: 'high' });

    score = Math.max(0, Math.min(100, score));
    let verdict = 'AMBIGUOUS';
    if (exactSemantic && shadow.status === 'SATISFIED' && hologram.status === 'IDENTICAL_SHADOW' && archiveCheck.valid && federation.valid) verdict = 'EXACT';
    else if (contradictions.some(x => x.severity === 'critical')) verdict = 'REJECTED';
    else if (score >= 80 && shadow.status === 'SATISFIED' && hologram.confidence >= 90) verdict = 'STRONGLY_CORROBORATED';
    else if (score < 45) verdict = 'REJECTED';

    const record = {
      format: 'JSONDB-RECOVERY-JURY-1',
      id: `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
      at: now(), candidateSource: candidate.source, archiveId: archive.id,
      verdict, confidence: score,
      expectedSemanticSha256: expectedSemantic,
      candidateSemanticSha256: canonical.semanticSha256 || null,
      evidence, contradictions, ancestry,
      doctrine: 'The Recovery Jury may reject, corroborate, or identify an exact candidate. It cannot promote candidate state into the canonical database.'
    };
    record.juryHash = digest(record);
    record.attestation = await this.k.cryptoCouncil.attest(record.juryHash, {
      purpose: 'recovery-jury', juryId: record.id, verdict, archiveId: archive.id
    });
    await atomicJson(path.join(this.cases, `${record.id}.json`), record);
    await atomicJson(path.join(this.root, 'latest.json'), record);
    return record;
  }

  async verify(id = null) {
    await this.init();
    const record = id ? await readJson(path.join(this.cases, `${id}.json`), null) : await readJson(path.join(this.root, 'latest.json'), null);
    if (!record) return { valid: false, status: 'ABSENT' };
    const copy = { ...record }; delete copy.juryHash; delete copy.attestation;
    const actual = digest(copy);
    const attestation = record.attestation?.id ? await this.k.cryptoCouncil.verify(record.attestation.id).catch(error => ({ valid: false, error: error.message })) : { valid: false, error: 'missing attestation' };
    return {
      valid: actual === record.juryHash && attestation.valid === true && attestation.worldRoot === record.juryHash,
      id: record.id, verdict: record.verdict, confidence: record.confidence,
      expectedJuryHash: record.juryHash, actualJuryHash: actual,
      attestation
    };
  }
}

module.exports = { RecoveryJury };
