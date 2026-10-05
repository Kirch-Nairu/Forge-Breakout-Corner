from __future__ import annotations

import json
import mimetypes
import os
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

from engine import (
    create_session,
    load_session,
    save_session,
    choose_next_question,
    answer_question,
    progress,
    finalize_dossier,
    qwen_health,
)

HERE = Path(__file__).resolve().parent
PUBLIC = HERE / "public"
HOST = os.environ.get("KIRION_DOSSIER_HOST", "127.0.0.1")
PORT = int(os.environ.get("KIRION_DOSSIER_PORT", "7361"))


class Handler(BaseHTTPRequestHandler):
    server_version = "KIRION-QWEN-DOSSIER/0.1"

    def log_message(self, fmt, *args):
        print(f"[KIRION] {self.address_string()} - {fmt % args}")

    def _json(self, status: int, body: dict):
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        length = int(self.headers.get("content-length", "0"))
        if length > 2 * 1024 * 1024:
            raise ValueError("BODY_TOO_LARGE")
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}")

    def _static(self, route: str):
        mapping = {"/": "index.html", "/app.js": "app.js", "/styles.css": "styles.css"}
        name = mapping.get(route)
        if not name:
            return False
        path = PUBLIC / name
        raw = path.read_bytes()
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("content-type", f"{ctype}; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(raw)
        return True

    def do_GET(self):
        route = urlparse(self.path).path
        try:
            if self._static(route):
                return
            if route == "/api/health":
                return self._json(200, {"service": "KIRION_QWEN_DOSSIER", "qwen": qwen_health()})
            parts = [p for p in route.split("/") if p]
            if len(parts) == 3 and parts[:2] == ["api", "sessions"]:
                session = load_session(parts[2])
                return self._json(200, {"session": session, "progress": progress(session)})
            return self._json(404, {"error": "NOT_FOUND"})
        except Exception as exc:
            return self._json(500, {"error": str(exc)})

    def do_POST(self):
        route = urlparse(self.path).path
        try:
            body = self._body()
            if route == "/api/sessions":
                session = create_session(
                    body.get("projectName", ""),
                    body.get("goal", ""),
                    body.get("targetDirectory", ""),
                    body.get("sourceRepo") or None,
                )
                return self._json(201, {"session": session, "progress": progress(session)})

            parts = [p for p in route.split("/") if p]
            if len(parts) != 4 or parts[:2] != ["api", "sessions"]:
                return self._json(404, {"error": "NOT_FOUND"})
            session_id, action = parts[2], parts[3]
            session = load_session(session_id)

            if action == "next":
                question = choose_next_question(session)
                session = load_session(session_id)
                return self._json(200, {"question": question, "session": session, "progress": progress(session)})

            if action == "answer":
                answer_question(session, body.get("questionId", ""), body.get("answer"))
                session = load_session(session_id)
                return self._json(200, {"session": session, "progress": progress(session)})

            if action == "finalize":
                if body.get("confirm") is not True:
                    return self._json(403, {"error": "EXPLICIT_FINALIZE_CONFIRMATION_REQUIRED"})
                generated = finalize_dossier(session)
                session = load_session(session_id)
                return self._json(200, {"generated": generated, "session": session})

            return self._json(404, {"error": "UNKNOWN_ACTION"})
        except ValueError as exc:
            return self._json(409, {"error": str(exc)})
        except FileNotFoundError as exc:
            return self._json(404, {"error": str(exc)})
        except RuntimeError as exc:
            return self._json(503, {"error": str(exc)})
        except Exception as exc:
            return self._json(500, {"error": str(exc)})


if __name__ == "__main__":
    print(f"KIRION Qwen Dossier Experiment: http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
