# KIRION Qwen Dossier + Codex Handoff Experiment

Status: **EXPERIMENTAL / SEPARATE BRANCH / NOT CANONICAL FORGE AUTHORITY**

This lane tests a narrower idea than the autonomous execution kernel: use a small local Qwen model as an adaptive requirements interviewer, then turn the resolved answers into a structured Markdown implementation dossier and a bounded Codex handoff.

## What makes this different from the closed-world mock

The question bank is finite and inspectable, but **Qwen chooses the next question dynamically** from currently active candidates based on the project goal and previous answers. Conditional questions activate only when prior answers make them relevant.

Qwen does not get filesystem or shell authority. Python owns session state, question activation, target-path safety, Markdown writes, and the final handoff guardrails.

## Flow

```text
project objective + target directory + optional source repo
        ↓
Qwen selects highest-value active question
        ↓
user answers
        ↓
conditional question graph changes
        ↓
Qwen selects next question
        ↓
repeat until no active question remains
        ↓
explicit FINALIZE confirmation
        ↓
Qwen synthesizes implementation documents
        ↓
Python writes bounded dossier tree
        ↓
08_HANDOFF/CODEX_HANDOFF.md
```

## Generated dossier

The target directory must be new or empty. KIRION writes:

```text
00_PROJECT_INDEX.md
01_PRODUCT/
  PRODUCT_REQUIREMENTS.md
  USERS_ROLES_WORKFLOWS.md
  SCOPE_ACCEPTANCE.md
02_UX/
  UX_INFORMATION_ARCHITECTURE.md
03_ARCHITECTURE/
  SYSTEM_ARCHITECTURE.md
  DATA_AND_STATE.md
  INTEGRATIONS_API.md
04_SECURITY/
  SECURITY_MODEL.md
05_QUALITY/
  TEST_AND_ACCEPTANCE.md
06_OPERATIONS/
  DEPLOYMENT.md
  OBSERVABILITY_RECOVERY.md
07_DELIVERY/
  IMPLEMENTATION_PLAN.md
  WORK_PACKAGES.md
08_HANDOFF/
  REVIEW_CHECKLIST.md
  CODEX_HANDOFF.md
SESSION.json
MANIFEST.json
```

The Codex handoff instructs the implementation agent to re-verify the source SHA, work in an isolated candidate branch/worktree, obey the dossier, run required validation, avoid direct `main` mutation, avoid self-promotion/deployment, and stop at `FOR REVIEW` with evidence.

## Model

Default:

```text
bartowski/Qwen2.5-Coder-3B-Instruct-GGUF:Q4_K_M
4096 context
CPU-first
127.0.0.1:8080/v1
```

## Windows one-shot launch

From this directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-Qwen-Dossier.ps1
```

The launcher:

1. runs the deterministic selftest;
2. installs `ggml.llamacpp` with WinGet when llama.cpp is absent;
3. launches Qwen with `--n-gpu-layers 0`;
4. waits for the first model download/load to complete;
5. starts the dossier service on `127.0.0.1:7361`;
6. opens the browser UI.

If the first download is slow, leave the terminal open. The service is not started until Qwen reports healthy.

## Selftest

No model or network is required:

```text
python selftest.py
```

The selftest covers session creation, conditional activation, required-question skip rejection, Codex handoff invariants, and refusal to write into a non-empty target directory.

## Boundaries

This experiment intentionally does **not** give Qwen arbitrary filesystem writes, shell execution, Git mutation, merge, promotion, or deployment powers.

Python may create the explicitly supplied dossier target only after the questionnaire is complete and the user explicitly confirms finalization. Existing non-empty target directories are refused.
