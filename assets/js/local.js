// Neegy-Talk :: local hub
// Used when no chat server is reachable. Rooms, history and reactions live in
// localStorage; tabs on this browser talk over BroadcastChannel. It is a demo,
// not a server: other devices will not see it, and the UI says so.

import { SEED_ROOMS, levelFor } from './data.js';
import { uid } from './dom.js';
import { ME } from './me.js';

const ROOMS_KEY = 'neegy.rooms.v2';
const logKey = (room) => `neegy.log.${room}.v2`;
const TAB = uid(6);
const CHANNEL = 'neegy.chat.v2';
const BEACON_MS = 5000;
const PEER_TTL = 16000;

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

function loadRooms() {
  const saved = readJSON(ROOMS_KEY, null);
  const base = SEED_ROOMS.map((r) => ({ ...r }));
  if (!Array.isArray(saved)) return base;
  const ids = new Set(base.map((r) => r.id));
  for (const r of saved) {
    if (r && r.id && !ids.has(r.id)) base.push({ ...r });
  }
  return base;
}

function saveRooms(rooms) {
  writeJSON(
    ROOMS_KEY,
    rooms.filter((r) => !SEED_ROOMS.some((s) => s.id === r.id))
  );
}

function loadLog(room) {
  const raw = readJSON(logKey(room), []);
  return Array.isArray(raw) ? raw.slice(-200) : [];
}

function saveLog(room, list) {
  writeJSON(logKey(room), list.slice(-200));
}

export class LocalSocket {
  constructor({ onFrame, onStatus, onLatency } = {}) {
    this.onFrame = onFrame || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onLatency = onLatency || (() => {});
    this.room = 'general';
    this.rooms = loadRooms();
    this.peers = new Map();
    this.open = false;
    this.ch = null;
    this.beacon = 0;
    this.sweep = 0;
  }

  connect() {
    if (this.open) return;
    this.open = true;
    try {
      this.ch = new BroadcastChannel(CHANNEL);
      this.ch.onmessage = (ev) => this.receive(ev.data);
    } catch {
      this.ch = null;
    }
    this.onStatus('local');
    this.beacon = setInterval(() => this.sendBeacon(), BEACON_MS);
    this.sweep = setInterval(() => this.prunePeers(), 4000);
    this.sendBeacon();
  }

  close() {
    this.open = false;
    clearInterval(this.beacon);
    clearInterval(this.sweep);
    try {
      this.ch?.close();
    } catch {
      /* ignore */
    }
    this.ch = null;
    this.onStatus('closed');
  }

  send(obj) {
    if (!this.open || !obj) return false;
    switch (obj.t) {
      case 'ping':
        queueMicrotask(() => this.onFrame({ t: 'pong', ts: Date.now() }));
        return true;
      case 'hello':
        this.room = obj.room || 'general';
        queueMicrotask(() => this.welcome(obj.since));
        return true;
      case 'join':
        this.room = obj.room || this.room;
        queueMicrotask(() => this.welcome(0));
        return true;
      case 'msg':
        this.post(obj);
        return true;
      case 'typing':
        this.relay({ t: 'typing', room: this.room, on: !!obj.on, member: this.me() });
        return true;
      case 'react':
        this.post(obj);
        return true;
      case 'edit':
      case 'delete':
        this.post(obj);
        return true;
      case 'create_room':
        this.createRoom(obj);
        return true;
      case 'profile':
        this.sendBeacon();
        return true;
      default:
        return false;
    }
  }

  me() {
    const lvl = levelFor(ME.state.xp);
    return {
      id: ME.state.id,
      name: ME.state.name,
      emoji: ME.state.emoji,
      hue: ME.state.hue,
      level: lvl.n,
      room: this.room
    };
  }

  members() {
    const now = Date.now();
    const seen = new Map();
    const me = this.me();
    seen.set(me.id, me);
    for (const p of this.peers.values()) {
      if (now - p.ts < PEER_TTL && p.room === this.room && !seen.has(p.id)) seen.set(p.id, p);
    }
    return [...seen.values()];
  }

  welcome(since) {
    const log = loadLog(this.room);
    const after = since ? log.filter((m) => m.ts > since) : log;
    this.onFrame({
      t: 'welcome',
      you: this.me(),
      rooms: this.rooms,
      room: this.rooms.find((r) => r.id === this.room) || this.rooms[0],
      history: after,
      members: this.members(),
      serverTime: Date.now(),
      local: true
    });
  }

  post(obj) {
    const now = Date.now();
    const log = loadLog(this.room);

    if (obj.t === 'msg') {
      if (!obj.text || log.some((m) => m.id === obj.id)) return;
      const msg = {
        id: obj.id,
        room: this.room,
        author: this.me(),
        text: String(obj.text).slice(0, 2000),
        ts: now,
        replyTo: obj.replyTo || null,
        reactions: {}
      };
      log.push(msg);
      saveLog(this.room, log);
      this.onFrame({ t: 'msg', msg });
      this.relay({ t: 'msg', msg, from: ME.state.id });
    } else if (obj.t === 'react') {
      const msg = log.find((m) => m.id === obj.msgId);
      if (!msg) return;
      applyReact(msg, obj.emoji, ME.state.id, obj.on !== false);
      saveLog(this.room, log);
      this.onFrame({ t: 'react', room: this.room, msgId: msg.id, emoji: obj.emoji, by: ME.state.id, on: obj.on !== false });
      this.relay({ t: 'react', room: this.room, msgId: msg.id, emoji: obj.emoji, by: ME.state.id, on: obj.on !== false, from: ME.state.id });
    } else if (obj.t === 'edit') {
      const msg = log.find((m) => m.id === obj.msgId);
      if (!msg || msg.author.id !== ME.state.id) return;
      msg.text = String(obj.text || '').slice(0, 2000);
      msg.edited = now;
      saveLog(this.room, log);
      this.onFrame({ t: 'edit', msg });
      this.relay({ t: 'edit', msg, from: ME.state.id });
    } else if (obj.t === 'delete') {
      const idx = log.findIndex((m) => m.id === obj.msgId);
      if (idx < 0 || log[idx].author.id !== ME.state.id) return;
      log.splice(idx, 1);
      saveLog(this.room, log);
      this.onFrame({ t: 'delete', room: this.room, msgId: obj.msgId });
      this.relay({ t: 'delete', room: this.room, msgId: obj.msgId, from: ME.state.id });
    }
  }

  createRoom(obj) {
    const name = String(obj.name || '').trim().slice(0, 24);
    if (!name) {
      this.onFrame({ t: 'error', code: 'bad_room', message: 'Room needs a name.' });
      return;
    }
    const id = String(obj.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 24);
    if (this.rooms.some((r) => r.id === id)) {
      this.onFrame({ t: 'error', code: 'room_exists', message: 'Room already exists.' });
      return;
    }
    const room = {
      id,
      name,
      icon: obj.icon || '💬',
      topic: String(obj.topic || 'No topic yet.').slice(0, 80),
      pinned: false,
      created: Date.now(),
      by: ME.state.name
    };
    this.rooms.push(room);
    saveRooms(this.rooms);
    this.onFrame({ t: 'room', room });
    this.onFrame({ t: 'rooms', rooms: this.rooms });
    this.relay({ t: 'room', room, from: ME.state.id });
  }

  relay(frame) {
    try {
      this.ch?.postMessage({ from: TAB, frame });
    } catch {
      /* channel closed */
    }
  }

  sendBeacon() {
    const me = this.me();
    this.peers.set(TAB, { ...me, ts: Date.now(), self: true });
    this.relay({ t: 'beacon', member: me, from: TAB });
    this.onFrame({ t: 'presence', room: this.room, members: this.members() });
  }

  prunePeers() {
    const now = Date.now();
    let changed = false;
    for (const [k, p] of this.peers) {
      if (!p.self && now - p.ts > PEER_TTL) {
        this.peers.delete(k);
        changed = true;
      }
    }
    if (changed) this.onFrame({ t: 'presence', room: this.room, members: this.members() });
  }

  receive(data) {
    if (!data || data.from === TAB) return;
    if (data.t === 'beacon' && data.member) {
      this.peers.set(data.from, { ...data.member, ts: Date.now() });
      this.onFrame({ t: 'presence', room: this.room, members: this.members() });
      return;
    }
    const f = data.frame;
    if (!f) return;
    if (f.t === 'msg' || f.t === 'edit' || f.t === 'delete' || f.t === 'react' || f.t === 'room') {
      this.onFrame(f);
    }
  }
}

function applyReact(msg, emoji, who, on) {
  if (!msg.reactions) msg.reactions = {};
  const set = new Set(msg.reactions[emoji] || []);
  if (on) set.add(who);
  else set.delete(who);
  if (set.size) msg.reactions[emoji] = [...set];
  else delete msg.reactions[emoji];
}
