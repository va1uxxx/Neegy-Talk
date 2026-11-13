#!/usr/bin/env python3
"""
Neegy-Talk — static site, realtime chat, Hyperbeam room proxy.

    python3 server.py
    python3 server.py --port 8080 --host 0.0.0.0

Zero dependencies. Standard library only.

    /            static files from this directory
    /ws          WebSocket chat (rooms, presence, typing, reactions)
    /api/room    Hyperbeam room create/delete, key stays server side

Chat state is kept in memory and mirrored to data/chat.json so a restart does
not wipe the rooms or the last messages.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import signal
import socket
import struct
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
STATE_FILE = DATA / "chat.json"

HB_API = "https://engine.hyperbeam.com/v0/vm"
REGIONS = {"NA", "EU", "AS"}
MAX_SESSIONS_PER_WINDOW = 6
WINDOW_SECONDS = 600

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_FRAME = 64 * 1024
MAX_TEXT = 2000
MAX_ROOMS = 40
HISTORY = 200
PERSIST_HISTORY = 60
HEARTBEAT = 25.0
DEAD_AFTER = 75.0

ROOM_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")
UID_RE = re.compile(r"^[A-Za-z0-9]{6,40}$")

# Directories and files the static server refuses to hand out.
PRIVATE = {
    "server.py",
    "wrangler.toml",
    "README.md",
    ".env.example",
    "data",
    "worker",
    ".github",
    "node_modules",
    "test",
}
CONTROL = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]")

SEED_ROOMS = [
    {"id": "general", "name": "general", "icon": "💬", "topic": "Anything. Start here.", "pinned": True},
    {"id": "intros", "name": "intros", "icon": "👋", "topic": "Who you are, once.", "pinned": True},
    {"id": "offtopic", "name": "off-topic", "icon": "🌀", "topic": "The other ninety percent.", "pinned": True},
    {"id": "music", "name": "music", "icon": "🎧", "topic": "What is on loop right now.", "pinned": False},
    {"id": "help", "name": "help", "icon": "🛠️", "topic": "Ask, answer, move on.", "pinned": False},
]

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("image/svg+xml", ".svg")

_hb_hits: dict[str, list[float]] = {}
_hb_lock = threading.Lock()


def rate_ok(bucket: dict, key: str, limit: int, window: float) -> bool:
    now = time.time()
    with _hb_lock:
        hits = [t for t in bucket.get(key, []) if now - t < window]
        if len(hits) >= limit:
            bucket[key] = hits
            return False
        hits.append(now)
        bucket[key] = hits
        return True


# ────────────────────────────────────────────────────────── shared state ──


class Client:
    __slots__ = ("sock", "addr", "id", "uid", "name", "emoji", "hue", "level", "room", "lock", "alive", "last", "hits")

    def __init__(self, sock: socket.socket, addr):
        self.sock = sock
        self.addr = addr
        self.id = "s_" + base64.b32encode(os.urandom(10)).decode().strip("=").lower()
        # id is the connection; uid is the person. Two tabs of one browser share a uid.
        self.uid = "g_" + base64.b32encode(os.urandom(9)).decode().strip("=").lower()
        self.name = "guest"
        self.emoji = None
        self.hue = 250
        self.level = 1
        self.room = "general"
        self.lock = threading.Lock()
        self.alive = True
        self.last = time.time()
        self.hits: deque[float] = deque(maxlen=16)

    def public(self) -> dict:
        return {"id": self.uid, "name": self.name, "emoji": self.emoji, "hue": self.hue, "level": self.level}

    def send(self, payload: dict) -> bool:
        if not self.alive:
            return False
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        try:
            with self.lock:
                ws_send(self.sock, 0x1, data)
            return True
        except OSError:
            self.alive = False
            return False


class Room:
    __slots__ = ("id", "name", "icon", "topic", "pinned", "created", "by", "messages")

    def __init__(self, data: dict):
        self.id = data["id"]
        self.name = data.get("name") or data["id"]
        self.icon = data.get("icon") or "💬"
        self.topic = data.get("topic") or "No topic yet."
        self.pinned = bool(data.get("pinned"))
        self.created = int(data.get("created") or time.time() * 1000)
        self.by = data.get("by") or "system"
        self.messages: deque[dict] = deque(maxlen=HISTORY)

    def meta(self) -> dict:
        last = self.messages[-1] if self.messages else None
        return {
            "id": self.id,
            "name": self.name,
            "icon": self.icon,
            "topic": self.topic,
            "pinned": self.pinned,
            "created": self.created,
            "last": {
                "ts": last["ts"],
                "author": last["author"]["name"],
                "text": last["text"][:70],
            }
            if last
            else None,
        }


class Hub:
    def __init__(self):
        self.lock = threading.RLock()
        self.clients: dict[str, Client] = {}
        self.rooms: dict[str, Room] = {r["id"]: Room(r) for r in SEED_ROOMS}
        self.dirty = False
        self.load()

    # ── persistence ─────────────────────────────────────
    def load(self) -> None:
        try:
            raw = STATE_FILE.read_text(encoding="utf-8")
            data = json.loads(raw)
        except (OSError, ValueError):
            return
        for r in data.get("rooms", []):
            if isinstance(r, dict) and r.get("id") and ROOM_ID.match(str(r["id"])):
                room = Room(r)
                for m in r.get("messages", [])[:HISTORY]:
                    if isinstance(m, dict) and m.get("id") and m.get("text"):
                        room.messages.append(m)
                self.rooms[room.id] = room

    def save_loop(self) -> None:
        DATA.mkdir(exist_ok=True)
        while True:
            time.sleep(3)
            if not self.dirty:
                continue
            self.dirty = False
            with self.lock:
                payload = {
                    "version": 2,
                    "saved": int(time.time() * 1000),
                    "rooms": [
                        {
                            **room.meta(),
                            "by": room.by,
                            "messages": list(room.messages)[-PERSIST_HISTORY:],
                        }
                        for room in self.rooms.values()
                    ],
                }
            tmp = STATE_FILE.with_suffix(".tmp")
            try:
                tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
                tmp.replace(STATE_FILE)
            except OSError:
                pass

    # ── membership ──────────────────────────────────────
    def add(self, c: Client) -> None:
        with self.lock:
            self.clients[c.id] = c

    def remove(self, c: Client) -> None:
        with self.lock:
            self.clients.pop(c.id, None)
        self.presence(c.room)
        self.broadcast_all({"t": "rooms", "rooms": self.room_list()})

    def members(self, room_id: str) -> list[dict]:
        with self.lock:
            seen: dict[str, dict] = {}
            for c in self.clients.values():
                if c.room == room_id and c.alive and c.uid not in seen:
                    seen[c.uid] = c.public()
            return list(seen.values())

    def room_list(self) -> list[dict]:
        with self.lock:
            rooms = [r.meta() for r in self.rooms.values()]
        rooms.sort(key=lambda r: (not r["pinned"], r["name"]))
        return rooms

    def presence(self, room_id: str) -> None:
        frame = {"t": "presence", "room": room_id, "members": self.members(room_id)}
        self.broadcast_room(room_id, frame)

    def broadcast_room(self, room_id: str, payload: dict) -> None:
        with self.lock:
            targets = [c for c in self.clients.values() if c.room == room_id]
        for c in targets:
            if not c.send(payload):
                c.alive = False

    def broadcast_all(self, payload: dict) -> None:
        with self.lock:
            targets = list(self.clients.values())
        for c in targets:
            if not c.send(payload):
                c.alive = False

    def heartbeat(self) -> None:
        while True:
            time.sleep(HEARTBEAT)
            now = time.time()
            with self.lock:
                clients = list(self.clients.values())
            for c in clients:
                if now - c.last > DEAD_AFTER:
                    c.alive = False
                    try:
                        c.sock.close()
                    except OSError:
                        pass
                    continue
                try:
                    with c.lock:
                        ws_send(c.sock, 0x9, b"hb")
                except OSError:
                    c.alive = False
            with self.lock:
                dead = [cid for cid, c in self.clients.items() if not c.alive]
                for cid in dead:
                    self.clients.pop(cid, None)


HUB = Hub()


# ───────────────────────────────────────────────────────────── websocket ──


def ws_send(sock: socket.socket, opcode: int, data: bytes) -> None:
    header = bytes([0x80 | opcode])
    n = len(data)
    if n < 126:
        header += bytes([n])
    elif n < 65536:
        header += bytes([126]) + struct.pack("!H", n)
    else:
        header += bytes([127]) + struct.pack("!Q", n)
    sock.sendall(header + data)


def recv_exact(sock: socket.socket, n: int) -> bytes | None:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return bytes(buf)


def ws_read(sock: socket.socket):
    """Return (opcode, payload) or None on close/error. Handles fragmentation."""
    fragments = bytearray()
    msg_op = 0
    while True:
        head = recv_exact(sock, 2)
        if not head:
            return None
        b1, b2 = head[0], head[1]
        fin = b1 & 0x80
        opcode = b1 & 0x0F
        masked = b2 & 0x80
        length = b2 & 0x7F
        if length == 126:
            ext = recv_exact(sock, 2)
            if not ext:
                return None
            length = struct.unpack("!H", ext)[0]
        elif length == 127:
            ext = recv_exact(sock, 8)
            if not ext:
                return None
            length = struct.unpack("!Q", ext)[0]
        if length > MAX_FRAME:
            return None
        mask = recv_exact(sock, 4) if masked else None
        payload = recv_exact(sock, length) if length else b""
        if payload is None:
            return None
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        if opcode in (0x8, 0x9, 0xA):
            return opcode, payload
        if opcode != 0x0:
            msg_op = opcode
            fragments = bytearray(payload)
        else:
            fragments.extend(payload)
        if fin:
            return msg_op or 0x1, bytes(fragments)


def clean(text, limit: int) -> str:
    return CONTROL.sub("", str(text or ""))[:limit].strip()


# ────────────────────────────────────────────────────────────── protocol ──


def handle_hello(c: Client, f: dict) -> None:
    profile = f.get("profile") or {}
    pid = clean(profile.get("id"), 40)
    if UID_RE.match(pid):
        c.uid = pid.lower()
    name = clean(profile.get("name") or f.get("name"), 24) or "guest"
    if len(name) < 2:
        name = "guest-" + c.uid[-4:]
    c.name = name
    emoji = profile.get("emoji")
    c.emoji = clean(emoji, 8) or None
    try:
        c.hue = max(0, min(359, int(profile.get("hue", 250))))
    except (TypeError, ValueError):
        c.hue = 250
    try:
        c.level = max(1, min(15, int(profile.get("level", 1))))
    except (TypeError, ValueError):
        c.level = 1

    wanted = str(f.get("room") or c.room)
    if wanted not in HUB.rooms:
        wanted = "general"
    if wanted != c.room:
        c.room = wanted

    room = HUB.rooms[c.room]
    since = f.get("since") or 0
    try:
        since = int(since)
    except (TypeError, ValueError):
        since = 0

    with HUB.lock:
        history = [m for m in room.messages if since <= 0 or m["ts"] > since]
        if not history and since > 0:
            history = []
        history = history[-200:]

    c.send(
        {
            "t": "welcome",
            "v": 2,
            "you": c.public(),
            "rooms": HUB.room_list(),
            "room": room.meta(),
            "history": history,
            "members": HUB.members(c.room),
            "serverTime": int(time.time() * 1000),
        }
    )
    HUB.presence(c.room)


def handle_join(c: Client, f: dict) -> None:
    target = str(f.get("room") or "")
    if target not in HUB.rooms:
        c.send({"t": "error", "code": "bad_room", "message": "That room is gone."})
        return
    old = c.room
    c.room = target
    room = HUB.rooms[target]
    c.send(
        {
            "t": "welcome",
            "v": 2,
            "you": c.public(),
            "rooms": HUB.room_list(),
            "room": room.meta(),
            "history": list(room.messages),
            "members": HUB.members(target),
            "serverTime": int(time.time() * 1000),
        }
    )
    if old != target:
        HUB.presence(old)
    HUB.presence(target)


def handle_msg(c: Client, f: dict) -> None:
    now = time.time()
    c.hits.append(now)
    recent = [t for t in c.hits if now - t < 5.0]
    if len(recent) > 8:
        c.send({"t": "error", "code": "rate", "message": "Eight messages in five seconds. Sit on your hands."})
        return
    if len(recent) > 1 and (now - recent[-2]) < 0.45:
        c.send({"t": "error", "code": "rate", "message": "One at a time."})
        return

    text = clean(f.get("text"), MAX_TEXT)
    if not text:
        return
    mid = clean(f.get("id"), 64)
    if not mid or len(mid) < 6:
        return
    room = HUB.rooms.get(c.room)
    if not room:
        return
    if any(m["id"] == mid for m in room.messages):
        return

    reply_to = f.get("replyTo")
    if reply_to and not any(m["id"] == reply_to for m in room.messages):
        reply_to = None

    msg = {
        "id": mid,
        "room": room.id,
        "author": c.public(),
        "text": text,
        "ts": int(now * 1000),
        "replyTo": reply_to,
        "reactions": {},
    }
    with HUB.lock:
        room.messages.append(msg)
        HUB.dirty = True
    HUB.broadcast_room(room.id, {"t": "msg", "msg": msg})
    HUB.broadcast_all({"t": "rooms", "rooms": HUB.room_list()})


def handle_react(c: Client, f: dict) -> None:
    room = HUB.rooms.get(c.room)
    if not room:
        return
    emoji = clean(f.get("emoji"), 8)
    if not emoji:
        return
    msg = next((m for m in room.messages if m["id"] == f.get("msgId")), None)
    if not msg:
        return
    on = f.get("on") is not False
    reactions = msg.setdefault("reactions", {})
    if len(reactions) > 24 and emoji not in reactions:
        return
    who = set(reactions.get(emoji, []))
    if on:
        who.add(c.uid)
    else:
        who.discard(c.uid)
    if who:
        reactions[emoji] = sorted(who)
    else:
        reactions.pop(emoji, None)
    HUB.dirty = True
    HUB.broadcast_room(room.id, {"t": "react", "room": room.id, "msgId": msg["id"], "emoji": emoji, "by": c.uid, "on": on})


def handle_edit(c: Client, f: dict) -> None:
    room = HUB.rooms.get(c.room)
    if not room:
        return
    msg = next((m for m in room.messages if m["id"] == f.get("msgId")), None)
    if not msg or msg["author"]["id"] != c.uid:
        return
    text = clean(f.get("text"), MAX_TEXT)
    if not text:
        return
    msg["text"] = text
    msg["edited"] = int(time.time() * 1000)
    HUB.dirty = True
    HUB.broadcast_room(room.id, {"t": "edit", "msg": msg})


def handle_delete(c: Client, f: dict) -> None:
    room = HUB.rooms.get(c.room)
    if not room:
        return
    target = next((m for m in room.messages if m["id"] == f.get("msgId")), None)
    if not target or target["author"]["id"] != c.uid:
        return
    with HUB.lock:
        try:
            room.messages.remove(target)
        except ValueError:
            return
        HUB.dirty = True
    HUB.broadcast_room(room.id, {"t": "delete", "room": room.id, "msgId": target["id"]})


def handle_typing(c: Client, f: dict) -> None:
    HUB.broadcast_room(c.room, {"t": "typing", "room": c.room, "member": c.public(), "on": f.get("on") is not False})


def handle_profile(c: Client, f: dict) -> None:
    profile = f.get("profile") or {}
    name = clean(profile.get("name"), 24)
    if len(name) >= 2:
        c.name = name
    if "emoji" in profile:
        c.emoji = clean(profile.get("emoji"), 8) or None
    if "hue" in profile:
        try:
            c.hue = max(0, min(359, int(profile["hue"])))
        except (TypeError, ValueError):
            pass
    if "level" in profile:
        try:
            c.level = max(1, min(15, int(profile["level"])))
        except (TypeError, ValueError):
            pass
    HUB.presence(c.room)


def handle_create_room(c: Client, f: dict) -> None:
    if not rate_ok(_hb_hits, "room:" + c.addr[0], 5, 600):
        c.send({"t": "error", "code": "room_limit", "message": "Slow down on new rooms."})
        return
    rid = str(f.get("id") or "")
    name = clean(f.get("name"), 24) or rid
    if not ROOM_ID.match(rid):
        c.send({"t": "error", "code": "bad_room", "message": "Letters, numbers and dashes only."})
        return
    if rid in HUB.rooms:
        c.send({"t": "error", "code": "room_exists", "message": "That room already exists."})
        return
    if len(HUB.rooms) >= MAX_ROOMS:
        c.send({"t": "error", "code": "room_limit", "message": "Room limit reached."})
        return
    room = Room(
        {
            "id": rid,
            "name": name,
            "icon": clean(f.get("icon"), 8) or "💬",
            "topic": clean(f.get("topic"), 80) or "No topic yet.",
            "pinned": False,
            "created": int(time.time() * 1000),
            "by": c.name,
        }
    )
    with HUB.lock:
        HUB.rooms[rid] = room
        HUB.dirty = True
    HUB.broadcast_all({"t": "room", "room": room.meta()})
    HUB.broadcast_all({"t": "rooms", "rooms": HUB.room_list()})


HANDLERS = {
    "hello": handle_hello,
    "join": handle_join,
    "msg": handle_msg,
    "react": handle_react,
    "edit": handle_edit,
    "delete": handle_delete,
    "typing": handle_typing,
    "profile": handle_profile,
    "create_room": handle_create_room,
}


def serve_ws(handler: BaseHTTPRequestHandler) -> None:
    key = handler.headers.get("Sec-WebSocket-Key", "")
    if not key:
        handler.send_error(400, "Missing key")
        return
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    handler.send_response(101, "Switching Protocols")
    handler.send_header("Upgrade", "websocket")
    handler.send_header("Connection", "Upgrade")
    handler.send_header("Sec-WebSocket-Accept", accept)
    handler.end_headers()
    handler.wfile.flush()

    sock = handler.connection
    sock.settimeout(None)
    c = Client(sock, handler.client_address)
    HUB.add(c)

    try:
        while c.alive:
            frame = ws_read(sock)
            if frame is None:
                break
            opcode, payload = frame
            c.last = time.time()
            if opcode == 0x8:
                break
            if opcode == 0x9:
                with c.lock:
                    ws_send(sock, 0xA, payload)
                continue
            if opcode != 0x1:
                continue
            try:
                data = json.loads(payload.decode("utf-8", "replace"))
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            kind = data.get("t")
            if kind == "ping":
                c.send({"t": "pong", "ts": data.get("ts")})
                continue
            fn = HANDLERS.get(kind)
            if fn:
                try:
                    fn(c, data)
                except Exception as exc:  # noqa: BLE001 - one bad frame must not kill the room
                    print(f"[ws] handler {kind} failed: {exc}", file=sys.stderr)
    except (OSError, ConnectionError):
        pass
    finally:
        c.alive = False
        HUB.remove(c)
        try:
            sock.close()
        except OSError:
            pass


# ───────────────────────────────────────────────────────────────── http ──


class Handler(BaseHTTPRequestHandler):
    server_version = "NeegyTalk/2.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # quieter console
        if os.environ.get("NEEGY_VERBOSE"):
            super().log_message(fmt, *args)

    # ── helpers ─────────────────────────────────────────
    def cors(self) -> None:
        origin = os.environ.get("ALLOW_ORIGIN", "*")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")

    def json_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 8192:
            return {}
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
            return data if isinstance(data, dict) else {}
        except ValueError:
            return {}

    def send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.cors()
        self.end_headers()

    # ── routes ──────────────────────────────────────────
    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/ws" or path == "/ws/":
            if self.headers.get("Upgrade", "").lower() != "websocket":
                self.send_json(426, {"error": "upgrade_required"})
                return
            serve_ws(self)
            self.close_connection = True
            return
        if path == "/api/health":
            self.send_json(200, {"ok": True, "rooms": len(HUB.rooms), "clients": len(HUB.clients)})
            return
        if path.startswith("/api/room"):
            self.send_json(405, {"error": "method_not_allowed"})
            return
        self.serve_static(path)

    def do_HEAD(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        self.serve_static(path, head=True)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path != "/api/room":
            self.send_json(404, {"error": "not_found"})
            return

        api_key = os.environ.get("HYPERBEAM_API_KEY", "").strip()
        if not api_key:
            self.send_json(503, {"error": "not_configured", "message": "Set HYPERBEAM_API_KEY on the server."})
            return
        if not rate_ok(_hb_hits, "room-create:" + self.client_address[0], MAX_SESSIONS_PER_WINDOW, WINDOW_SECONDS):
            self.send_json(429, {"error": "rate_limited", "message": "Too many rooms. Wait a minute."})
            return

        body = self.json_body()
        region = str(body.get("region") or "NA").upper()
        if region not in REGIONS:
            region = "NA"
        start_url = body.get("start_url")
        if not isinstance(start_url, str) or not start_url.startswith(("http://", "https://")):
            start_url = "about:blank"

        payload = {
            "region": region,
            "start_url": start_url,
            "timeout": {"offline": 600, "idle": 900},
        }
        req = urllib.request.Request(
            HB_API,
            data=json.dumps(payload).encode(),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as exc:
            code = exc.code
            msg = "hyperbeam rejected the request"
            if code == 401:
                msg = "Hyperbeam key is not valid"
            elif code == 402:
                msg = "Hyperbeam account is out of credit"
            elif code == 429:
                msg = "Hyperbeam is rate limiting"
            self.send_json(502, {"error": "upstream", "status": code, "message": msg})
            return
        except (urllib.error.URLError, TimeoutError, ValueError):
            self.send_json(504, {"error": "upstream_timeout", "message": "Hyperbeam did not answer."})
            return

        self.send_json(
            200,
            {
                "session_id": data.get("session_id"),
                "embed_url": data.get("embed_url"),
                "admin_token": data.get("admin_token"),
            },
        )

    def do_DELETE(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if not path.startswith("/api/room/"):
            self.send_json(404, {"error": "not_found"})
            return
        session = path.rsplit("/", 1)[-1]
        if not re.match(r"^[A-Za-z0-9_.-]{4,80}$", session):
            self.send_json(400, {"error": "bad_session"})
            return
        api_key = os.environ.get("HYPERBEAM_API_KEY", "").strip()
        if not api_key:
            self.send_json(503, {"error": "not_configured"})
            return
        req = urllib.request.Request(
            f"{HB_API}/{session}",
            headers={"Authorization": f"Bearer {api_key}"},
            method="DELETE",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code not in (404, 410):
                self.send_json(502, {"error": "upstream", "status": exc.code})
                return
        except (urllib.error.URLError, TimeoutError):
            self.send_json(504, {"error": "upstream_timeout"})
            return
        self.send_json(200, {"ok": True})

    # ── static ──────────────────────────────────────────
    def serve_static(self, path: str, head: bool = False) -> None:
        rel = path.lstrip("/") or "index.html"
        target = (ROOT / rel).resolve()
        try:
            target.relative_to(ROOT)
        except ValueError:
            self.send_json(404, {"error": "not_found"})
            return
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            self.send_json(404, {"error": "not_found"})
            return
        parts = target.relative_to(ROOT).parts
        if parts[0] in PRIVATE or target.name.startswith("."):
            self.send_json(404, {"error": "not_found"})
            return

        ctype, _ = mimetypes.guess_type(str(target))
        if ctype is None:
            ctype = "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json", "image/svg+xml", "application/manifest+json"):
            ctype += "; charset=utf-8"
        size = target.stat().st_size

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        if rel.startswith("assets/"):
            self.send_header("Cache-Control", "public, max-age=3600")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.end_headers()
        if head:
            return
        with target.open("rb") as fh:
            while chunk := fh.read(64 * 1024):
                self.wfile.write(chunk)


def main() -> None:
    ap = argparse.ArgumentParser(description="Neegy-Talk server")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8080)
    args = ap.parse_args()

    threading.Thread(target=HUB.save_loop, daemon=True).start()
    threading.Thread(target=HUB.heartbeat, daemon=True).start()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    httpd.allow_reuse_address = True

    print(f"  Neegy-Talk  http://localhost:{args.port}")
    print(f"  chat        ws://localhost:{args.port}/ws")
    if not os.environ.get("HYPERBEAM_API_KEY"):
        print("  room        Hyperbeam key not set — /api/room returns 503")
    print("  ctrl-c to stop\n")

    def stop(*_):
        print("\n  shutting down")
        httpd.shutdown()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
