from __future__ import annotations

import json
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from engine import GENERATED, HERE, answer_session, create_session, generate_app, kb_stats, load_session, reset_session

PUBLIC = HERE / "public"
HOST = os.environ.get("KIRION_MOCK_HOST", "127.0.0.1")
PORT = int(os.environ.get("KIRION_MOCK_PORT", "7360"))


def send_json(handler: BaseHTTPRequestHandler, status: int, data):
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def read_json(handler: BaseHTTPRequestHandler):
    length = int(handler.headers.get("Content-Length", "0"))
    if length > 1024 * 1024:
        raise ValueError("BODY_TOO_LARGE")
    raw = handler.rfile.read(length) if length else b"{}"
    return json.loads(raw.decode("utf-8"))


def safe_file(root: Path, relative: str) -> Path:
    target = (root / relative).resolve()
    root = root.resolve()
    if target != root and root not in target.parents:
        raise ValueError("PATH_ESCAPE")
    return target


class Handler(BaseHTTPRequestHandler):
    server_version = "KirionMock/0.2"

    def log_message(self, fmt, *args):
        print(f"[mock] {self.address_string()} {fmt % args}")

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            if path == "/api/status":
                return send_json(self, 200, {"service": "KIRION_CLOSED_WORLD_MOCK", "online": True, "kb": kb_stats()})
            if path == "/api/kb/stats":
                return send_json(self, 200, kb_stats())
            if path.startswith("/api/sessions/"):
                parts = path.strip("/").split("/")
                if len(parts) == 3:
                    return send_json(self, 200, load_session(parts[2]))
            if path.startswith("/generated/"):
                rel = path[len("/generated/"):]
                file_path = safe_file(GENERATED, rel)
                if not file_path.is_file():
                    return send_json(self, 404, {"error": "NOT_FOUND"})
                data = file_path.read_bytes()
                ctype = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return self.wfile.write(data)

            relative = "index.html" if path == "/" else path.lstrip("/")
            file_path = safe_file(PUBLIC, relative)
            if not file_path.is_file():
                return send_json(self, 404, {"error": "NOT_FOUND"})
            data = file_path.read_bytes()
            ctype = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError as exc:
            send_json(self, 404, {"error": str(exc)})
        except Exception as exc:
            send_json(self, 400, {"error": str(exc)})

    def do_POST(self):
        try:
            path = urlparse(self.path).path
            body = read_json(self)
            if path == "/api/sessions":
                return send_json(self, 201, create_session(body.get("name", "KIRION Mock App")))
            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "sessions":
                session_id, action = parts[2], parts[3]
                if action == "answer":
                    return send_json(self, 200, answer_session(session_id, str(body.get("questionId", "")), str(body.get("optionId", ""))))
                if action == "generate":
                    return send_json(self, 200, generate_app(session_id))
                if action == "reset":
                    return send_json(self, 200, reset_session(session_id))
            return send_json(self, 404, {"error": "NOT_FOUND"})
        except FileNotFoundError as exc:
            send_json(self, 404, {"error": str(exc)})
        except Exception as exc:
            send_json(self, 400, {"error": str(exc)})


if __name__ == "__main__":
    print(f"KIRION Closed-World Python Mock listening on http://{HOST}:{PORT}")
    print("No LLM. No third-party packages. Generated writes are sandboxed under mock_python/.runtime/generated.")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
