'use strict';

const { now } = require('./jsonfs');

const DEFAULT_DOMAINS = {
  'physical-storage': {
    weight: 22,
    channels: ['storage-canary','truth-lattice']
  },
  'history-lineage': {
    weight: 22,
    channels: ['temporal-chain','semantic-chronicle','cross-history-braid']
  },
  'independent-attestation': {
    weight: 16,
    channels: ['signed-witness-council']
  },
  'semantic-behavior': {
    weight: 14,
    channels: ['semantic-immune-system']
  },
  'recovery-codecs': {
    weight: 20,
    channels: ['orthogonal-archive','trinity-decoder-quorum']
  },
  'bootstrap-survivability': {
    weight: 6,
    channels: ['survivor-genome']
  }
};

function normalizedEvidence(item) {
  if (!item || !Number(item.possible)) return 0;
  return Math.max(0, Math.min(1, Number(item.awarded || 0) / Number(item.possible)));
}

function diminishingCombine(scores) {
  const sorted = [...scores].sort((a,b)=>b-a);
  if (!sorted.length) return { confidence: 0, raw: [], formula: [] };
  const multipliers = [1, .35, .15, .08, .04];
  let earned = 0;
  let possible = 0;
  const formula = [];
  sorted.forEach((score, i) => {
    const multiplier = multipliers[i] ?? .02;
    earned += score * multiplier;
    possible += multiplier;
    formula.push({ score, multiplier, contribution: score * multiplier });
  });
  return { confidence: possible ? earned / possible : 0, raw: sorted, formula };
}

class FailureDomainTrustBudget {
  constructor(domains = DEFAULT_DOMAINS) {
    this.domains = domains;
  }

  evaluate(oracleAssessment) {
    const evidence = oracleAssessment?.evidence || [];
    const byChannel = new Map(evidence.map(x => [x.channel, x]));
    const results = [];
    let weighted = 0;
    let totalWeight = 0;
    let coveredWeight = 0;

    for (const [name, config] of Object.entries(this.domains)) {
      const members = config.channels.map(channel => byChannel.get(channel)).filter(Boolean);
      const scores = members.map(normalizedEvidence);
      const combined = diminishingCombine(scores);
      const weight = Number(config.weight || 0);
      const covered = members.length > 0;
      totalWeight += weight;
      if (covered) coveredWeight += weight;
      weighted += combined.confidence * weight;
      results.push({
        domain: name, weight, covered,
        confidence: Math.round(combined.confidence * 100),
        channels: members.map(x => ({ channel: x.channel, score: Math.round(normalizedEvidence(x) * 100), ok: x.ok })),
        diminishingFormula: combined.formula
      });
    }

    const base = totalWeight ? Math.round(weighted / totalWeight * 100) : 0;
    const coverage = totalWeight ? Math.round(coveredWeight / totalWeight * 100) : 0;
    const activeDomains = results.filter(x => x.covered).length;
    const healthyDomains = results.filter(x => x.covered && x.confidence >= 70).length;
    const weakestCovered = results.filter(x => x.covered).sort((a,b)=>a.confidence-b.confidence)[0] || null;
    const diversityBonus = activeDomains >= 5 ? 8 : activeDomains >= 4 ? 4 : 0;
    const concentrationPenalty = activeDomains <= 2 ? 25 : activeDomains === 3 ? 12 : 0;
    const weakDomainPenalty = weakestCovered && weakestCovered.confidence < 35 ? Math.round((35 - weakestCovered.confidence) * .45) : 0;
    const contradictionPenalty = Math.min(60, (oracleAssessment?.contradictions || []).reduce((sum, x) => sum + Math.min(20, Number(x.penalty || 0) * .4), 0));
    const adjusted = Math.max(0, Math.min(100, base + diversityBonus - concentrationPenalty - weakDomainPenalty - contradictionPenalty));

    let verdict = 'INSUFFICIENT_DIVERSITY';
    if ((oracleAssessment?.verdict === 'PANIC') || contradictionPenalty >= 30) verdict = 'UNTRUSTED';
    else if (adjusted >= 85 && activeDomains >= 5 && healthyDomains >= 4) verdict = 'DIVERSE_TRUST';
    else if (adjusted >= 65 && activeDomains >= 4) verdict = 'DIVERSE_DEGRADED';
    else if (adjusted >= 45) verdict = 'NARROW_TRUST';

    return {
      format: 'JSONDB-FAILURE-DOMAIN-TRUST-BUDGET-1', at: now(),
      verdict,
      independenceAdjustedConfidence: adjusted,
      naiveOracleConfidence: oracleAssessment?.confidence ?? null,
      baseDomainWeightedConfidence: base,
      coverage,
      activeDomains, healthyDomains,
      diversityBonus, concentrationPenalty, weakDomainPenalty, contradictionPenalty,
      weakestCoveredDomain: weakestCovered ? { domain: weakestCovered.domain, confidence: weakestCovered.confidence } : null,
      domains: results,
      doctrine: 'Multiple observations inside one failure domain receive diminishing credit. Trust increases primarily when different failure domains agree.'
    };
  }
}

module.exports = { FailureDomainTrustBudget, DEFAULT_DOMAINS, diminishingCombine };
