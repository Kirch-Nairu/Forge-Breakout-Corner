import tempfile
from pathlib import Path

import engine


def assert_true(value, message):
    if not value:
        raise AssertionError(message)


def main():
    original_state = engine.STATE_DIR
    with tempfile.TemporaryDirectory() as td:
        engine.STATE_DIR = Path(td) / "state"
        target = Path(td) / "output"
        s = engine.create_session("Test Project", "Build a secure workflow app", str(target), None)
        assert_true(s["phase"] == "QUESTIONNAIRE", "session phase")
        assert_true(engine.progress(s)["answered"] == 0, "initial progress")

        ids = {q["id"] for q in engine.active_questions(s)}
        assert_true("workflow.state_list" not in ids, "conditional question must be inactive")
        engine.answer_question(s, "workflow.states", True)
        s = engine.load_session(s["id"])
        ids = {q["id"] for q in engine.active_questions(s)}
        assert_true("workflow.state_list" in ids, "conditional question must activate")

        try:
            engine.answer_question(s, "product.problem", "__SKIP__")
            raise AssertionError("required skip was accepted")
        except ValueError as exc:
            assert_true(str(exc) == "REQUIRED_QUESTION_CANNOT_BE_SKIPPED", "required skip error")

        handoff = engine._codex_handoff(s, ["01_PRODUCT/PRODUCT_REQUIREMENTS.md"])
        assert_true("FOR REVIEW" in handoff, "handoff terminal state")
        assert_true("do not mutate canonical `main` directly" in handoff, "main protection")

        safe = engine._safe_target(str(target))
        assert_true(safe == target.resolve(), "safe target")
        target.mkdir(parents=True)
        (target / "occupied.txt").write_text("x", encoding="utf-8")
        try:
            engine._safe_target(str(target))
            raise AssertionError("non-empty output accepted")
        except ValueError as exc:
            assert_true(str(exc) == "TARGET_DIRECTORY_MUST_BE_NEW_OR_EMPTY", "non-empty target guard")

    engine.STATE_DIR = original_state
    print("KIRION Qwen dossier selftest: PASS")
    print({"questions": len(engine.QUESTION_BANK), "documents": len(engine.DOC_SPECS) + 3})


if __name__ == "__main__":
    main()
