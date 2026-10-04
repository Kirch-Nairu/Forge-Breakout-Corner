'use strict';

const path = require('path');
const { now, ensureDir, readJson, atomicJson } = require('./jsonfs');

class JuryPromotionGate {
  constructor({ savior, jury, promotion, firewall = null }) {
    this.savior = savior;
    this.jury = jury;
    this.promotion = promotion;
    this.firewall = firewall;
    this.root = path.join(savior.root, 'jury-promotion-gate');
    this.warrants = path.join(this.root, 'warrants');
  }

  async init() { await ensureDir(this.warrants); }

  async open(juryId = null, options = {}) {
    await this.init();
    const juryRecord = juryId
      ? await readJson(path.join(this.jury.cases, `${juryId}.json`), null)
      : await readJson(path.join(this.jury.root, 'latest.json'), null);
    if (!juryRecord) throw new Error('Jury Promotion Gate requires a Recovery Jury case.');
    const verified = await this.jury.verify(juryRecord.id);
    if (!verified.valid) throw new Error('Recovery Jury record failed verification.');
    if (!['EXACT','STRONGLY_CORROBORATED'].includes(juryRecord.verdict)) {
      throw new Error(`Recovery Jury verdict ${juryRecord.verdict} is insufficient to open a promotion ceremony.`);
    }
    if (!juryRecord.candidateSource || juryRecord.candidateSource === 'in-memory') {
      throw new Error('Promotion Gate requires the Jury candidate to be a persistent sandbox file.');
    }

    const authorityDecision = this.firewall
      ? await this.firewall.assert('jury-promotion-gate', 'OPEN_PROMOTION_CEREMONY', {
          juryId: juryRecord.id,
          verdict: juryRecord.verdict,
          confidence: juryRecord.confidence,
          candidateSource: juryRecord.candidateSource
        })
      : null;

    const proposal = await this.promotion.propose({
      sandboxFile: juryRecord.candidateSource,
      expiresMinutes: Number(options.expiresMinutes || 60),
      target: options.target || 'canonical-world',
      evidence: {
        source: 'JuryPromotionGate',
        juryId: juryRecord.id,
        juryHash: juryRecord.juryHash,
        juryVerdict: juryRecord.verdict,
        juryConfidence: juryRecord.confidence,
        lastSaviorArchiveId: juryRecord.archiveId,
        candidateSemanticSha256: juryRecord.candidateSemanticSha256,
        expectedSemanticSha256: juryRecord.expectedSemanticSha256,
        authorityFirewallDecisionHash: authorityDecision?.decisionHash || null,
        authorityFirewallSequence: authorityDecision?.sequence || null
      }
    });

    const warrant = {
      format: 'JSONDB-JURY-PROMOTION-WARRANT-2',
      id: `warrant-${proposal.id}`,
      createdAt: now(),
      jury: { id: juryRecord.id, verdict: juryRecord.verdict, confidence: juryRecord.confidence, juryHash: juryRecord.juryHash },
      authorityFirewall: authorityDecision ? { sequence: authorityDecision.sequence, decisionHash: authorityDecision.decisionHash, allowed: authorityDecision.allowed, reason: authorityDecision.reason } : null,
      proposal: { id: proposal.id, statementHash: proposal.statementHash, sandboxSha256: proposal.statement.sandboxSha256 },
      doctrine: 'Machine evidence may nominate a sandbox. Authority Firewall must permit opening the ceremony. Human threshold approval remains separate. This warrant executes nothing.'
    };
    await atomicJson(path.join(this.warrants, `${warrant.id}.json`), warrant);
    await atomicJson(path.join(this.root, 'latest.json'), warrant);
    return { warrant, proposal };
  }

  async verify(warrantId = null) {
    await this.init();
    const warrant = warrantId
      ? await readJson(path.join(this.warrants, `${warrantId}.json`), null)
      : await readJson(path.join(this.root, 'latest.json'), null);
    if (!warrant) return { valid: false, status: 'ABSENT' };
    const jury = await this.jury.verify(warrant.jury.id).catch(error => ({ valid: false, error: error.message }));
    const proposal = await this.promotion.verify(warrant.proposal.id).catch(error => ({ authorized: false, error: error.message }));
    const firewall = this.firewall ? await this.firewall.verifyLedger().catch(error => ({ valid: false, error: error.message })) : null;
    const firewallSafe = !warrant.authorityFirewall || Boolean(warrant.authorityFirewall.allowed && firewall?.valid);
    return {
      valid: jury.valid === true && warrant.jury.juryHash === jury.expectedJuryHash && firewallSafe,
      warrantId: warrant.id,
      jury,
      authorityFirewall: { warrant: warrant.authorityFirewall, ledger: firewall },
      promotion: proposal,
      status: proposal.authorized ? 'HUMAN_THRESHOLD_AUTHORIZED' : 'AWAITING_OR_INVALID_APPROVALS',
      doctrine: 'The gate can open a ceremony but cannot execute canonical promotion.'
    };
  }
}

module.exports = { JuryPromotionGate };
