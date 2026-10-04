'use strict';

const path = require('path');
const crypto = require('crypto');
const { now, ensureDir, atomicJson, readJson, hashFile, listFilesRecursive, merkleRoot } = require('./jsonfs');

function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

class RosettaCapsule {
  constructor({ savior, polyhash = null }) {
    this.savior = savior;
    this.polyhash = polyhash;
    this.root = path.join(savior.root, 'rosetta-capsules');
    this.capsules = path.join(this.root, 'capsules');
  }

  async init() { await ensureDir(this.capsules); }

  spec() {
    return {
      format: 'JSONDB-ROSETTA-SPEC-2',
      purpose: 'Language-agnostic reconstruction and authority notes for JSONDB survival formats. This file is documentation encoded as JSON, not executable authority.',
      globalRules: [
        'All integer byte values are unsigned 0..255 unless stated otherwise.',
        'All SHA-256 digests are lowercase hexadecimal unless a format explicitly says base64.',
        'Never repair the only surviving copy in place. Decode into a sandbox first.',
        'If independent decoders disagree, preserve every result and stop. Do not guess a winner.',
        'Unknown format versions must be treated as unknown rather than silently coerced.',
        'Recovery evidence may reduce uncertainty; it never grants automatic promotion authority.',
        'A mechanism that reconstructs bytes should not be its own sole corroborator.',
        'Machine evidence may nominate a candidate; human threshold authority remains separate.'
      ],
      canonicalJson: {
        name: 'Canonical semantic JSON used by several evidence systems',
        rules: [
          'Objects: sort keys lexicographically, recursively canonicalize values.',
          'Arrays: preserve order unless the specific format states rows are sorted by id.',
          'Numbers/strings/booleans/null: serialize as ordinary JSON values.',
          'UTF-8 encode the final JSON text before hashing.'
        ]
      },
      quaternary: {
        format: 'JSONDB-QUATERNARY-COLD-1',
        alphabet: ['A','C','G','T'],
        mapping: { '00':'A', '01':'C', '10':'G', '11':'T' },
        encodeByte: [
          'Read one byte b.',
          'Extract two-bit groups from most significant to least significant: (b>>6)&3, (b>>4)&3, (b>>2)&3, b&3.',
          'Map 0,1,2,3 to A,C,G,T respectively.',
          'Therefore each input byte becomes exactly four symbols.'
        ],
        decodeByte: [
          'Map A,C,G,T back to 0,1,2,3.',
          'For symbols q0,q1,q2,q3 compute byte=(q0<<6)|(q1<<4)|(q2<<2)|q3.'
        ],
        interleaving: {
          formula: 'output[(i * stride) mod N] = input[i]',
          strideRule: 'Choose an odd stride near floor(N*0.61803398875), at least 3, increment by 2 until gcd(stride,N)=1. For N<=1 use stride=1.',
          inverse: 'input[i] = output[(i * stride) mod N].'
        },
        parity: {
          rule: 'Within each group, parity[j] = XOR of dataOligo[k][j] for every oligo k in the group.',
          oneMissingRecovery: 'missing[j] = parity[j] XOR every surviving dataOligo[k][j] in the group.',
          limitation: 'One missing/corrupt data oligo per parity group.'
        },
        checksum: {
          crc32: 'IEEE CRC-32 reflected polynomial 0xEDB88320, initial 0xFFFFFFFF, final XOR 0xFFFFFFFF.',
          sha256: 'SHA-256 over decoded oligo bytes.'
        },
        knownVector: {
          inputUtf8: 'JSONDB',
          inputHex: '4a534f4e4442',
          encodedACGT: 'CAGGCCATCATTCATGCACACAAG',
          note: 'This vector covers only direct byte-to-quaternary mapping, before interleaving or parity.'
        }
      },
      xorArk: {
        format: 'JSONDB-XOR-ARK-1',
        rule: 'Split padded input into equal data shards. parity[j] = XOR(dataShard0[j], dataShard1[j], ...).',
        recovery: 'If exactly one shard is missing, XOR every surviving shard including parity to reconstruct the missing shard.',
        limitation: 'Exactly one lost/corrupt shard maximum.'
      },
      gf256: {
        field: 'GF(2^8)',
        primitivePolynomial: '0x11D',
        addition: 'bitwise XOR',
        multiplication: [
          'Build exponent/log tables from generator x=0x02 under polynomial 0x11D.',
          'For nonzero a,b: mul(a,b)=EXP[(LOG[a]+LOG[b]) mod 255]. Zero times anything is zero.'
        ],
        inverse: 'For nonzero a: inv(a)=EXP[255-LOG[a]].',
        temporalParity: {
          parity0: 'P0[j] = XOR of all epochShard[i][j].',
          parity1: 'P1[j] = XOR of mul(epochShard[i][j], EXP[(i+1) mod 255]).',
          twoMissing: [
            'After removing known shard contributions, let S0=A XOR B.',
            'Let S1=ca*A XOR cb*B where ca and cb are the two coefficients.',
            'A = (S1 XOR cb*S0) / (ca XOR cb).',
            'B = S0 XOR A.'
          ]
        }
      },
      spacetimeArk: {
        format: 'JSONDB-SPACETIME-ARK-1',
        geometry: 'Rows are historical OMEGA epochs split into spatial data columns. Each row has one XOR spatial-parity cell. Each column, including the row-parity column, has one XOR temporal-parity cell.',
        recovery: [
          'Mark missing or checksum-invalid cells as erasures.',
          'If a row contains exactly one erasure, reconstruct it as XOR of every other cell in that row.',
          'If a column contains exactly one erasure, reconstruct it as XOR of every other cell in that column.',
          'Repeat row and column peeling until no progress remains.',
          'Reassemble each epoch from its data columns and verify the epoch SHA-256.'
        ],
        limitation: 'Some cyclic multi-erasure patterns are not peelable. Recovered epoch artifacts remain sandbox evidence.'
      },
      timeWeave: {
        format: 'JSONDB-TIME-WEAVE-NODE-1',
        rule: 'Node at position p anchors prior positions p-1, p-2, p-4, p-8, ... while distance <= p.',
        purpose: 'Long-range continuity proof and tamper fan-out. It is not state recovery by itself.'
      },
      semanticDeltaFossils: {
        format: 'JSONDB-SEMANTIC-DELTA-FOSSIL-2',
        purpose: 'Bidirectional row-aware semantic transitions between two content-addressed Memory Palace worlds.',
        changes: [
          'root: complete before/after catalog or meta value',
          'table: complete before/after table for table creation or deletion',
          'table-meta: before/after table metadata',
          'row: before/after row keyed by stable id'
        ],
        forward: 'Apply each change.after to the ancestor endpoint.',
        inverse: 'Apply each change.before to the descendant endpoint.',
        verification: 'Forward reconstruction must equal the descendant world and inverse reconstruction must equal the ancestor world.'
      },
      semanticHologram: {
        format: 'JSONDB-SEMANTIC-HOLOGRAM-1',
        warning: 'Lossy corroboration only; never sufficient to reconstruct full rows.',
        components: ['row counts','field/type profiles','ID-set root','row-hash XOR','seeded bucket sketches','exact semantic root where available']
      },
      shadowLaws: {
        format: 'JSONDB-SHADOW-LAWS-1',
        prime: '2^61-1',
        rule: 'For each law and row, derive a coefficient with HMAC-SHA256(lawSeed, collection || lawIndex || rowId), map it into the prime field, multiply by a SHA-256-derived row fingerprint, and sum modulo the prime.',
        purpose: 'Randomized post-state semantic challenge. It corroborates a candidate and does not reconstruct it.',
        authority: 'The law record itself is dual-family attested. Satisfying the laws alone never authorizes promotion.'
      },
      forwardWitness: {
        format: 'JSONDB-FORWARD-WITNESS-1',
        rule: 'Each epoch signs its subject hash, previous attestation hash, current public-key fingerprint, and commitment to the next public-key fingerprint using a one-epoch Ed25519 identity.',
        ratchet: 'After signing, the precommitted next key becomes current and a new future key is generated. The old private key is omitted from active state.',
        caveat: 'Removing old private material from JSON state is not proof of physical secure erase from the filesystem.'
      },
      recoveryContracts: {
        format: 'JSONDB-RECOVERY-CONTRACTS-1',
        purpose: 'Machine-readable architecture authority: what each subsystem reconstructs, corroborates, depends on, may auto-repair, may nominate, or may authorize.',
        invariant: 'Every contract has mayPromoteCanonical=false. Corroborative systems should not reconstruct candidate state.',
        analysis: 'Contract analysis detects authority-shape drift such as an automatic promoter or a corroborator that unexpectedly becomes reconstructive.'
      },
      recoveryGeometry: {
        format: 'JSONDB-RECOVERY-GEOMETRY-1',
        purpose: 'Counterfactual survivability map over named capabilities and explicit alternative recovery paths.',
        rule: 'A disaster scenario survives when at least one complete capability path remains available after requested removals.',
        warning: 'Coverage is a scenario/path coverage metric, not a probability of durability.'
      },
      recoveryNavigator: {
        format: 'JSONDB-RECOVERY-NAVIGATOR-1',
        purpose: 'Plan-only selection of one reconstructive source plus independent non-reconstructive corroborators under Recovery Contracts and Recovery Geometry.',
        phases: ['preserve evidence','reconstruct sandbox','canonicalize candidate','independent corroboration','Recovery Jury','Jury Promotion Gate','human threshold ceremony','manual promotion boundary'],
        authority: 'Navigator never executes recovery into canonical state and never performs automatic promotion.'
      },
      recoveryJury: {
        format: 'JSONDB-RECOVERY-JURY-1',
        verdicts: ['EXACT','STRONGLY_CORROBORATED','AMBIGUOUS','REJECTED'],
        purpose: 'Attested machine adjudication of a persistent sandbox candidate against exact semantic identity, Hologram, Shadow Laws, Last Savior evidence, and Federation lineage.',
        authority: 'May nominate an eligible candidate; cannot promote.'
      },
      promotionBoundary: {
        juryGate: 'Only an EXACT or STRONGLY_CORROBORATED verified Jury case may open the promotion proposal.',
        humanThreshold: 'Existing promotion ceremony requires threshold operator signatures.',
        execution: 'The recovery stack intentionally has no automatic canonical-promotion action.'
      },
      evidenceDiaspora: {
        format: 'JSONDB-EVIDENCE-DIASPORA-PLACEMENT-1',
        rule: 'Prefer copies on a new expected location AND new device key, then a new device key, then correlated overflow.',
        warning: 'OS device identifiers are evidence of independence, not proof of independent hardware, controller, power, operator, or site.'
      },
      hashPolyglot: {
        purpose: 'Hash agility and common-mode reduction.',
        expectedFamilies: ['sha256','sha512','sha3-256','blake2b512 when runtime supports it'],
        rule: 'Unavailable algorithms are distinct from algorithms that compute a contradictory digest.'
      },
      failureSemantics: {
        decoderDisagreement: 'STOP_AND_PRESERVE_ALL',
        unknownVersion: 'READ_ONLY_FORENSIC',
        insufficientQuorum: 'UNRESOLVED_NOT_GUESSED',
        corruptOnlyCopy: 'PRESERVE_BEFORE_ATTEMPTING_REPAIR',
        recoveredCandidate: 'SANDBOX_ONLY_UNTIL_OPERATOR_PROMOTION',
        contractViolation: 'BLOCK_NAVIGATED_PROMOTION_PATH',
        ambiguousHistory: 'PRESERVE_ALL_DEFENSIBLE_LINEAGES'
      }
    };
  }

  examples() {
    const zero = Buffer.from([0x00]);
    const ff = Buffer.from([0xff]);
    const j = Buffer.from('J','utf8');
    return {
      format: 'JSONDB-ROSETTA-VECTORS-2',
      vectors: [
        { name:'byte-zero', inputHex:'00', sha256:sha256Hex(zero), quaternary:'AAAA' },
        { name:'byte-ff', inputHex:'ff', sha256:sha256Hex(ff), quaternary:'TTTT' },
        { name:'ascii-J', inputUtf8:'J', inputHex:'4a', sha256:sha256Hex(j), quaternary:'CAGG' },
        { name:'ascii-JSONDB', inputUtf8:'JSONDB', inputHex:'4a534f4e4442', sha256:sha256Hex(Buffer.from('JSONDB')), quaternary:'CAGGCCATCATTCATGCACACAAG' }
      ],
      interpretation: 'These are deterministic known-answer examples for independent reimplementations. They are documentation artifacts, not a runtime test suite.'
    };
  }

  async create(label = 'rosetta') {
    await this.init();
    const id = `${Date.now()}-${String(label).replace(/[^A-Za-z0-9_.-]/g,'_')}`;
    const dir = path.join(this.capsules, id);
    await ensureDir(dir);
    const spec = this.spec();
    const examples = this.examples();
    await atomicJson(path.join(dir,'ROSETTA-SPEC.json'), spec);
    await atomicJson(path.join(dir,'KNOWN-VECTORS.json'), examples);
    await atomicJson(path.join(dir,'BOOTSTRAP.json'), {
      format:'JSONDB-ROSETTA-BOOTSTRAP-2', createdAt:now(),
      order:[
        'Read ROSETTA-SPEC.json as ordinary UTF-8 JSON.',
        'Implement only the decoder required by the surviving artifact.',
        'Confirm the tiny known vectors before interpreting precious recovery media.',
        'Read Recovery Contracts before deciding whether the artifact reconstructs data, only corroborates it, or carries authority evidence.',
        'Decode into new files; never overwrite sole surviving artifacts.',
        'Cross-check reconstructed state with a non-reconstructive semantic or cryptographic subsystem.',
        'Send persistent candidates through Recovery Jury before any human promotion ceremony.',
        'If evidence contradicts, preserve ambiguity and stop.'
      ],
      minimalAssumptions:['ability to read UTF-8','ability to parse JSON','ability to perform byte XOR','ability to compute SHA-256 for strong verification']
    });
    const files = await listFilesRecursive(dir);
    const entries=[];
    for(const file of files)entries.push({path:path.relative(dir,file).split(path.sep).join('/'),sha256:await hashFile(file)});
    entries.sort((a,b)=>a.path.localeCompare(b.path));
    const manifest={format:'JSONDB-ROSETTA-CAPSULE-2',id,label,createdAt:now(),entries,merkleRoot:merkleRoot(entries.map(x=>x.sha256))};
    if(this.polyhash)manifest.polyhash=await this.polyhash.envelope(manifest,{purpose:'rosetta-capsule'});
    await atomicJson(path.join(dir,'MANIFEST.json'),manifest);
    await atomicJson(path.join(this.root,'latest.json'),{id,directory:dir,merkleRoot:manifest.merkleRoot,createdAt:manifest.createdAt});
    return{id,directory:dir,merkleRoot:manifest.merkleRoot,files:entries.length+1};
  }

  async verify(id=null,options={}){
    const readOnly=options.readOnly===true;
    if(!readOnly)await this.init();
    if(!id)id=(await readJson(path.join(this.root,'latest.json'),null))?.id;
    if(!id)return{valid:false,status:'ABSENT',readOnly};
    const dir=path.join(this.capsules,id),manifest=await readJson(path.join(dir,'MANIFEST.json'),null);
    if(!manifest)return{valid:false,status:'MISSING_MANIFEST',readOnly,id};
    const results=[];
    for(const entry of manifest.entries||[]){try{const actual=await hashFile(path.join(dir,entry.path));results.push({path:entry.path,valid:actual===entry.sha256,expected:entry.sha256,actual});}catch(error){results.push({path:entry.path,valid:false,error:error.message});}}
    const root=merkleRoot((manifest.entries||[]).map(x=>x.sha256));
    let polyhash=null;
    if(this.polyhash&&manifest.polyhash){const copy={...manifest};delete copy.polyhash;polyhash=await this.polyhash.verify(copy,manifest.polyhash,{readOnly});}
    return{format:'JSONDB-ROSETTA-VERIFY-3',valid:results.every(x=>x.valid)&&root===manifest.merkleRoot&&(!polyhash||polyhash.valid),readOnly,id,computedMerkleRoot:root,expectedMerkleRoot:manifest.merkleRoot,results,polyhash};
  }
}

module.exports={RosettaCapsule};