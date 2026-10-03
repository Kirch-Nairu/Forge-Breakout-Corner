# JSONDB MONSTER MODE

> The goal was to complicate a basic stack while refusing a real database.
>
> We succeeded too hard.

Monster Mode is a zero-package, zero-framework local database architecture experiment built entirely with Node.js platform modules and persistent **JSON / JSONL** files.

It is not production guidance. It is a database engineering playground whose main constraint is: **if a mature database normally provides it, try building a ridiculous JSON-shaped version of it.**

## Run the main control plane

```bash
cd jsondb-lab
node monster-server.js
```

Open:

```text
http://127.0.0.1:7332
```

SQL crime lab:

```text
http://127.0.0.1:7332/sql.html
```

No `npm install`. There is no `package.json`. Runtime state is generated in `monster-data/` and ignored by Git.

---

# What exists now

```text
Browser control plane
│
├── JSON query AST
├── SQL-ish compiler
├── EXPLAIN-ish planner output
└── transaction console
        │
        ▼
HTTP control plane (Node built-ins)
        │
        ├── leader gate
        ├── lock manager
        │   ├── table / row resource locks
        │   ├── wait-for graph
        │   └── deadlock detection
        ├── before triggers
        └── transaction coordinator
                │
                ▼
Canonical JSON row engine
├── atomic temp + fsync + rename
├── undo manifests
├── JSONL WAL + LSN
├── mutation/version history
├── MVCC-ish AS OF transaction reads
├── unique constraints
├── foreign keys
├── secondary indexes
├── composite indexes
├── checkpoints + WAL rotation
├── mutation segments + compaction
├── snapshots
├── materialized views
├── CDC feed
├── SHA-256 Merkle-ish integrity manifest
└── crash rollback recovery
```

And then we refused to stop.

---

# Query stack

## JSON AST

```json
{
  "from": "tasks",
  "where": {
    "and": [
      {"field":"status","op":"eq","value":"active"},
      {"field":"priority","op":"gte","value":5}
    ]
  },
  "select": ["id","title","priority"],
  "orderBy": [{"field":"priority","direction":"desc"}],
  "limit": 50
}
```

Supported ideas include:

- boolean `and` / `or` / `not`
- `eq`, `ne`, `gt`, `gte`, `lt`, `lte`
- `contains`, `startsWith`, `endsWith`, regex
- projection
- sorting
- grouping
- `count`, `sum`, `avg`, `min`, `max`
- `HAVING`-style filtering
- hash joins
- pagination
- historical `asOf` transaction reads

## SQL-ish compiler

```bash
node monster-cli.js sql "SELECT id, title, priority FROM tasks WHERE status = 'active' AND priority >= 5 ORDER BY priority DESC LIMIT 20"
```

Or POST to `/api/sql`.

This compiles familiar-ish SELECT syntax into the same JSON AST. It is deliberately not complete SQL.

## Cost optimizer

```bash
node optimizer-cli.js analyze tasks
node optimizer-cli.js plan-sql "SELECT * FROM tasks WHERE status = 'active' LIMIT 20"
```

`ANALYZE` writes JSON statistics:

- row count
- null count
- distinct count
- selectivity
- top values
- numeric min/max
- small histograms

The optimizer uses those statistics to estimate predicate cardinality and reorder join build sides.

---

# Index zoo

## Ordinary JSON indexes

Configured secondary/composite indexes map encoded keys to row IDs.

## Bloom filters

```bash
node monster-cli.js bloom-build tasks slug 32768 7
node monster-cli.js bloom-test tasks slug past-the-limit
```

The response intentionally distinguishes:

```text
DEFINITELY ABSENT
```

from:

```text
MAYBE PRESENT
```

because Bloom filters are allowed to lie positively.

## Persistent B+ tree-ish pages

```bash
node monster-cli.js btree-build tasks priority 32
node monster-cli.js btree-range tasks priority 5 999 100
```

The tree is bulk-built into individual JSON page files with:

- internal pages
- separator keys
- child page IDs
- linked leaves
- configurable fanout
- page-read reporting

It is educational and immutable between rebuilds, not a production B+ tree.

## Full-text inverted index

```bash
node monster-cli.js fts-build tasks task_text title slug
node monster-cli.js fts-search tasks task_text "json database"
```

Stores JSON postings and ranks results with a BM25-ish formula.

## Approximate vector graph

Rows can carry arrays such as:

```json
{"embedding":[0.11,0.42,0.87]}
```

Then:

```bash
node vector-cli.js build vectors demo embedding 8
node vector-cli.js search vectors demo '[0.1,0.4,0.9]' 10 64
```

The persisted index is a single-layer HNSW-ish nearest-neighbor graph. A brute-force cosine baseline also exists.

## Spatial index

```bash
node spatial-cli.js build places geo lat lon 100
node spatial-cli.js bbox places geo 9.5 123.7 10.5 124.2
node spatial-cli.js nearest places geo 10.0 124.0 10
```

Uses uniform spatial cells for candidate selection and Haversine distance for nearest-result ranking.

---

# More than one storage engine, because why not

## Slotted page / buffer pool experiment

```bash
node page-cli.js rebuild tasks
node page-cli.js status tasks
node page-cli.js scan tasks 100
node page-cli.js inspect tasks <page-id>
node page-cli.js tombstone tasks <row-id>
node page-cli.js vacuum tasks
```

This derived heap representation has:

- configurable logical page size
- slots
- per-page checksums
- free-space estimates
- tombstones
- pin/unpin
- dirty pages
- LRU-ish eviction
- buffer pool hit/miss metrics
- flush
- VACUUM rebuild

Yes, the database pages themselves are JSON.

## Column store experiment

```bash
node columnar-cli.js build bench status office score
node columnar-cli.js filter bench status active
node columnar-cli.js aggregate bench score avg status active
```

The column representation includes:

- per-field column files
- dictionary encoding
- null bitmaps
- low-cardinality bitmap indexes
- vector-ish scans
- aggregates

So this one folder now contains both row-store and column-store experiments.

---

# Graph model

```bash
node graph-cli.js node Office '{"code":"ENG"}'
node graph-cli.js edge <from> <to> REPORTS_TO
node graph-cli.js path <from> <to>
node graph-cli.js pagerank 30
```

Graph state contains:

- JSON nodes
- JSON edges
- adjacency indexes
- directional neighbor lookup
- BFS traversal
- shortest path
- PageRank-ish iteration
- import from canonical row collections

At this point JSONDB is a multi-model database having an identity crisis.

---

# Transactions, history and recovery

Canonical writes go through:

```text
leader check
→ acquire redundant lock resources
→ wait-for graph / deadlock check
→ apply before triggers
→ create undo manifest
→ WAL BEGIN
→ mutate working database image
→ validate unique + FK constraints
→ atomic table writes
→ rebuild indexes
→ append mutation version records
→ append mutation segments
→ WAL MUTATION records
→ WAL COMMIT
→ remove undo manifest
→ release locks
```

On crash, leftover prepared undo manifests are restored during boot.

Historical state can be reconstructed by replaying per-collection mutation histories up to transaction `N`.

## PITR

```bash
node pitr-cli.js restore 42
node pitr-cli.js diff 20 42 tasks
node pitr-cli.js list
```

PITR creates an isolated restore sandbox from historical mutation logs. It never silently promotes restored state into the live database.

---

# Advanced database rituals

## ANALYZE

Persists statistics used by the toy cost optimizer.

## Prepared statements

The HTTP API can persist parameterized JSON query ASTs and execute them with `$parameter` substitution.

## Triggers

Before-write trigger definitions are themselves JSON. Current actions include setting a field and rejecting a mutation.

## Migrations

Declarative migrations support collection creation, catalog alteration, and batched backfills. Applied migrations record a checksum; changing an already-applied migration produces checksum drift instead of silently pretending everything is fine.

## Materialized views

Persist query results as JSON view files and refresh them on demand.

## Backup

Backups copy canonical data/index/history state and produce file SHA-256 values plus a Merkle root.

## WAL tamper seal

```bash
node causality-cli.js seal-wal
node causality-cli.js verify-wal
```

This rewrites the current WAL into a separate hash-chained seal:

```text
hash[n] = SHA256(hash[n-1] || canonical_event[n])
```

Again: experiment, not a cryptographic audit product.

---

# Replication and cluster theater

The main Monster server simulates:

```text
node-primary
node-replica-a
node-replica-b
```

Followers consume the CDC/WAL stream and receive JSON copies of canonical state.

Cluster metadata tracks:

- term
- leader
- online state
- applied LSN
- heartbeats
- election history
- quorum

You can trigger failover and promotion in the control plane.

It literally records this disclaimer:

> Simulated consensus theater. This is not Raft.

Good architecture experiments should know what they are not.

---

# A second distributed database hiding inside the first database

Because one replication model was apparently insufficient:

```bash
node distributed-cli.js topology
node distributed-cli.js route some-key
node distributed-cli.js 2pc-demo
node distributed-cli.js scan distributed_demo
node distributed-cli.js mapreduce distributed_demo office count
```

This subsystem uses:

- rendezvous hashing
- multiple logical JSON shards
- per-shard tables
- coordinator manifests
- per-shard prepare manifests
- two-phase commit
- commit/abort decisions
- 2PC crash recovery
- scatter/gather scan
- map/reduce aggregation

So the repository contains both replicated canonical storage and a separate sharded-storage experiment.

There was no requirement to do this.

---

# Offline causality / CRDT lab

```bash
node causality-cli.js crdt-conflict-demo
```

Or manually:

```bash
node causality-cli.js crdt-set laptop-a notes note-1 text '"edit from A"'
node causality-cli.js crdt-set laptop-b notes note-1 text '"edit from B"'
node causality-cli.js crdt-merge laptop-a laptop-b
node causality-cli.js crdt-read laptop-a notes
```

The lab uses:

- hybrid logical clocks
- per-field last-writer-wins registers
- deterministic node-ID tie break
- tombstones
- offline state per node
- merge/materialize operations

So JSON has causality now. Sorry.

---

# Main HTTP endpoints

Selected endpoints:

```text
GET  /api/status
GET  /api/catalog
GET  /api/locks
GET  /api/wal
GET  /api/cdc

POST /api/query
POST /api/sql
POST /api/tx
POST /api/collections
PATCH /api/collections/:name

POST /api/checkpoint
POST /api/compact
POST /api/snapshot
POST /api/integrity

POST /api/analyze
POST /api/bloom/build
POST /api/bloom/test
POST /api/partitions/build

POST /api/prepared/:name
POST /api/prepared/:name/execute
POST /api/triggers
POST /api/migrations
POST /api/backup
POST /api/restore-sandbox

POST /api/cluster/replicate
POST /api/cluster/elect
POST /api/cluster/failover
POST /api/cluster/promote-local
POST /api/benchmark/seed
```

---

# Data universe

Runtime eventually looks roughly like:

```text
monster-data/
├── catalog.json
├── meta.json
├── wal.jsonl
├── current/
├── indexes/
├── versions/
├── segments/
├── tx/
├── checkpoints/
├── snapshots/
├── views/
├── integrity/
├── cluster/
│   └── replicas/
├── distributed/
│   ├── shards/
│   ├── coordinator-tx/
│   └── coordinator.jsonl
└── advanced/
    ├── stats/
    ├── bloom/
    ├── partitions/
    ├── btree/
    ├── fulltext/
    ├── pages/
    ├── columnar/
    ├── vector/
    ├── spatial/
    ├── graph/
    ├── ledger/
    ├── crdt/
    ├── pitr/
    ├── backups/
    └── restore-sandboxes/
```

All ignored by Git.

---

# What this experiment now teaches

The original question was:

> How far can JSON go as the only database?

The increasingly accurate answer is:

> As far as the storage engine around it is willing to go.

JSON does not give us transactions, indexes, query planning, locking, recovery, replication, causality, pages, vector search, graph traversal, column encoding, or distributed commit.

But nothing stops us from building those systems **around JSON as the persistent representation**.

At this stage JSON is no longer the important part.

The experiment is really a tour through why databases are complicated.

And why SQLite is a miracle.
