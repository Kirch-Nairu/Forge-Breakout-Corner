# JSONDB Lab

> How far can we go if the only database is JSON?
>
> Apparently far enough to start accidentally writing a database engine.

This is a deliberately overengineered local-first experiment. It takes a basic CRUD stack and refuses SQLite/PostgreSQL entirely. Persistent state is ordinary JSON and JSONL files.

No framework. No package manager. No account. No external service. No dependency install.

## Run

Requires a reasonably modern Node.js runtime (18+ is a good target).

```bash
cd jsondb-lab
node server.js
```

Then open:

```text
http://127.0.0.1:7331
```

The server creates `data/` automatically on first boot.

## What the basic stack somehow became

```text
Browser admin console
        │
        ▼
Node built-in HTTP server
        │
        ▼
JSONDB engine
  ├── serialized write queue
  ├── transaction coordinator
  ├── unique constraints
  ├── query planner
  ├── JSON secondary indexes
  ├── undo journal
  ├── WAL (JSONL)
  ├── atomic temp-file writes
  ├── startup crash recovery
  └── snapshots
        │
        ▼
data/
  ├── catalog.json
  ├── tables/*.json
  ├── indexes/*.json
  ├── wal.jsonl
  ├── tx/*.json
  └── snapshots/*/*.json
```

## Durability model

Every normal table write uses:

```text
serialize write
→ write temporary JSON file
→ fsync temporary file
→ atomic rename over table
→ rebuild JSON indexes
```

A multi-operation transaction uses a deliberately tiny undo-journal protocol:

```text
BEGIN
  ↓
write tx/<uuid>.json containing before-images
  ↓
append BEGIN to wal.jsonl
  ↓
mutate in-memory working copies
  ↓
validate unique constraints
  ↓
atomically replace touched JSON tables
  ↓
append COMMIT
  ↓
delete undo manifest
```

If an operation throws, the before-images are written back and an `ABORT` goes into the WAL.

If the process dies while a transaction manifest still exists, startup recovery restores the before-images and writes `RECOVER_ROLLBACK` to the WAL.

This is not pretending to provide the same crash guarantees as a mature database engine. The joke is that we're implementing increasingly real database ideas while still refusing to stop calling JSON files the database.

## Query planner

Queries support:

- `eq`
- `ne`
- `contains`
- `gt`
- `gte`
- `lt`
- `lte`
- sorting
- offset/limit

Every top-level scalar field is indexed into a generated JSON index.

Example conceptual index:

```json
{
  "fields": {
    "status": {
      "string:\"active\"": [
        "8efc...",
        "f13a..."
      ]
    }
  }
}
```

An equality query can therefore report:

```text
planner: json-index · examined 3 · index status
```

instead of scanning every row.

Other operators currently use full scans because we are not yet insane enough to implement B-trees in JSON.

Yet.

## API

### Metadata

```http
GET /api/meta
GET /api/collections
GET /api/wal?limit=80
```

### Collections

```http
POST /api/collections
Content-Type: application/json

{
  "name": "incidents",
  "unique": ["slug"]
}
```

### Query

```http
GET /api/data/tasks?field=status&op=eq&value=active&sort=-priority&limit=50
```

### Insert

```http
POST /api/data/tasks
Content-Type: application/json

{
  "title": "Make JSON regret existing",
  "status": "active",
  "priority": 5
}
```

### Update

```http
PATCH /api/data/tasks/<uuid>
Content-Type: application/json

{
  "status": "done"
}
```

### Delete

```http
DELETE /api/data/tasks/<uuid>
```

### Transaction

```http
POST /api/tx
Content-Type: application/json

{
  "ops": [
    {
      "type": "insert",
      "collection": "tasks",
      "row": {"title":"A"}
    },
    {
      "type": "insert",
      "collection": "tasks",
      "row": {"title":"B"}
    }
  ]
}
```

### Snapshot

```http
POST /api/snapshot
```

## Current deliberate limitations

- one Node process should own the data directory;
- writers are serialized inside that process;
- there is no multi-process file locking;
- indexes are rebuilt on writes instead of incrementally maintained;
- transactions use rollback/undo semantics, not MVCC;
- no joins;
- no foreign keys;
- no schema typing beyond unique fields;
- no replication;
- no compaction/checkpointing of the WAL;
- no authentication because this is a localhost experiment;
- JSON tables are still rewritten as whole files.

In other words: extremely overbuilt for a toy, still nowhere near SQLite.

## Natural next crimes

If this experiment keeps escalating, the next layers are obvious:

```text
incremental indexes
→ append-only table segments
→ WAL checkpoints
→ optimistic row versions
→ MVCC snapshots
→ foreign keys
→ joins
→ query AST
→ cost-based index selection
→ replication
→ failover
```

At some point somebody is legally required to confiscate the keyboard.
