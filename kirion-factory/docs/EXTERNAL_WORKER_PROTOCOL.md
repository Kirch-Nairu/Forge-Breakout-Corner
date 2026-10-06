# KIRION Forge External Worker Protocol

Status: **EXPERIMENTAL / STAGED / NO AUTHORITY TRANSFER**

This lane nests external AI systems under Forge as workers rather than allowing any model or provider to become the authority plane.

## Invariant

```text
HUMAN / PROJECT AUTHORITY
        ↓
KIRION FORGE
        ↓
bounded worker packet
        ↓
LOCAL QWEN / GOOGLE AI STUDIO / KIMI / FUTURE PROVIDER
        ↓
candidate + claims + evidence
        ↓
FORGE RE-VERIFICATION
        ↓
REVIEW / REWORK / ACCEPTANCE
```

A provider is replaceable. Forge authority is not.

## Worker classes

### local-llama

Existing localhost llama.cpp worker. Useful for cheap local inference.

### google-ai-studio

Human-mediated bridge for Google AI Studio / Gemini experiments.

Forge emits a bounded packet and a deterministic prompt. The human may paste it into AI Studio and return the result or a generated candidate repository.

AI Studio may implement, review, or analyze within the assigned role, but it cannot self-accept or self-promote its output.

### kimi-forge

External Kimi worker/candidate lane. A Kimi-generated repository is treated as a candidate produced by an untrusted external worker. Repository state and evidence must be independently inspected by Forge.

## Why this exists

The worker may be excellent at implementation and still be wrong about:

- what repository state actually exists
- whether a test really ran
- whether a browser path is production-safe
- whether a backend is real or simulated
- whether a candidate is authorized
- whether a deployment happened
- whether acceptance belongs to the worker

Forge therefore owns authority, verification and lifecycle state.

## Worker packet

Each packet contains:

- protocol version
- worker/provider identity
- episode ID
- assigned Forge role
- source repository and exact source SHA
- objective
- bounded work package
- owned scope
- prohibited scope
- context artifacts
- explicit authority limits
- result/evidence contract

The packet never grants:

- acceptance
- integration
- promotion
- deployment

## Worker result

External workers return a structured result with:

- status
- exact claimed source SHA
- summary
- changed files
- executed checks
- evidence strings/artifacts
- unresolved items
- candidate repository/branch/SHA when applicable
- handoff

The result is a **claim set**, not truth.

Forge must compare it against repository/runtime evidence before moving lifecycle state.

## Google AI Studio workflow

```text
Forge episode
→ create bounded work package
→ build google-ai-studio packet
→ render manual prompt
→ paste into AI Studio
→ AI Studio builds candidate
→ candidate exported/pushed to Git
→ Forge imports worker result
→ Forge audits exact repo/SHA
→ Reviewer disposition
→ REWORK or ACCEPTANCE lane
```

This lets Google AI act as a high-capability Forge worker without giving the browser product canonical repository or release authority.

## Kimi candidate workflow

```text
Kimi builds or edits candidate
→ candidate pushed to a dedicated repository/branch
→ Forge records source/candidate refs
→ audit code, architecture, tests and claims
→ preserve useful frontend/UX contracts
→ issue bounded rework package
→ external worker or local worker performs repair
→ exact candidate is revalidated
```

## Evidence rule

A worker saying `PASS` is not enough.

Forge should classify evidence as:

- TESTED
- OBSERVED
- DURABLE
- UNVERIFIED

Claims such as "backup/restore passed", "MFA active", "immutable audit", or "production-ready" require the corresponding real evidence, not documentation text.

## Chain-of-thought

Do not request or persist private chain-of-thought.

Persist explicit artifacts instead:

- observation
- hypothesis
- plan
- evidence
- action
- result
- critique
- decision
- confidence

## Future automated transports

The same packet/result contract can later be carried by:

- Gemini API
- Kimi API/CLI
- OpenAI-compatible endpoints
- Codex
- another local model
- remote isolated workers

Transport changes. Authority does not.
