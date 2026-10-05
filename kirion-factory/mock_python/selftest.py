from __future__ import annotations

import tempfile
from pathlib import Path

import engine


def use_temp_runtime(tmp: str) -> None:
    root = Path(tmp)
    engine.RUNTIME = root
    engine.SESSIONS = root / "sessions"
    engine.GENERATED = root / "generated"


def answer(session, question_id, option_id):
    return engine.answer_session(session["id"], question_id, option_id)


def main() -> None:
    stats = engine.kb_stats()
    assert stats["questions"] >= 30
    assert stats["options"] >= 100
    assert stats["knowledgeCards"] >= 20
    assert stats["upperBoundCombinations"] > 10**12

    with tempfile.TemporaryDirectory(prefix="kirion-mock-") as tmp:
        use_temp_runtime(tmp)
        session = engine.create_session("Closed World Test")
        assert session["state"] == "QUESTIONNAIRE"
        assert session["nextQuestion"]["id"] == "product_family"

        picks = {
            "product_family": "admin_portal",
            "audience": "internal",
            "workflow": "approval",
            "roles": "rbac",
            "auth": "local",
            "data_sensitivity": "restricted",
            "audit": "immutable",
            "persistence": "browser",
            "data_shape": "records",
            "volume": "small",
            "destructive_actions": "soft",
            "approval_depth": "two",
            "navigation": "sidebar",
            "density": "compact",
            "visual_style": "industrial",
            "responsive": "responsive",
            "accessibility": "wcag_aa",
            "forms": "moderate",
            "search": "faceted",
            "export": "csv",
            "notifications": "in_app",
            "offline": "none",
            "concurrency": "moderate",
            "backup": "scheduled",
            "observability": "full",
            "deployment": "local_server",
            "testing": "release",
            "seed_data": "edge",
            "error_policy": "ops",
            "release_gate": "evidence",
        }
        seen = []
        while session["nextQuestion"]:
            q = session["nextQuestion"]
            seen.append(q["id"])
            choice = picks.get(q["id"], q["options"][0]["id"])
            session = answer(session, q["id"], choice)
        assert "approval_depth" in seen
        assert session["state"] == "READY_TO_GENERATE"
        assert session["progress"]["percent"] == 100
        assert any(card["topic"] == "authority" for card in session["knowledge"])
        assert any(card["topic"] == "release" for card in session["knowledge"])

        session = engine.generate_app(session["id"])
        assert session["state"] == "GENERATED"
        assert len(session["generated"]["files"]) == 7
        generated_root = engine.GENERATED / session["id"]
        for relative in session["generated"]["files"]:
            path = (generated_root / relative).resolve()
            assert engine.GENERATED.resolve() in path.parents
            assert path.exists()
        assert "No LLM was used" in (generated_root / "SPEC.md").read_text(encoding="utf-8")
        assert "localStorage" in (generated_root / "app" / "app.js").read_text(encoding="utf-8")

        try:
            engine.answer_session(session["id"], "product_family", "NOT_REAL")
        except ValueError:
            pass
        else:
            raise AssertionError("invalid option should fail")

    print("KIRION closed-world Python mock selftest: PASS")
    print(stats)


if __name__ == "__main__":
    main()
