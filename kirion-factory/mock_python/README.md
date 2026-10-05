# KIRION Closed-World Python Mock Factory

Status: **SEPARATE EXPERIMENTAL BRANCH / NO LLM REQUIRED**

This lane proves a different idea from the POTATO-16 LLM bootstrap: KIRION can behave like a tiny deterministic software factory **without any model at all** when the problem is constrained to a finite design space.

## Core loop

```text
START SESSION
  ↓
CLOSED-ENDED QUESTION
  ↓
ANSWER ACTIVATES / SKIPS DEPENDENT QUESTIONS
  ↓
KNOWLEDGE CARDS + DERIVED CONTROLS
  ↓
DECISION READY
  ↓
PYTHON GENERATOR
  ↓
SPEC.md + TEST_PLAN.md + spec.json
  ↓
RUNNABLE HTML/CSS/JS MOCK APP
```

The current knowledge base contains 30 progressive questions, more than 100 finite options, conditional branches, reusable design/security/operations knowledge cards, product-family IA patterns, workflow states, security controls, and test-depth mappings. The raw Cartesian upper bound is deliberately enormous, while conditional rules prune impossible combinations.

## Write boundary

The generator may write only under:

```text
kirion-factory/mock_python/.runtime/generated/<session-id>/
```

It does **not** edit the repository, invoke a shell, modify `main`, or execute generated code. Generated files are limited to a deterministic allowlist:

```text
SPEC.md
TEST_PLAN.md
spec.json
app/index.html
app/styles.css
app/app.js
app/data.json
```

## Run

No pip install is needed. Python standard library only.

```powershell
cd "$HOME\KIRION-LAB\Forge-Breakout-Corner\kirion-factory\mock_python"
python .\selftest.py
python .\server.py
```

Open:

```text
http://127.0.0.1:7360
```

## Why this matters

The mock demonstrates that a large part of "AI software engineering" can be decomposed into explicit questions, rules, design patterns, security obligations, test requirements, and deterministic generators. A local LLM can later be inserted only where ambiguity or novel synthesis is actually useful instead of letting the model own every step.
