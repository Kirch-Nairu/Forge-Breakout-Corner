# Forge Breakout Corner

A tiny public playground for experiments that do **not** need to belong to a production lane.

Current experiments:

- **Breakout Console** — a local-first, dependency-free browser workspace for capturing ideas, generating weird build prompts, and keeping one small focus target in view.
- **Chaos Deck** — three-card constraint roulette for generating a mission, a constraint, and one unnecessary curse. Lock the parts you like, reroll the rest, then throw the result toward the Breakout Console before good judgment returns.

## Run it

Open either file directly in a browser:

- `index.html` — Breakout Console
- `chaos-deck.html` — Chaos Deck

No install, build step, account, backend, or network connection is required.

## Principles

- playful over precious
- local-first
- zero dependencies
- one-file experiments are welcome
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

Made in the spirit of a breakout corner: useful enough to keep, disposable enough to mutate.
