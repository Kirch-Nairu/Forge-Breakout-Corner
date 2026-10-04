# JSONDB SAVIOR MODE

> Assume JSON is the only persistent data format humanity has left.
>
> Now design like every disk, replica, manifest, process and recovery tool can fail independently.

SAVIOR Mode is the deliberately unreasonable disaster-recovery layer above JSONDB Monster Mode.

It is still a local engineering experiment. It is **not production database guidance**, not a cryptographic backup appliance, not real Byzantine consensus, and not quantum computing.

The useful part of the joke is the recovery doctrine: never let a single checksum, replica, decoder, manifest, health report or automated process become the sole authority for declaring data trustworthy.

---

## Run

```bash
cd jsondb-lab
node savior-server.js
```

Open:

```text
http://127.0.0.1:7334
```

Headless tools:

```bash
node savior-cli.js status
node oracle-cli.js assess
node packet-cli.js scan
```

Standalone recovery, with no JSONDB module imports:

```bash
node lifeboat.js ./monster-data/advanced/savior ./rescued-world.json
```

Runtime state remains under `monster-data/` and is ignored by Git.

---

# Doctrine

SAVIOR follows these rules:

1. **Never fabricate truth.** If recovery evidence is insufficient, return `UNKNOWN`, `LOST`, `FROZEN` or `PANIC`.
2. **Recovery and trust are different.** Successfully reconstructing bytes does not automatically authorize new writes.
3. **Automation may reduce authority, never increase it.** Guardian/Oracle may enter read-only or panic automatically. They may not automatically reopen writes.
4. **Quarantine before repair.** Divergent copies are preserved before replacement when practical.
5. **No single manifest is sacred.** Air-gap packets carry enough coding metadata to recover without a central manifest.
6. **No single decoder is sacred.** Independent coding algorithms cross-check one another.
7. **No single present-time majority is sacred.** Temporal Quorum can use previously witnessed healthy epochs when the current mirror set is split.
8. **No single byte hash is sacred.** Truth Lattice distinguishes physical-byte disagreement from logical JSON-semantic disagreement.
9. **No syntactically valid row is automatically sane.** The Immune System looks for semantic drift.
10. **Fault injection stays disposable.** Extinction drills destroy copies, never canonical tables.
11. **Restores prefer sandboxes.** Promotion back into canonical state is intentionally not a casual button.
12. **Recovery tooling is data too.** Survivor Genome stores decoder source and recovery metadata inside the survival universe.

---

# Layer 0 — Canonical Monster Engine

SAVIOR sits above the existing Monster stack:

```text
canonical JSON tables
+ WAL / LSN
+ undo manifests
+ MVCC-ish history
+ indexes
+ checkpoints
+ compaction
+ PITR
+ replication experiments
+ sharding / 2PC experiments
+ CRDT lab
+ multi-model indexes
```

SAVIOR does not replace those ideas. It assumes they may fail.

---

# Layer 1 — Circuit breaker

Savior state has three authority modes:

```text
read-write
read-only
panic
```

Protected writes call `assertWritable()` first.

The circuit breaker can be automatically tightened by Guardian/Oracle, but automatic health recovery does not reopen it.

This is intentional asymmetry:

```text
healthy → suspicious
can happen automatically

suspicious → healthy-authorized
requires operator intent
```

---

# Layer 2 — Storage canary

The canary performs a tiny write/read/hash/delete cycle in the Savior data path.

It does not prove the disk is globally healthy.

It only proves that one fresh write can round-trip through the storage path without immediately changing bytes.

That is one evidence channel, not truth.

---

# Layer 3 — Five-cell mirror quorum

Critical files are copied into five independent logical mirror cells:

```text
cell-01
cell-02
cell-03
cell-04
cell-05
```

Ordinary scrub uses majority-by-SHA-256.

With five cells:

```text
quorum = 3
```

Minority files are copied into quarantine before repair.

If no hash reaches quorum, scrub refuses to guess.

---

# Layer 4 — Temporal Quorum

Present-time majority can fail in a nasty way:

```text
cell 1 = GOOD
cell 2 = GOOD
cell 3 = random corruption A
cell 4 = random corruption B
cell 5 = random corruption C
```

No current value has 3 votes.

But previous healthy epochs may have repeatedly witnessed the GOOD hash.

Temporal Quorum stores a hash-chained sequence of world witnesses:

```text
epoch N
  prevHash
  worldRoot
  per-file SHA-256
  roundHash
```

When present quorum disappears, a historical hash can be considered only when:

- multiple current survivors still hold that hash; and
- multiple previous witnessed epochs support the same lineage.

This is a custom recovery heuristic, not a consensus protocol.

Its purpose is to distinguish:

```text
"the present is split"
```

from:

```text
"history gives us no trustworthy lineage"
```

The latter remains unrecoverable automatically.

---

# Layer 5 — Truth Lattice

Physical hashes answer:

> Are these bytes identical?

They do not answer:

> Do these files represent the same JSON state?

Truth Lattice records both:

```text
physical SHA-256
semantic canonical JSON SHA-256
present quorum
historical lineage
parse validity
```

Canonical semantic hashing recursively sorts object keys and treats row arrays with stable IDs as sets ordered by ID.

Therefore these can disagree physically:

```json
{"a":1,"b":2}
```

```json
{
  "b": 2,
  "a": 1
}
```

while remaining semantically equivalent.

Truth Lattice produces file confidence and a world verdict:

```text
TRUSTED
DEGRADED
FROZEN
UNKNOWN
```

No single weighted score can force a write gate open.

---

# Layer 6 — Cryptographic witness council

Seven local Ed25519 witness identities are generated as JSON key records.

Default threshold:

```text
5 of 7
```

Each witness signs a canonical world-root statement.

The council supports:

- signature verification
- duplicate-witness rejection
- key fingerprinting
- revocation
- council generation changes

Important limitation:

> These are software identities stored in the same experiment, not independent hardware security domains.

They provide another tamper-evidence channel; they do not create real-world Byzantine fault tolerance by themselves.

---

# Layer 7 — Semantic Immune System

A database can be logically corrupted while remaining perfectly valid JSON with perfectly updated checksums.

The Immune System learns a profile only when an operator explicitly declares a world trusted.

Profiles include:

- row counts
- field presence rates
- null rates
- observed types
- distinct ratios
- unique-like behavior
- numeric min/max/mean/p05/p95
- string length envelopes

Later scans look for:

```text
new unexpected types
field disappearance
large null-rate shifts
unique-looking keys losing uniqueness
row-count collapse/explosion
extreme numeric drift
extreme string-length drift
```

Verdicts:

```text
HEALTHY
SUSPICIOUS
SICK
HOSTILE
UNTRAINED
```

It never deletes or rewrites suspicious rows automatically.

---

# Layer 8 — XOR ARK

The original ARK splits a payload into data shards plus one XOR parity shard.

It can reconstruct exactly one lost/corrupt shard.

It is intentionally simple enough to audit mentally.

That simplicity is valuable as an independent recovery implementation.

---

# Layer 9 — GF(256) Reed–Solomon-style ARK

The second ARK implements dependency-free finite-field arithmetic:

```text
GF(256)
primitive polynomial 0x11d
Vandermonde matrix
systematic generator transformation
Gaussian matrix inversion
```

Default layout:

```text
6 data shards
3 parity shards
```

Any six valid shards can reconstruct the payload.

This implementation is educational, not a replacement for a mature erasure-code library.

---

# Layer 10 — Surface-code-inspired parity lattice

This is **classical**, not quantum error correction.

The inspiration is the idea of using multiple local parity checks as a syndrome.

A payload is arranged into a 2-D block grid:

```text
D00 D01 D02 D03 | row parity 0
D10 D11 D12 D13 | row parity 1
D20 D21 D22 D23 | row parity 2
D30 D31 D32 D33 | row parity 3
-----------------+
 C0  C1  C2  C3
```

Recovery repeatedly searches for:

```text
a row with exactly one unknown
or
a column with exactly one unknown
```

and reconstructs that block from parity.

Multiple erasures can be recovered when the missing-block graph is peelable.

Cycles may remain unrecoverable, which is reported instead of hidden.

---

# Layer 11 — Trinity decoder quorum

The same world can be encoded by three different implementations:

```text
XOR
Reed–Solomon GF(256)
2-D parity lattice
```

Recovery uses a decoder quorum:

```text
2 of 3 independent decoder families
must reconstruct the expected SHA-256 world
```

This is N-version recovery logic.

The point is to reduce common-mode implementation risk:

```text
one broken decoder
!=
one lost world
```

---

# Layer 12 — Orthogonal dual-code archive

Before Trinity existed, Orthogonal ARK used two independent families:

```text
XOR
+
Reed–Solomon
```

It remains useful because it has a stricter status language:

```text
STRONG
DEGRADED
DISAGREEMENT
LOST
```

Automatic restore is allowed only when both independent decoders agree on the expected world hash.

Degraded restore requires explicit operator override.

---

# Layer 13 — Self-describing air-gap packets

A central manifest can disappear.

Therefore removable-media packets each carry the full coding descriptor:

```text
set ID
logical name
K/M geometry
shard size
original byte count
original SHA-256
generator matrix
descriptor hash
packet index
packet SHA-256
base64 payload
```

Default set:

```text
9 packets total
6 required
```

Recovery scans an arbitrary directory, groups packets by matching set ID + descriptor hash, and attempts reconstruction.

The packet filenames and original folder structure are not required.

Conceptually:

```text
USB A → packets 0, 7
USB B → packet 2
printed optical archive → packet 8
old laptop → packets 1, 3, 5

six valid matching packets
→ reconstruct world
```

This is the most useful "manifestless" survival property in SAVIOR.

---

# Layer 14 — Doomsday Capsule

A capsule contains:

```text
canonical current tables
catalog
meta
WAL evidence
inferred catalog
file hashes
Merkle root
recovery instructions
```

The inferred catalog is intentionally advisory.

If the real catalog is gone, SAVIOR can recover field/type evidence from surviving rows, but it does not pretend it can safely infer every original unique constraint, foreign key or business rule.

---

# Layer 15 — Survivor Genome

Recovery code can disappear too.

The Genome stores plain JSON containing:

- `lifeboat.js` source
- erasure-code source
- Savior source
- orthogonal recovery source
- JSON filesystem primitives
- per-source SHA-256
- Merkle root of recovery sources
- public witness council material
- latest recovery manifest
- inferred catalog
- extraction instructions

The genome is copied into every mirror cell and beside the archive system.

This does not solve every bootstrap problem, but it means:

> surviving data carries source for its own recovery tools.

---

# Layer 16 — Standalone Lifeboat

`lifeboat.js` intentionally imports no JSONDB module.

It contains its own:

- JSON parsing
- SHA-256 verification
- GF(256) tables
- matrix inversion
- XOR decoder
- Reed–Solomon decoder

Usage:

```bash
node lifeboat.js <savior-root> <output-file>
```

Normal behavior:

```text
XOR reconstructs expected hash
AND
RS reconstructs expected hash
AND
both hashes agree
→ STRONG RECOVERY
```

If only one decoder survives:

```text
refuse
```

unless the operator explicitly supplies:

```text
--allow-degraded
```

---

# Layer 17 — Quantum-inspired worldlines

This is not quantum computing.

The useful idea is speculative state search.

A request provides several candidate transaction worlds:

```json
{
  "candidates": [
    {"name":"A","ops":[...]},
    {"name":"B","ops":[...]}
  ],
  "invariants": [...]
}
```

For every candidate:

```text
clone same base world
→ execute candidate independently three times
→ hash every resulting world
→ require 3/3 deterministic agreement
→ score invariants
```

Candidate worlds that produce execution divergence are rejected.

Surviving scores are converted into softmax values called "amplitudes" purely as a metaphor.

Collapse is deterministic:

```text
highest score
then stable world-hash tie break
```

Dry-run is the default conceptual mode.

Actual collapse still goes through Savior write authority.

---

# Layer 18 — Extinction Chamber

Fault injection is performed only against disposable copies.

Normal drill:

```text
capture world
→ encode parity archive
→ corrupt one shard
→ repair shard
→ create 5 mirrors
→ independently poison 2 mirrors
→ majority scrub
→ compare recovered world hash
```

Black-Swan drill intentionally exceeds ordinary mirror tolerance.

A correct result may be:

```text
UNRECOVERABLE
```

That is better than invented recovery.

---

# Layer 19 — Survival Oracle

The Oracle is the meta-controller.

Evidence channels currently include:

```text
storage canary                10
hash-chained temporal history 15
Ed25519 witness council       20
Truth Lattice                 30
semantic Immune System        15
orthogonal archive evidence   10
```

Contradictions can subtract confidence.

Oracle verdicts:

```text
SAFE
READ_ONLY
PANIC
UNKNOWN
```

Oracle enforcement may do:

```text
read-write → read-only
read-write → panic
read-only  → panic
```

but never:

```text
read-only → read-write automatically
panic     → read-write automatically
```

---

# Protected write protocol

A write through the Savior control plane is intentionally expensive:

```text
assert circuit breaker is read-write
→ temporal pre-witness
→ canonical Monster transaction
→ immediately refresh five mirror cells
→ if mirror refresh fails: freeze future writes
→ temporal post-witness
→ optionally create independent erasure archive at MAXIMUM survival level
```

This means a transaction can be committed while the post-commit survival step fails.

When that happens, Savior reports the ugly truth:

```text
transaction committed
survival replication failed
future writes frozen
```

It does not lie by returning a normal success.

---

# Operator tools

## Mission control

```bash
node savior-server.js
```

## Core CLI

```bash
node savior-cli.js status
node savior-cli.js guardian
node savior-cli.js witness
node savior-cli.js truth
node savior-cli.js capture
node savior-cli.js scrub
node savior-cli.js capsule
node savior-cli.js orthogonal-archive
node savior-cli.js orthogonal-verify
node savior-cli.js extinction
node savior-cli.js black-swan
```

## Oracle

```bash
node oracle-cli.js attest
node oracle-cli.js assess --verify-archives
node oracle-cli.js enforce --verify-archives
node oracle-cli.js immune-learn trusted-before-upgrade
node oracle-cli.js immune-scan
node oracle-cli.js council-verify
```

## Air-gap packets

```bash
node packet-cli.js create emergency-2026
node packet-cli.js scan
node packet-cli.js recover ./rescued.json
```

## Lifeboat

```bash
node lifeboat.js ./monster-data/advanced/savior ./rescued.json
```

---

# Failure matrix

| Failure | First response | Secondary evidence |
|---|---|---|
| One mirror corrupt | present quorum repair | quarantine copy |
| Multiple mirrors disagree uniquely | Temporal Quorum | Truth Lattice |
| Bytes differ but JSON means same thing | semantic quorum | normalize only by operator choice |
| One XOR shard corrupt | XOR reconstruct | world SHA-256 |
| Up to three RS shards lost | GF(256) reconstruct | world SHA-256 |
| Peelable 2-D erasure pattern | parity-lattice recovery | world SHA-256 |
| One decoder implementation broken | Trinity 2-of-3 | expected world hash |
| Central archive manifest lost | self-describing packet scan | descriptor hash |
| Catalog lost | inferred catalog sandbox | surviving rows |
| Recovery source lost | Survivor Genome | per-source hashes |
| Engine cannot boot | standalone Lifeboat | independent decoders |
| Current quorum poisoned | Temporal Quorum | signed history |
| Checksums valid but values insane | Immune System | operator review |
| Health channels contradict | Oracle PANIC | no automatic trust restoration |
| More corruption than redundancy supports | declare LOST/UNKNOWN | never fabricate |

---

# Where the "quantum" stops

Nothing here executes on quantum hardware.

Nothing implements Shor, Grover, quantum annealing, quantum key distribution or quantum error correction.

The experiment borrows words/mental models only where they inspire a classical mechanism:

```text
superposition → speculative candidate worlds
collapse      → deterministic winner commit
amplitude     → softmax score
syndrome      → row/column parity checks
many worlds   → parallel dry-run transaction candidates
```

Calling the implementation real quantum computing would be false.

Calling it absurdly overengineered JSON is completely accurate.

---

# Final idea

Monster Mode asked:

> How much database can we build around JSON?

Savior Mode asks a different question:

> If JSON were the last persistent format left, how many independent ways could we preserve, challenge, reconstruct, cross-check and refuse to lie about its state?

The answer is no longer "make more backups."

The answer is an evidence hierarchy:

```text
bytes
→ semantic state
→ present quorum
→ temporal lineage
→ signatures
→ learned invariants
→ independent erasure decoders
→ manifestless packets
→ source-carrying genome
→ standalone lifeboat
→ human authority
```

The final authority is still the human.
