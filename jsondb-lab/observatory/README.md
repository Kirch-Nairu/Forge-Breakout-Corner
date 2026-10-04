# OMEGA OBSERVATORY

Local-first, read-only visual observability for JSONDB MONSTER.

## Authority contract

OMEGA OBSERVATORY is an observer, not an operator.

It may:

- read explicitly allowlisted JSONDB engine and Savior artifacts;
- compute ephemeral presentation summaries in memory;
- watch approved local storage roots for filesystem changes;
- publish normalized observation events over localhost HTTP/SSE;
- animate those events in the browser.

It must not:

- mutate canonical JSONDB state;
- append or rewrite WAL;
- rebuild or modify indexes;
- repair recovery evidence;
- change Savior mode;
- invoke Recovery Jury or promotion execution;
- handle operator private keys;
- expose arbitrary host filesystem paths;
- execute arbitrary shell commands;
- treat a replay animation as proof that an internal algorithm physically executed in that exact visual order.

## Runtime boundary

The server binds to `127.0.0.1` by default and exposes only GET/HEAD routes.

```text
node jsondb-lab/observatory/server.js
```

Then open:

```text
http://127.0.0.1:7331
```

Optional environment variables:

```text
OBSERVATORY_HOST=127.0.0.1
OBSERVATORY_PORT=7331
OBSERVATORY_SCAN_MS=750
```

No framework. No package manager. No CDN. Node built-ins + HTML/CSS/vanilla JavaScript only.

## V1 routes

```text
GET /api/health
GET /api/snapshot
GET /api/events       # text/event-stream
```

`/api/snapshot` reads only known engine/recovery artifacts. Missing artifacts are represented as absent, not created.

`/api/events` emits normalized observation events. Filesystem changes are evidence that bytes changed on an approved surface; higher-level labels are observational classifications and do not grant authority.

## Visual truth modes

The UI distinguishes:

- **LIVE** — driven by observed filesystem/state changes.
- **REPLAY / EXPLAIN** — browser-only educational animation from already-read history.

The first vertical slice implements LIVE observation only.

## Owned scope

```text
jsondb-lab/observatory/**
```

Existing MONSTER engine, recovery, authority, CLI, and CI semantics remain frozen unless a later bounded lane explicitly changes them.
