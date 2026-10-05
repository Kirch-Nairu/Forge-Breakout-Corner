# KIRION Software Factory — POTATO-16 Bootstrap

Status: **STAGED / EXPERIMENTAL / NOT PRODUCTION AUTHORITY**

This directory is the first executable bootstrap for the KIRION Software Factory concept. It deliberately starts with a constrained local runtime rather than an autonomous repo-mutating agent.

## What this stage actually implements

- POTATO-16 compute profile (single inference, RAM admission gates, CPU-first assumptions)
- local controller on `127.0.0.1:7340`
- local worker on `127.0.0.1:7350`
- llama.cpp/OpenAI-compatible local model adapter on `127.0.0.1:8080/v1`
- adaptive discovery contract with JSON-schema constrained outputs
- persistent episode store with crash-resumable JSON state
- KIRION lifecycle state machine
- explicit role/capability authority boundary
- source-SHA-pinned bounded work-package contract
- explicit human write authorization gate
- real Git detached-worktree isolation primitive
- browser control surface for session → discovery → targeted questions → work-package proposal → authorization
- cross-platform self-test including a real temporary Git worktree isolation test

## What this stage intentionally does **not** do

It does not yet let the model patch files, execute arbitrary shell commands, integrate candidates, promote releases, or deploy. Those capabilities must be added behind Forge authority and evidence gates rather than exposed as generic model tools.

## Model target

Initial target:

```text
Qwen2.5-Coder-3B-Instruct
GGUF Q4_K_M
4096 context
one inference at a time
```

KIRION does not start llama.cpp in this stage. Run the local model server separately, for example:

```powershell
llama serve -hf bartowski/Qwen2.5-Coder-3B-Instruct-GGUF:Q4_K_M --ctx-size 4096 --threads 4 --host 127.0.0.1 --port 8080
```

The current llama.cpp WinGet package can be installed with:

```powershell
winget install --id ggml.llamacpp -e
```

## Run

No third-party Node packages are required.

Terminal 1:

```text
cd kirion-factory
node ./bin/kirion.js worker
```

Terminal 2:

```text
cd kirion-factory
node ./bin/kirion.js control
```

Open:

```text
http://127.0.0.1:7340
```

Profile hardware without starting either service:

```text
node ./bin/kirion.js profile
```

Self-test:

```text
npm test
```

## LAN worker mode

The bootstrap defaults to loopback only. To expose the worker to another trusted machine, set both a non-loopback host and a token:

```text
KIRION_WORKER_HOST=0.0.0.0
KIRION_WORKER_TOKEN=<random-long-token>
```

The LLM endpoint remains loopback-only by default. KIRION refuses a remote LLM URL unless `KIRION_ALLOW_REMOTE_LLM=1` is explicitly set.

## Authority invariant

```text
MODEL PROPOSES
FORGE AUTHORIZES
RUNNER EXECUTES
STATE PERSISTS
OBSERVATION VERIFIES
```

The bootstrap already rejects write authority unless the user sends the explicit `X-Kirion-Human-Intent: AUTHORIZE_IMPLEMENTATION` intent and the exact source SHA matches both repository evidence and the proposed work package.

## Next implementation lane

The next lane is the controlled execution kernel:

1. context-capsule/retrieval builder
2. Code Writer action schema
3. bounded patch application inside the isolated worktree
4. allowlisted check runner
5. failure normalization + REWORK loop
6. independent Reviewer context
7. evidence bundle + candidate SHA
8. OMEGA event projection

No direct `main` mutation and no generic shell endpoint.
