#!/usr/bin/env python3
"""
Neegy-Talk — static site + a two-endpoint room proxy.

    export HYPERBEAM_API_KEY=hbr_...
    python3 server.py

Serves this directory on http://localhost:8080 and proxies room creation to
Hyperbeam so the API key never reaches the browser. No dependencies.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
HB_API = "https://engine.hyperbeam.com/v0/vm"
REGIONS = {"NA", "EU", "AS"}
MAX_SESSIONS_PER_WINDOW = 6
WINDOW_SECONDS = 600

_hits: dict[str, list[float]] = {}

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("image/svg+xml", ".svg")


def rate_ok(ip: str) -> bool:
    now = time.time()
    bucket = [t for t in _hits.get(ip, []) if now - t < WINDOW_SECONDS]
    if len(bucket) >= MAX_SESSIONS_PER_WINDOW:
        _hits[ip] = bucket
        return False
    bucket.append(now)
    _hits[ip] = bucket
    return True


def safe_url(value: str | None, fallback: str = "about:blank") -> str:
    if not value:
        return fallback
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https"):
        return fallback
    return value


class Handler(BaseHTTPRequestHandler):
    server_version = "NeegyTalk/1.0"

    # ── plumbing ────────────────────────────────────────────────
    def log_message(self, fmt: str, *args) -> None:
        super().log_message(fmt, *args)

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", os.environ.get("ALLOW_ORIGIN", "*"))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", os.environ.get("ALLOW_ORIGIN", "*"))
        self.send_header("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    # ── api ─────────────────────────────────────────────────────
    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/room":
            self._json(404, {"error": "not_found"})
            return

        key = os.environ.get("HYPERBEAM_API_KEY", "").strip()
        if not key:
            self._json(503, {
                "error": "not_configured",
                "message": "HYPERBEAM_API_KEY is not set. export it and restart.",
            })
            return

        if not rate_ok(self.client_address[0]):
            self._json(429, {"error": "rate_limited", "message": "Slow down. Six rooms per ten minutes."})
            return

        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "bad_json", "message": "Body was not JSON."})
            return

        region = body.get("region") if body.get("region") in REGIONS else "NA"
        payload = {
            "start_url": safe_url(body.get("start_url")),
            "region": region,
            "kiosk": False,
            "dark": True,
            "adblock": True,
            "width": 1280,
            "height": 720,
            "fps": 30,
            "timeout": {"offline": 600, "inactive": 1800},
        }

        req = urllib.request.Request(
            HB_API,
            data=json.dumps(payload).encode(),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                data = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raw = e.read().decode(errors="replace")
            try:
                detail = json.loads(raw)
            except json.JSONDecodeError:
                detail = {"message": raw[:240]}
            code = "unauthorized" if e.code in (401, 403) else f"http_{e.code}"
            self._json(e.code, {"error": code, "message": detail.get("message") or "Hyperbeam refused the request."})
            return
        except Exception as e:  # noqa: BLE001 - surface the real reason
            self._json(502, {"error": "network", "message": f"{type(e).__name__}: {e}"})
            return

        self._json(200, {
            "session_id": data.get("session_id"),
            "embed_url": data.get("embed_url"),
            "admin_token": data.get("admin_token"),
        })

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/room":
            self._json(404, {"error": "not_found"})
            return
        key = os.environ.get("HYPERBEAM_API_KEY", "").strip()
        session_id = (parse_qs(parsed.query).get("session_id") or [""])[0]
        if not key:
            self._json(503, {"error": "not_configured"})
            return
        if not session_id or not all(c.isalnum() or c == "-" for c in session_id):
            self._json(400, {"error": "bad_session"})
            return
        req = urllib.request.Request(
            f"{HB_API}/{session_id}",
            headers={"Authorization": f"Bearer {key}"},
            method="DELETE",
        )
        try:
            with urllib.request.urlopen(req, timeout=15):
                pass
            self._json(200, {"ended": True})
        except Exception as e:  # noqa: BLE001
            self._json(502, {"ended": False, "message": str(e)})

    # ── static ──────────────────────────────────────────────────
    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/", ""):
            path = "/index.html"
        target = (ROOT / path.lstrip("/")).resolve()

        if not str(target).startswith(str(ROOT)) or not target.is_file():
            self.send_error(404, "Not here.")
            return

        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    ap = argparse.ArgumentParser(description="Neegy-Talk local server")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    args = ap.parse_args()

    if not os.environ.get("HYPERBEAM_API_KEY"):
        print("!  HYPERBEAM_API_KEY is not set — the chat works, the room will not open.")
        print("   export HYPERBEAM_API_KEY=hbr_...   then restart.\n")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"neegy-talk → http://{args.host}:{args.port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye.")
        sys.exit(0)


if __name__ == "__main__":
    main()
