# Forge Breakout Corner

A tiny public playground for experiments that do **not** need to belong to a production lane.

Current experiments:

- **Breakout Console** — a local-first, dependency-free browser workspace for capturing ideas, generating weird build prompts, and keeping one small focus target in view.
- **Chaos Deck** — three-card constraint roulette for generating a mission, a constraint, and one unnecessary curse. Lock the parts you like, reroll the rest, then throw the result toward the Breakout Console before good judgment returns.
- **JSONDB Lab** — a basic CRUD stack deliberately overcomplicated into a tiny JSON database engine with a WAL, undo-journal transactions, atomic writes, generated indexes, query planning, snapshots and crash recovery. No npm. No framework. No account. Persistent state is JSON/JSONL.

## Run the browser-only toys

Open either file directly in a browser:

- `index.html` — Breakout Console
- `chaos-deck.html` — Chaos Deck

No install, build step, account, backend, or network connection is required.

## Run JSONDB Lab

JSONDB Lab uses only Node's built-in modules and needs no package install:

```bash
cd jsondb-lab
node server.js
```

Then open:

```text
http://127.0.0.1:7331
```

Its database is created locally under `jsondb-lab/data/` and is intentionally ignored by Git.

## Principles

- playful over precious
- local-first
- zero third-party dependencies
- one-file experiments are welcome
- ridiculous engineering experiments are also welcome
- break things here, not in production

## Breakout Console features

- scratchpad saved in `localStorage`
- one-line focus target
- randomized project prompts
- lightweight session clock
- export notes as a text file
- reset everything locally

## Chaos Deck features

- independently lockable Mission / Constraint / Curse cards
- keyboard shortcuts for rolling and locking
- last eight rolls saved locally
- copy the current mission as plain text
- best-effort handoff to the Breakout Console scratchpad when both pages share the same browser origin
- no network calls, packages, or backend state

### Tiny browser caveat

Browsers do not guarantee that two separately opened `file://` pages share the same `localStorage` bucket. If your browser isolates them, **Copy mission** is the reliable zero-server handoff. If both files are served from the same origin, the **Throw into scratchpad** action can share the Breakout Console's local storage normally.

## JSONDB Lab features

The joke starts as `read JSON → modify → write JSON` and escalates into:

- serialized writes inside one Node process
- collection catalog
- UUID primary keys
- unique constraints
- REST-ish CRUD API
- batch transactions
- undo-journal rollback
- startup recovery for abandoned transactions
- write-ahead log in JSONL
- temp-file + fsync + rename table replacement
- generated secondary indexes for scalar fields
- indexed equality queries
- scan-based comparison/contains queries
- sort / offset / limit
- query-plan reporting
- snapshots
- browser database console
- runtime data kept entirely local

See `jsondb-lab/README.md` for the architecture and API.

Made in the spirit of a breakout corner: useful enough to keep, disposable enough to mutate.
