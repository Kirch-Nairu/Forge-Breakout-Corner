'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, atomicJson, readJson } = require('./jsonfs');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

const CONSTITUTION = {
  version: 1,
  classes: {
    derived: {
      automatic: ['REBUILD','DELETE_AND_REBUILD'],
      examples: ['indexes/','views/','advanced/stats/','advanced/bloom/','advanced/columnar/','advanced/vector/','advanced/spatial/','advanced/graph/'],
      doctrine: 'Derived artifacts may be destroyed and regenerated from canonical state.'
    },
    redundant: {
      automatic: ['REPAIR_FROM_HASH_VERIFIED_COPY'],
      examples: ['advanced/savior/quorum/mirrors/','advanced/savior/memory-palace/objects/','advanced/savior/memory-palace/vaults/'],
      doctrine: 'Redundant bytes may auto-heal only from a copy that independently matches the expected content hash.'
    },
    canonical: {
      automatic: [],
      examples: ['current/','catalog.json','meta.json'],
      doctrine: 'Canonical state may be reconstructed automatically only into a sandbox. Promotion requires explicit operator action.'
    },
    history: {
      automatic: ['APPEND_ONLY'],
      examples: ['wal.jsonl','versions/','segments/','semantic-chronicle/','cross-history-braid/'],
      doctrine: 'History is evidence. Never silently rewrite it to make the present look healthy.'
    },
    trustRoot: {
      automatic: [],
      examples: ['witness-council/keys/','witness-council/council.json','SURVIVOR-GENOME.json'],
      doctrine: 'Trust roots are never regenerated merely because verification failed.'
    },
    recoveryMetadata: {
      automatic: [],
      examples: ['trinity-ark/manifests/','orthogonal/','ark/archives/','genome/'],
      doctrine: 'Recovery metadata may be copied from verified replicas but never invented from desired outcomes.'
    }
  }
};

class RepairConstitution {
  constructor(engine, savior) {
    this.engine = engine;
    this.savior = savior;
    this.root = path.join(savior.root, 'repair-constitution');
    this.file = path.join(this.root, 'constitution.json');
    this.proposals = path.join(this.root, 'proposals');
  }

  async init() {
    await ensureDir(this.proposals);
    const pinned = await readJson(this.file, null);
    const constitutionHash = digest(CONSTITUTION);
    if (!pinned) await atomicJson(this.file, { format: 'JSONDB-REPAIR-CONSTITUTION-1', createdAt: now(), constitutionHash, constitution: CONSTITUTION });
    return { constitutionHash, constitution: CONSTITUTION };
  }

  classify(target) {
    const rel = String(target || '').replace(/\\/g,'/').replace(/^\/+/, '');
    if (/^(indexes|views)\//.test(rel) || /^advanced\/(stats|bloom|columnar|vector|spatial|graph)\//.test(rel)) return 'derived';
    if (/^advanced\/savior\/quorum\/mirrors\//.test(rel) || /^advanced\/savior\/memory-palace\/(objects|vaults)\//.test(rel)) return 'redundant';
    if (/^(current\/|catalog\.json$|meta\.json$)/.test(rel)) return 'canonical';
    if (/^(wal\.jsonl$|versions\/|segments\/)/.test(rel) || /semantic-chronicle\//.test(rel) || /cross-history-braid\//.test(rel)) return 'history';
    if (/witness-council\/keys\//.test(rel) || /witness-council\/council\.json$/.test(rel) || /SURVIVOR-GENOME\.json$/.test(rel)) return 'trustRoot';
    if (/trinity-ark\/manifests\//.test(rel) || /\/ark\/archives\//.test(rel) || /\/genome\//.test(rel) || /\/orthogonal\//.test(rel)) return 'recoveryMetadata';
    return 'unknown';
  }

  authorize({ action, target, destination = null, evidence = {} }) {
    const artifactClass = this.classify(target);
    const rule = CONSTITUTION.classes[artifactClass];
    const normalizedAction = String(action || '').toUpperCase();
    let allowed = false;
    let mode = 'DENY';
    let reason = rule?.doctrine || 'Unknown artifacts default to manual review.';

    if (artifactClass === 'derived' && rule.automatic.includes(normalizedAction)) { allowed = true; mode = 'AUTO'; }
    else if (artifactClass === 'redundant' && normalizedAction === 'REPAIR_FROM_HASH_VERIFIED_COPY' && evidence.expectedHash && evidence.sourceHash === evidence.expectedHash) { allowed = true; mode = 'AUTO'; }
    else if (artifactClass === 'canonical' && normalizedAction === 'RECONSTRUCT_SANDBOX' && destination && /restore-sandboxes|fractal-recovery|pitr/i.test(destination)) { allowed = true; mode = 'SANDBOX_ONLY'; }
    else if (artifactClass === 'history' && normalizedAction === 'APPEND_ONLY') { allowed = true; mode = 'APPEND_ONLY'; }

    return {
      format: 'JSONDB-REPAIR-AUTHORIZATION-1', at: now(),
      allowed, mode, action: normalizedAction, target, destination,
      artifactClass, evidence, reason,
      constitutionHash: digest(CONSTITUTION)
    };
  }

  async propose(spec = {}) {
    await this.init();
    const authorization = this.authorize(spec);
    const id = `${Date.now()}-${crypto.randomUUID().slice(0,8)}`;
    const proposal = {
      format: 'JSONDB-REPAIR-PROPOSAL-1', id, createdAt: now(),
      requested: spec,
      authorization,
      state: authorization.allowed ? 'AUTHORIZED_NOT_EXECUTED' : 'OPERATOR_REVIEW_REQUIRED',
      evidenceFingerprint: digest(spec.evidence || {}),
      warning: 'Authorization describes policy only. It is not proof that source data is correct and it does not promote sandbox data into canonical state.'
    };
    proposal.proposalHash = digest(proposal);
    await atomicJson(path.join(this.proposals, `${id}.json`), proposal);
    await atomicJson(path.join(this.root, 'latest-proposal.json'), proposal);
    return proposal;
  }

  async verifyProposal(id) {
    const proposal = await readJson(path.join(this.proposals, `${id}.json`), null);
    if (!proposal) return { valid: false, reason: 'proposal not found' };
    const copy = { ...proposal }; delete copy.proposalHash;
    const actual = digest(copy);
    return { valid: actual === proposal.proposalHash, expected: proposal.proposalHash, actual, proposal };
  }
}

module.exports = { RepairConstitution, CONSTITUTION, digest };
