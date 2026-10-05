from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from question_bank import QUESTION_BANK, CRITICAL_DOMAINS

HERE = Path(__file__).resolve().parent
STATE_DIR = HERE / ".state"
DEFAULT_LLM = os.environ.get("KIRION_QWEN_URL", "http://127.0.0.1:8080/v1")
DEFAULT_MODEL = os.environ.get("KIRION_QWEN_MODEL", "bartowski/Qwen2.5-Coder-3B-Instruct-GGUF:Q4_K_M")

DOC_SPECS = [
    ("00_PROJECT_INDEX.md", "Create a concise project index: problem, users, first-release goal, major constraints, document map, unresolved assumptions."),
    ("01_PRODUCT/PRODUCT_REQUIREMENTS.md", "Write a concrete PRD with problem, goals, success criteria, functional requirements, business rules, and non-goals."),
    ("01_PRODUCT/USERS_ROLES_WORKFLOWS.md", "Define users, roles, permissions, core workflows, approvals, states, transitions, and edge cases."),
    ("01_PRODUCT/SCOPE_ACCEPTANCE.md", "Define release scope, exclusions, measurable acceptance criteria, and completion gates."),
    ("02_UX/UX_INFORMATION_ARCHITECTURE.md", "Define information architecture, navigation, key screens, interaction patterns, responsive behavior, empty/loading/error states, and accessibility."),
    ("03_ARCHITECTURE/SYSTEM_ARCHITECTURE.md", "Propose an implementation-ready system architecture consistent with the answers. Separate required constraints from recommendations and assumptions."),
    ("03_ARCHITECTURE/DATA_AND_STATE.md", "Define entities, relationships, validation, lifecycle/state machines, retention, file handling, migrations, and persistence constraints."),
    ("03_ARCHITECTURE/INTEGRATIONS_API.md", "Define external integrations, API boundaries, contracts, failure behavior, retries, idempotency, and notification behavior where applicable."),
    ("04_SECURITY/SECURITY_MODEL.md", "Define authentication, authorization, audit, data sensitivity controls, destructive-action safety, abuse cases, secrets, and negative security requirements."),
    ("05_QUALITY/TEST_AND_ACCEPTANCE.md", "Define unit, integration, negative, browser, accessibility, performance, regression, and acceptance validation. Every major requirement needs evidence."),
    ("06_OPERATIONS/DEPLOYMENT.md", "Define environments, deployment shape, configuration, release authority, migrations, rollback, and production-readiness checks."),
    ("06_OPERATIONS/OBSERVABILITY_RECOVERY.md", "Define health checks, logs, metrics/events, operator visibility, backups, restore, RPO/RTO, incident handling, and maintenance."),
    ("07_DELIVERY/IMPLEMENTATION_PLAN.md", "Create a dependency-aware implementation sequence. Do not invent requirements. Identify architecture-first and risk-first work."),
    ("07_DELIVERY/WORK_PACKAGES.md", "Break implementation into bounded work packages with owned scope, prohibited scope, prerequisites, acceptance checks, and evidence expected from each package."),
    ("08_HANDOFF/REVIEW_CHECKLIST.md", "Create a reviewer checklist covering scope, architecture, UX, security, tests, browser behavior, deployment, rollback, evidence, and known limitations."),
]


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _slug(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip()).strip("-").lower()
    return value[:64] or "project"


def _git(repo: str, *args: str) -> str | None:
    try:
        p = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=8, check=True)
        return p.stdout.strip()
    except Exception:
        return None


def inspect_repo(repo: str | None) -> dict | None:
    if not repo:
        return None
    path = str(Path(repo).expanduser().resolve())
    head = _git(path, "rev-parse", "HEAD")
    if not head:
        return {"path": path, "git": False}
    branch = _git(path, "branch", "--show-current") or "DETACHED"
    dirty = bool(_git(path, "status", "--porcelain"))
    return {"path": path, "git": True, "head": head, "branch": branch, "dirty": dirty}


def save_session(session: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_DIR / f".{session['id']}.tmp"
    dst = STATE_DIR / f"{session['id']}.json"
    tmp.write_text(json.dumps(session, indent=2), encoding="utf-8")
    os.replace(tmp, dst)


def load_session(session_id: str) -> dict:
    if not re.fullmatch(r"session-[a-z0-9-]+", session_id):
        raise ValueError("INVALID_SESSION_ID")
    path = STATE_DIR / f"{session_id}.json"
    if not path.exists():
        raise FileNotFoundError("SESSION_NOT_FOUND")
    return json.loads(path.read_text(encoding="utf-8"))


def create_session(project_name: str, goal: str, target_directory: str, source_repo: str | None = None) -> dict:
    if not project_name.strip() or not goal.strip() or not target_directory.strip():
        raise ValueError("PROJECT_NAME_GOAL_AND_TARGET_REQUIRED")
    session = {
        "id": f"session-{_slug(project_name)}-{uuid.uuid4().hex[:8]}",
        "createdAt": _now(),
        "updatedAt": _now(),
        "phase": "QUESTIONNAIRE",
        "projectName": project_name.strip(),
        "goal": goal.strip(),
        "targetDirectory": str(Path(target_directory).expanduser()),
        "sourceRepo": source_repo.strip() if source_repo else None,
        "repoFacts": inspect_repo(source_repo.strip() if source_repo else None),
        "answers": {},
        "questionHistory": [],
        "currentQuestion": None,
        "generated": None,
    }
    save_session(session)
    return session


def _cond_ok(cond: list, answers: dict) -> bool:
    qid, op, expected = cond
    actual = answers.get(qid)
    if op == "==":
        return actual == expected
    if op == "!=":
        return actual != expected
    if op == "in":
        return actual in expected
    raise ValueError(f"UNKNOWN_CONDITION_OPERATOR:{op}")


def active_questions(session: dict) -> list[dict]:
    answers = session.get("answers", {})
    result = []
    for q in QUESTION_BANK:
        if q["id"] in answers:
            continue
        if all(_cond_ok(c, answers) for c in q.get("when", [])):
            result.append(q)
    return sorted(result, key=lambda q: (-q.get("priority", 0), q["id"]))


def progress(session: dict) -> dict:
    active = active_questions(session)
    answered = session.get("answers", {})
    domains_answered = {q["domain"] for q in QUESTION_BANK if q["id"] in answered}
    required_open = [q for q in active if q.get("required")]
    return {
        "answered": len(answered),
        "remainingActive": len(active),
        "requiredRemaining": len(required_open),
        "criticalDomainsTouched": len(domains_answered.intersection(CRITICAL_DOMAINS)),
        "criticalDomainsTotal": len(CRITICAL_DOMAINS),
        "ready": not active,
    }


def _http_json(url: str, payload: dict | None = None, timeout: int = 180) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"})
    if payload is not None:
        req.method = "POST"
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise RuntimeError(f"QWEN_UNAVAILABLE:{exc}") from exc


def qwen_health(base_url: str = DEFAULT_LLM) -> dict:
    root = base_url.removesuffix("/v1").rstrip("/")
    try:
        return _http_json(f"{root}/health", timeout=4)
    except Exception as exc:
        return {"status": "offline", "error": str(exc)}


def qwen_json(system: str, user_payload: dict, schema: dict, schema_name: str, *, max_tokens: int = 900, base_url: str = DEFAULT_LLM, model: str = DEFAULT_MODEL) -> dict:
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
        ],
        "temperature": 0.1,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_schema", "json_schema": {"name": schema_name, "strict": True, "schema": schema}},
    }
    result = _http_json(f"{base_url.rstrip('/')}/chat/completions", body, timeout=240)
    content = result.get("choices", [{}])[0].get("message", {}).get("content")
    if not isinstance(content, str):
        raise RuntimeError("QWEN_RETURNED_NO_CONTENT")
    try:
        return json.loads(content)
    except json.JSONDecodeError as exc:
        raise RuntimeError("QWEN_JSON_CONTRACT_VIOLATION") from exc


def choose_next_question(session: dict) -> dict | None:
    candidates = active_questions(session)
    if not candidates:
        session["currentQuestion"] = None
        session["phase"] = "DOSSIER_READY"
        session["updatedAt"] = _now()
        save_session(session)
        return None

    window = candidates[:16]
    ids = [q["id"] for q in window]
    schema = {
        "type": "object",
        "properties": {
            "question_id": {"type": "string", "enum": ids},
            "reason": {"type": "string"},
        },
        "required": ["question_id", "reason"],
        "additionalProperties": False,
    }
    selection = qwen_json(
        "You are KIRION's requirements interviewer. Choose exactly one question from the supplied candidate IDs. Pick the question with the highest information value for the current project, considering what is already known. Never invent a question or answer it yourself. Prefer blocking architectural, security, workflow, data, acceptance, and deployment decisions over cosmetic details.",
        {
            "project": {"name": session["projectName"], "goal": session["goal"], "repo": session.get("repoFacts")},
            "answers": session.get("answers", {}),
            "candidates": window,
        },
        schema,
        "kirion_next_question",
        max_tokens=220,
    )
    selected = next(q for q in window if q["id"] == selection["question_id"])
    current = {**selected, "whyNow": selection["reason"]}
    session["currentQuestion"] = current
    session["questionHistory"].append({"questionId": selected["id"], "selectedAt": _now(), "whyNow": selection["reason"]})
    session["updatedAt"] = _now()
    save_session(session)
    return current


def answer_question(session: dict, question_id: str, answer) -> dict:
    question = next((q for q in QUESTION_BANK if q["id"] == question_id), None)
    if not question:
        raise ValueError("UNKNOWN_QUESTION")
    active_ids = {q["id"] for q in active_questions(session)}
    if question_id not in active_ids:
        raise ValueError("QUESTION_NOT_ACTIVE")
    if answer == "__SKIP__":
        if question.get("required"):
            raise ValueError("REQUIRED_QUESTION_CANNOT_BE_SKIPPED")
    elif question["kind"] == "single" and answer not in question.get("options", []):
        raise ValueError("INVALID_OPTION")
    elif question["kind"] == "boolean" and not isinstance(answer, bool):
        raise ValueError("BOOLEAN_REQUIRED")
    elif question["kind"] == "text" and not str(answer).strip():
        raise ValueError("NON_EMPTY_TEXT_REQUIRED")
    session["answers"][question_id] = answer
    session["currentQuestion"] = None
    session["updatedAt"] = _now()
    save_session(session)
    return session


def _safe_target(raw: str) -> Path:
    target = Path(raw).expanduser().resolve()
    if target == Path(target.anchor):
        raise ValueError("TARGET_MAY_NOT_BE_FILESYSTEM_ROOT")
    if target.exists() and any(target.iterdir()):
        raise ValueError("TARGET_DIRECTORY_MUST_BE_NEW_OR_EMPTY")
    return target


def _session_context(session: dict) -> dict:
    by_domain = {}
    qmap = {q["id"]: q for q in QUESTION_BANK}
    for qid, answer in session.get("answers", {}).items():
        q = qmap.get(qid)
        if not q:
            continue
        by_domain.setdefault(q["domain"], []).append({"question": q["question"], "answer": answer})
    return {
        "projectName": session["projectName"],
        "goal": session["goal"],
        "repoFacts": session.get("repoFacts"),
        "requirementsByDomain": by_domain,
    }


def _synthesize_markdown(session: dict, relative_path: str, purpose: str) -> str:
    schema = {
        "type": "object",
        "properties": {"markdown": {"type": "string"}},
        "required": ["markdown"],
        "additionalProperties": False,
    }
    result = qwen_json(
        "You are KIRION's specification writer. Produce implementation-grade Markdown grounded only in the supplied requirements. Do not fabricate resolved decisions. Mark missing details as ASSUMPTION or OPEN QUESTION. Be specific enough for another coding agent to implement and test. Do not include conversational filler.",
        {"document": relative_path, "purpose": purpose, "context": _session_context(session)},
        schema,
        "kirion_document",
        max_tokens=1350,
    )
    return result["markdown"].strip() + "\n"


def _codex_handoff(session: dict, generated_files: list[str]) -> str:
    repo = session.get("repoFacts") or {}
    exact_sha = repo.get("head") or "NEW_REPOSITORY"
    repo_path = repo.get("path") or session.get("sourceRepo") or "NEW_REPOSITORY"
    lines = [
        "# KIRION → CODEX IMPLEMENTATION HANDOFF",
        "",
        "## Authority",
        "",
        "This dossier defines the implementation target. Read every numbered document before mutating code.",
        "Do not silently expand scope, invent requirements, or replace explicit architecture decisions.",
        "If a blocking contradiction remains, stop and report it rather than guessing.",
        "",
        "## Source",
        "",
        f"- Project: `{session['projectName']}`",
        f"- Repository/workspace: `{repo_path}`",
        f"- Exact source SHA: `{exact_sha}`",
        f"- Source branch at discovery: `{repo.get('branch', 'N/A')}`",
        f"- Source worktree dirty at discovery: `{repo.get('dirty', 'N/A')}`",
        "",
        "## Implementation protocol",
        "",
        "1. Re-verify the repository and exact SHA before writing.",
        "2. Create or use an isolated candidate branch/worktree; do not mutate canonical `main` directly.",
        "3. Treat the numbered Markdown files as the requirements and architecture contract.",
        "4. Implement bounded work packages in dependency order.",
        "5. Run required unit, integration, negative, browser/accessibility, and deployment checks described by the dossier.",
        "6. Rework failures until no actionable acceptance blocker remains or a bounded retry limit is reached.",
        "7. Do not self-promote or deploy to production without explicit human authority.",
        "8. Finish in `FOR REVIEW`, not `PROMOTED`.",
        "",
        "## Required return evidence",
        "",
        "Return the exact candidate SHA, branch/worktree, changed files, implementation summary, tests/checks executed with results, unresolved findings, prohibited-scope confirmation, deployment-readiness status, and rollback notes.",
        "",
        "## Dossier files",
        "",
    ]
    lines.extend(f"- `{p}`" for p in generated_files)
    lines += ["", "## Objective", "", session["goal"], ""]
    return "\n".join(lines)


def finalize_dossier(session: dict) -> dict:
    if active_questions(session):
        raise ValueError("QUESTIONNAIRE_NOT_COMPLETE")
    target = _safe_target(session["targetDirectory"])
    target.mkdir(parents=True, exist_ok=True)
    generated = []
    for relative, purpose in DOC_SPECS:
        path = target / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_synthesize_markdown(session, relative, purpose), encoding="utf-8")
        generated.append(relative)

    handoff_rel = "08_HANDOFF/CODEX_HANDOFF.md"
    handoff = target / handoff_rel
    handoff.parent.mkdir(parents=True, exist_ok=True)
    handoff.write_text(_codex_handoff(session, generated), encoding="utf-8")
    generated.append(handoff_rel)

    session_copy = {k: v for k, v in session.items() if k != "generated"}
    (target / "SESSION.json").write_text(json.dumps(session_copy, indent=2), encoding="utf-8")
    generated.append("SESSION.json")
    manifest = {
        "format": "KIRION-QWEN-DOSSIER-v1",
        "generatedAt": _now(),
        "projectName": session["projectName"],
        "targetDirectory": str(target),
        "source": session.get("repoFacts"),
        "files": generated,
    }
    (target / "MANIFEST.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    generated.append("MANIFEST.json")

    session["phase"] = "DOSSIER_GENERATED"
    session["generated"] = {"directory": str(target), "files": generated, "at": _now()}
    session["updatedAt"] = _now()
    save_session(session)
    return session["generated"]
