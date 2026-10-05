from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

HERE = Path(__file__).resolve().parent
KB_PATH = HERE / "knowledge_base.json"
RUNTIME = HERE / ".runtime"
SESSIONS = RUNTIME / "sessions"
GENERATED = RUNTIME / "generated"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_kb() -> Dict[str, Any]:
    return json.loads(KB_PATH.read_text(encoding="utf-8"))


def ensure_runtime() -> None:
    SESSIONS.mkdir(parents=True, exist_ok=True)
    GENERATED.mkdir(parents=True, exist_ok=True)


def atomic_json(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def safe_slug(value: str, fallback: str = "kirion-mock-app") -> str:
    value = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(value or "").strip()).strip("-").lower()
    return value[:48] or fallback


def applies(question: Dict[str, Any], answers: Dict[str, str]) -> bool:
    cond = question.get("when")
    if not cond:
        return True
    return all(answers.get(key) in allowed for key, allowed in cond.items())


def option_map(question: Dict[str, Any]) -> Dict[str, str]:
    return {o["id"]: o["label"] for o in question["options"]}


def resolved_questions(kb: Dict[str, Any], answers: Dict[str, str]) -> List[Dict[str, Any]]:
    return [q for q in kb["questions"] if applies(q, answers) and q["id"] in answers]


def pending_questions(kb: Dict[str, Any], answers: Dict[str, str]) -> List[Dict[str, Any]]:
    return [q for q in kb["questions"] if applies(q, answers) and q["id"] not in answers]


def next_question(kb: Dict[str, Any], answers: Dict[str, str]) -> Optional[Dict[str, Any]]:
    pending = pending_questions(kb, answers)
    return pending[0] if pending else None


def card_matches(card: Dict[str, Any], answers: Dict[str, str]) -> bool:
    trigger = card.get("trigger", {})
    return all(answers.get(k) in values for k, values in trigger.items())


def active_cards(kb: Dict[str, Any], answers: Dict[str, str]) -> List[Dict[str, Any]]:
    return [c for c in kb.get("knowledge_cards", []) if card_matches(c, answers)]


def selected_label(kb: Dict[str, Any], question_id: str, value: str) -> str:
    for q in kb["questions"]:
        if q["id"] == question_id:
            return option_map(q).get(value, value)
    return value


def create_session(name: str = "KIRION Mock App") -> Dict[str, Any]:
    ensure_runtime()
    session_id = f"mock-{secrets.token_hex(6)}"
    session = {
        "id": session_id,
        "name": str(name or "KIRION Mock App")[:80],
        "createdAt": now(),
        "updatedAt": now(),
        "state": "QUESTIONNAIRE",
        "answers": {},
        "events": [{"at": now(), "type": "SESSION_CREATED"}],
        "generated": None,
    }
    atomic_json(SESSIONS / f"{session_id}.json", session)
    return hydrate(session)


def load_session(session_id: str) -> Dict[str, Any]:
    if not re.fullmatch(r"mock-[a-f0-9]{12}", session_id):
        raise ValueError("INVALID_SESSION_ID")
    path = SESSIONS / f"{session_id}.json"
    if not path.exists():
        raise FileNotFoundError("SESSION_NOT_FOUND")
    return hydrate(json.loads(path.read_text(encoding="utf-8")))


def persist(session: Dict[str, Any]) -> Dict[str, Any]:
    raw = {k: v for k, v in session.items() if k not in {"nextQuestion", "progress", "resolved", "knowledge", "specPreview"}}
    raw["updatedAt"] = now()
    atomic_json(SESSIONS / f"{raw['id']}.json", raw)
    return hydrate(raw)


def answer_session(session_id: str, question_id: str, option_id: str) -> Dict[str, Any]:
    kb = load_kb()
    session = load_session(session_id)
    answers = dict(session["answers"])
    question = next((q for q in kb["questions"] if q["id"] == question_id), None)
    if not question or not applies(question, answers):
        raise ValueError("QUESTION_NOT_ACTIVE")
    valid = option_map(question)
    if option_id not in valid:
        raise ValueError("INVALID_OPTION")
    answers[question_id] = option_id

    changed = True
    while changed:
        changed = False
        for q in kb["questions"]:
            if q["id"] in answers and not applies(q, answers):
                del answers[q["id"]]
                changed = True

    session["answers"] = answers
    session["events"].append({"at": now(), "type": "ANSWER_SELECTED", "questionId": question_id, "optionId": option_id})
    if next_question(kb, answers) is None:
        session["state"] = "READY_TO_GENERATE"
        session["events"].append({"at": now(), "type": "QUESTIONNAIRE_COMPLETE"})
    return persist(session)


def reset_session(session_id: str) -> Dict[str, Any]:
    session = load_session(session_id)
    session["answers"] = {}
    session["state"] = "QUESTIONNAIRE"
    session["generated"] = None
    session["events"].append({"at": now(), "type": "SESSION_RESET"})
    return persist(session)


def derive_spec(kb: Dict[str, Any], session: Dict[str, Any]) -> Dict[str, Any]:
    a = session["answers"]
    product = kb["patterns"]["product_family"][a["product_family"]]
    workflow = kb["patterns"]["workflow"][a["workflow"]]
    visual = kb["patterns"]["visual_style"][a["visual_style"]]

    controls: List[str] = []
    for key in [a.get("data_sensitivity"), a.get("audit"), a.get("destructive_actions"), a.get("auth"), a.get("roles"), a.get("accessibility")]:
        controls.extend(kb.get("controls", {}).get(key, []))
    if a.get("observability") == "full":
        controls.extend(kb.get("controls", {}).get("full_observability", []))
    controls = sorted(set(controls))

    tests = list(kb["test_catalog"]["smoke"])
    depth = a.get("testing", "smoke")
    if depth in {"standard", "strict", "release"}:
        tests += kb["test_catalog"]["standard"]
    if depth in {"strict", "release"}:
        tests += kb["test_catalog"]["strict"]
    if depth == "release":
        tests += kb["test_catalog"]["release"]

    cards = active_cards(kb, a)
    return {
        "name": session["name"],
        "mode": kb["mode"],
        "productFamily": a["product_family"],
        "pages": product["pages"],
        "entities": product["entities"],
        "states": workflow["states"],
        "visual": visual,
        "answers": {q["id"]: {"value": a[q["id"]], "label": selected_label(kb, q["id"], a[q["id"]])} for q in resolved_questions(kb, a)},
        "securityControls": controls,
        "tests": tests,
        "knowledge": [{"id": c["id"], "topic": c["topic"], "advice": c["advice"]} for c in cards],
        "releaseGate": a["release_gate"],
        "generatedAt": now(),
    }


def hydrate(session: Dict[str, Any]) -> Dict[str, Any]:
    kb = load_kb()
    answers = session.get("answers", {})
    nxt = next_question(kb, answers)
    applicable = [q for q in kb["questions"] if applies(q, answers)]
    resolved = resolved_questions(kb, answers)
    result = dict(session)
    result["nextQuestion"] = nxt
    result["progress"] = {"answered": len(resolved), "applicable": len(applicable), "percent": int((len(resolved) / max(1, len(applicable))) * 100)}
    result["resolved"] = [{"id": q["id"], "prompt": q["prompt"], "value": answers[q["id"]], "label": selected_label(kb, q["id"], answers[q["id"]])} for q in resolved]
    result["knowledge"] = active_cards(kb, answers)
    if nxt is None and answers:
        try:
            result["specPreview"] = derive_spec(kb, result)
        except KeyError:
            result["specPreview"] = None
    else:
        result["specPreview"] = None
    return result


def render_spec_md(spec: Dict[str, Any]) -> str:
    answer_lines = "\n".join(f"- **{k}**: {v['label']} (`{v['value']}`)" for k, v in spec["answers"].items())
    controls = "\n".join(f"- {x}" for x in spec["securityControls"]) or "- none selected"
    tests = "\n".join(f"- [ ] {x}" for x in spec["tests"])
    knowledge = "\n".join(f"- **{x['topic']}** — {x['advice']}" for x in spec["knowledge"]) or "- no triggered cards"
    return f"""# {spec['name']} — Deterministic Mock Specification

Generated by KIRION Closed-World Mock Factory. No LLM was used.

## Architecture snapshot

- Product family: `{spec['productFamily']}`
- Pages: {', '.join(spec['pages'])}
- Entities: {', '.join(spec['entities'])}
- Workflow states: {', '.join(spec['states'])}
- Release gate: `{spec['releaseGate']}`

## Selected decisions

{answer_lines}

## Derived security / authority controls

{controls}

## Triggered knowledge cards

{knowledge}

## Acceptance checklist

{tests}
"""


def render_test_plan(spec: Dict[str, Any]) -> str:
    body = "\n".join(f"{i+1}. {test}" for i, test in enumerate(spec["tests"]))
    return f"# TEST PLAN — {spec['name']}\n\n{body}\n"


def seed_records(spec: Dict[str, Any], richness: str) -> List[Dict[str, Any]]:
    count = {"minimal": 4, "normal": 8, "rich": 14, "edge": 18}.get(richness, 8)
    states = spec["states"]
    records = []
    for i in range(count):
        records.append({
            "id": f"REC-{i+1:04d}",
            "title": f"{spec['entities'][0].replace('_',' ').title()} {i+1}",
            "status": states[i % len(states)],
            "owner": ["A. Reyes", "J. Santos", "M. Cruz", "Ops Queue"][i % 4],
            "priority": ["LOW", "NORMAL", "HIGH", "URGENT"][i % 4],
            "updated": f"2026-10-{(i%28)+1:02d}",
        })
    if richness == "edge":
        records[-1]["title"] = "Edge case — very long title used to exercise clipping, wrapping and dense table behavior"
        records[-2]["owner"] = "Unassigned"
    return records


def render_app_html(spec: Dict[str, Any]) -> str:
    nav = "".join(f'<button class="nav" data-page="{safe_slug(p)}">{p}</button>' for p in spec["pages"])
    knowledge = ''.join(f'<li><b>{k["topic"]}</b> — {k["advice"]}</li>' for k in spec['knowledge']) or '<li>No conditional cards triggered.</li>'
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{spec['name']}</title><link rel="stylesheet" href="styles.css"></head>
<body><div class="shell"><aside><div class="brand">{spec['name']}</div><div class="meta">KIRION deterministic mock</div><nav>{nav}</nav></aside>
<main><header><div><div class="eyebrow">{spec['productFamily'].replace('_',' ').upper()}</div><h1 id="pageTitle">{spec['pages'][0]}</h1></div><div class="pill">{spec['answers']['roles']['label']}</div></header>
<section class="metrics"><article><span>Open</span><strong id="openCount">0</strong></article><article><span>Total</span><strong id="totalCount">0</strong></article><article><span>Release gate</span><strong>{spec['releaseGate']}</strong></article></section>
<section class="toolbar"><input id="search" placeholder="Search records"><select id="statusFilter"><option value="">All states</option></select><button id="add">New record</button></section>
<section class="panel"><table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Owner</th><th>Priority</th><th>Updated</th></tr></thead><tbody id="rows"></tbody></table><div id="empty" hidden>No matching records.</div></section>
<section class="knowledge"><h2>Design knowledge applied</h2><ul>{knowledge}</ul></section>
</main></div><dialog id="dialog"><form method="dialog"><h2>Create mock record</h2><label>Title<input id="newTitle" required></label><label>Status<select id="newStatus"></select></label><menu><button value="cancel">Cancel</button><button id="save" value="default">Save</button></menu></form></dialog>
<script src="app.js"></script></body></html>"""


def render_app_css(spec: Dict[str, Any]) -> str:
    accent = spec["visual"]["accent"]
    surface = spec["visual"]["surface"]
    dense = spec["answers"]["density"]["value"] == "dense"
    pad = "7px 10px" if dense else "12px 14px"
    return f""":root{{--bg:#090b0f;--surface:{surface};--surface2:#161a21;--line:#2a303a;--text:#f3f5f8;--muted:#9aa6b6;--accent:{accent};font-family:Inter,ui-sans-serif,system-ui,sans-serif}}*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text)}}.shell{{display:grid;grid-template-columns:250px 1fr;min-height:100vh}}aside{{border-right:1px solid var(--line);padding:24px;background:#0d1015;position:sticky;top:0;height:100vh}}.brand{{font-weight:800;font-size:20px}}.meta,.eyebrow{{color:var(--muted);font-size:12px;letter-spacing:.12em;text-transform:uppercase;margin-top:6px}}nav{{display:grid;gap:8px;margin-top:28px}}.nav{{text-align:left;background:transparent;color:var(--text);border:1px solid transparent;padding:10px;border-radius:9px;cursor:pointer}}.nav:hover,.nav.active{{background:var(--surface2);border-color:var(--line)}}main{{padding:28px;min-width:0}}header{{display:flex;align-items:center;justify-content:space-between;gap:20px}}h1{{margin:5px 0 0;font-size:32px}}.pill{{border:1px solid var(--line);padding:9px 12px;border-radius:999px;color:var(--accent)}}.metrics{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:24px 0}}article,.panel,.knowledge{{background:var(--surface);border:1px solid var(--line);border-radius:14px}}article{{padding:18px}}article span{{display:block;color:var(--muted);font-size:12px}}article strong{{display:block;margin-top:7px;font-size:24px}}.toolbar{{display:flex;gap:10px;margin-bottom:12px}}input,select,button{{font:inherit}}.toolbar input,.toolbar select,dialog input,dialog select{{background:#0c0f14;color:var(--text);border:1px solid var(--line);border-radius:9px;padding:10px}}.toolbar input{{flex:1}}.toolbar button,#save{{background:var(--accent);color:#111;border:0;border-radius:9px;padding:10px 14px;font-weight:800;cursor:pointer}}.panel{{overflow:auto}}table{{width:100%;border-collapse:collapse;min-width:760px}}th,td{{padding:{pad};border-bottom:1px solid var(--line);text-align:left}}th{{color:var(--muted);font-size:12px;text-transform:uppercase}}#empty{{padding:28px;text-align:center;color:var(--muted)}}.knowledge{{padding:20px;margin-top:16px}}.knowledge li{{margin:8px 0;color:#c8d0db}}dialog{{background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:14px;min-width:min(460px,90vw)}}dialog form{{display:grid;gap:14px}}dialog label{{display:grid;gap:6px}}menu{{display:flex;justify-content:flex-end;gap:8px;padding:0}}@media(max-width:800px){{.shell{{grid-template-columns:1fr}}aside{{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}}nav{{grid-template-columns:repeat(2,1fr)}}main{{padding:18px}}.metrics{{grid-template-columns:1fr}}header{{align-items:flex-start}}}}"""


def render_app_js(spec: Dict[str, Any], records: List[Dict[str, Any]]) -> str:
    states = json.dumps(spec["states"])
    data = json.dumps(records)
    storage_key = safe_slug(spec["name"]) + "-records"
    return f"""'use strict';
const STATES={states};
const SEED={data};
const KEY={json.dumps(storage_key)};
let records=JSON.parse(localStorage.getItem(KEY)||'null')||SEED;
const $=s=>document.querySelector(s); const $$=s=>[...document.querySelectorAll(s)];
function persist(){{localStorage.setItem(KEY,JSON.stringify(records));}}
function render(){{const q=$('#search').value.toLowerCase();const status=$('#statusFilter').value;const shown=records.filter(r=>(!q||JSON.stringify(r).toLowerCase().includes(q))&&(!status||r.status===status));$('#rows').innerHTML=shown.map(r=>`<tr><td>${{r.id}}</td><td>${{r.title}}</td><td>${{r.status}}</td><td>${{r.owner}}</td><td>${{r.priority}}</td><td>${{r.updated}}</td></tr>`).join('');$('#empty').hidden=shown.length>0;$('#totalCount').textContent=records.length;$('#openCount').textContent=records.filter(r=>!['DONE','APPROVED'].includes(r.status)).length;}}
function fillStates(){{$('#statusFilter').innerHTML='<option value="">All states</option>'+STATES.map(s=>`<option>${{s}}</option>`).join('');$('#newStatus').innerHTML=STATES.map(s=>`<option>${{s}}</option>`).join('');}}
$$('.nav').forEach((b,i)=>{{if(i===0)b.classList.add('active');b.onclick=()=>{{$$('.nav').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('#pageTitle').textContent=b.textContent;}}}});
$('#search').oninput=render;$('#statusFilter').onchange=render;$('#add').onclick=()=>$('#dialog').showModal();
$('#save').onclick=e=>{{e.preventDefault();const title=$('#newTitle').value.trim();if(!title)return;records.unshift({{id:'REC-'+String(records.length+1).padStart(4,'0'),title,status:$('#newStatus').value,owner:'Current User',priority:'NORMAL',updated:new Date().toISOString().slice(0,10)}});persist();$('#newTitle').value='';$('#dialog').close();render();}};
fillStates();render();
"""


def generate_app(session_id: str) -> Dict[str, Any]:
    kb = load_kb()
    session = load_session(session_id)
    if next_question(kb, session["answers"]) is not None:
        raise ValueError("QUESTIONNAIRE_INCOMPLETE")
    spec = derive_spec(kb, session)
    out = GENERATED / session_id
    app = out / "app"
    app.mkdir(parents=True, exist_ok=True)
    records = seed_records(spec, session["answers"]["seed_data"])

    files = {
        out / "SPEC.md": render_spec_md(spec),
        out / "TEST_PLAN.md": render_test_plan(spec),
        out / "spec.json": json.dumps(spec, indent=2),
        app / "index.html": render_app_html(spec),
        app / "styles.css": render_app_css(spec),
        app / "app.js": render_app_js(spec, records),
        app / "data.json": json.dumps(records, indent=2),
    }
    for path, content in files.items():
        resolved = path.resolve()
        if GENERATED.resolve() not in resolved.parents:
            raise RuntimeError("OUTPUT_BOUNDARY_VIOLATION")
        path.write_text(content, encoding="utf-8")

    session["state"] = "GENERATED"
    session["generated"] = {
        "at": now(),
        "root": str(out),
        "files": [str(p.relative_to(out)).replace('\\','/') for p in files],
        "preview": f"/generated/{session_id}/app/index.html",
    }
    session["events"].append({"at": now(), "type": "APP_GENERATED", "fileCount": len(files)})
    return persist(session)


def kb_stats() -> Dict[str, Any]:
    kb = load_kb()
    option_count = sum(len(q["options"]) for q in kb["questions"])
    upper = 1
    for q in kb["questions"]:
        upper *= len(q["options"])
    return {
        "version": kb["version"],
        "mode": kb["mode"],
        "questions": len(kb["questions"]),
        "options": option_count,
        "knowledgeCards": len(kb.get("knowledge_cards", [])),
        "upperBoundCombinations": upper,
        "principles": kb["principles"],
    }
