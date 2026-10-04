# Forge Breakout Corner

A public playground for experiments that do **not** need to belong to a production lane.

Current experiments:

- **Breakout Console** — local-first scratch space for ideas and small focus targets.
- **Chaos Deck** — Mission / Constraint / Curse roulette for generating questionable build prompts.
- **JSONDB Lab** — started as JSON CRUD and accidentally became a database-engine course.
- **JSONDB Monster Mode** — the point where we stopped asking whether any of this was sensible.
- **JSONDB Savior Mode** — assume JSON is the last database format on Earth and make recovery distrust absolutely everything.

## Browser-only toys

Open directly:

- `index.html` — Breakout Console
- `chaos-deck.html` — Chaos Deck

No install, build step, account, backend, or network connection required.

## JSONDB baseline

```bash
cd jsondb-lab
node server.js
```

```text
http://127.0.0.1:7331
```

The baseline engine has JSON tables, atomic writes, a JSONL WAL, undo transactions, generated indexes, query-plan reporting, snapshots and crash rollback.

## JSONDB MONSTER MODE

```bash
cd jsondb-lab
node monster-server.js
```

```text
http://127.0.0.1:7332
```

SQL crime lab:

```text
http://127.0.0.1:7332/sql.html
```

Monster Mode escalates into:

- WAL + LSNs
- MVCC-ish transaction-time history
- `AS OF` reads
- unique constraints + foreign keys
- secondary/composite indexes
- checkpoints + WAL rotation
- mutation segments + compaction
- CDC
- materialized views
- lock table + wait-for graph + deadlock detection
- JSON query AST
- SQL-ish compiler
- ANALYZE statistics + histograms
- cost-ish optimizer + join reordering
- hash joins + aggregates
- Bloom filters
- persistent JSON B+ tree-ish pages
- BM25-ish full-text inverted index
- slotted heap pages + LRU buffer pool + VACUUM
- JSON column store + dictionary encoding + bitmap indexes
- approximate vector graph search
- graph model + traversal + shortest path + PageRank-ish scoring
- spatial grid index + Haversine nearest search
- prepared statements
- triggers
- checksum-pinned migrations
- SHA-256 Merkle-ish integrity reports
- hash-chained WAL seal
- backup + restore sandboxes
- point-in-time recovery by transaction
- simulated leader/follower replication
- election/failover theater
- a second rendezvous-hashed sharded JSON store
- two-phase commit across JSON shards
- scatter/gather + map/reduce
- hybrid logical clocks
- offline CRDT-ish merge

At this point the persistent format is still JSON, but **we are the database now**.

Full architecture and commands: [`jsondb-lab/MONSTER.md`](jsondb-lab/MONSTER.md).

## JSONDB SAVIOR MODE

```bash
cd jsondb-lab
node savior-server.js
```

```text
http://127.0.0.1:7334
```

Savior Mode assumes the database itself, its replicas, its manifests and even its recovery code can become untrustworthy.

It adds:

- write circuit breaker: `read-write` / `read-only` / `panic`
- storage-path canaries
- five-cell mirror quorum
- quarantine-before-repair
- hash-chained Temporal Quorum history
- semantic-vs-physical Truth Lattice
- Ed25519 5-of-7 witness council
- semantic JSON Immune System
- XOR recovery ARK
- dependency-free 6+3 GF(256) Reed–Solomon-style ARK
- classical surface-code-inspired 2-D parity lattice
- Trinity 2-of-3 independent decoder quorum
- orthogonal dual-code recovery
- manifestless self-describing air-gap packets
- inferred catalog reconstruction sandboxes
- doomsday capsules
- Survivor Genome carrying recovery source inside JSON
- standalone `lifeboat.js` with no JSONDB module imports
- quantum-inspired speculative candidate worlds with triple deterministic execution
- isolated Extinction / Black-Swan fault drills
- Fractal Quorum: file → row → field recovery
- metamorphic query verification: optimized engine vs independent full-scan/nested-loop interpreter
- Survival Oracle that combines evidence and may automatically reduce authority but never reopen writes

Full doctrine: [`jsondb-lab/SAVIOR.md`](jsondb-lab/SAVIOR.md).

## Operator CLIs

Monster:

```text
monster-cli.js       canonical engine / indexes / maintenance
optimizer-cli.js     ANALYZE + cost planner
page-cli.js          slotted pages / buffer pool / vacuum
columnar-cli.js      column store / bitmap indexes
vector-cli.js        vector graph search
spatial-cli.js       spatial lookup
graph-cli.js         graph model
pitr-cli.js          point-in-time recovery
distributed-cli.js   sharding / 2PC / map-reduce
causality-cli.js     HLC / CRDT / WAL tamper seal
```

Savior:

```text
savior-cli.js        mirrors / Guardian / capsule / quantum worldlines
oracle-cli.js        signed witnesses / immune scan / Oracle enforcement
packet-cli.js        self-describing air-gap packet sets
doomsday-cli.js      Trinity / Genome / Fractal / metamorphic recovery tools
lifeboat.js          standalone archive decoder with no engine imports
```

## Principles

- playful over precious
- local-first
- zero third-party dependencies
- one-file experiments are welcome
- ridiculous multi-engine experiments are also welcome
- recovery must be allowed to say **I do not know**
- automation may reduce authority, never silently increase it
- break things here, not in production

Runtime databases live under `jsondb-lab/data/` and `jsondb-lab/monster-data/`; both are intentionally ignored by Git.

Made in the spirit of a breakout corner: useful enough to keep, disposable enough to mutate.
