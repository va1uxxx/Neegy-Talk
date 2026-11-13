// Neegy-Talk :: chat state
// Takes protocol frames, keeps rooms/messages/members, emits typed events.
// The UI never talks to the socket directly.

import { MAX_TEXT, cleanText, roomId as toRoomId } from './protocol.js';
import { uid } from './dom.js';

const READ_KEY = 'neegy.read.v2';
const listeners = new Map();

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(READ_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeStore(v) {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

export class Chat {
  constructor({ transport, me, onError } = {}) {
    this.transport = transport;
    this.me = me;
    this.onError = onError || (() => {});
    this.rooms = [];
    this.room = null;
    this.messages = [];
    this.members = [];
    this.typing = new Map();
    this.unread = new Map();
    this.lastRead = readStore();
    this.status = 'idle';
    this.latency = 0;
    this.pending = new Set();
    this.typingSentAt = 0;
    this.typingOn = false;
    this.typingTimer = 0;
    this.ready = false;
  }

  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type).delete(fn);
  }

  emit(type, detail) {
    const set = listeners.get(type);
    if (set) for (const fn of set) fn(detail);
  }

  /* ---------- lifecycle ---------- */

  start(room = 'general') {
    this.wantRoom = room;
    this.transport.onFrame = (f) => this.frame(f);
    this.transport.onStatus = (s) => {
      this.status = s;
      if (s === 'open' || s === 'local') this.hello();
      this.emit('status', { status: s });
    };
    this.transport.onLatency = (ms) => {
      this.latency = ms;
      this.emit('latency', ms);
    };
    this.transport.connect();
  }

  hello() {
    const since = this.room ? this.messages[this.messages.length - 1]?.ts || 0 : 0;
    this.transport.send({
      t: 'hello',
      v: 2,
      room: this.wantRoom || this.room?.id || 'general',
      since,
      profile: this.profile()
    });
  }

  profile() {
    const s = this.me.state;
    return { id: s.id, name: s.name, emoji: s.emoji, hue: s.hue, level: this.me.level.n };
  }

  pushProfile() {
    this.transport.send({ t: 'profile', profile: this.profile() });
  }

  /* ---------- outbound ---------- */

  join(id) {
    if (!id || this.room?.id === id) return;
    this.wantRoom = id;
    this.messages = [];
    this.members = [];
    this.typing.clear();
    this.ready = false;
    this.emit('messages', this.messages);
    this.emit('presence', this.members);
    this.transport.send({ t: 'join', room: id });
  }

  send(text, replyTo = null) {
    const body = cleanText(text).trim();
    if (!body) return null;
    const id = uid(10);
    const msg = {
      id,
      room: this.room?.id,
      author: {
        id: this.me.state.id,
        name: this.me.state.name,
        emoji: this.me.state.emoji,
        hue: this.me.state.hue,
        level: this.me.level.n
      },
      text: body.slice(0, MAX_TEXT),
      ts: Date.now(),
      replyTo,
      reactions: {},
      mine: true,
      pending: true
    };
    this.pending.add(id);
    this.upsert(msg);
    this.emit('messages', this.messages);
    const ok = this.transport.send({ t: 'msg', id, text: msg.text, replyTo });
    if (!ok) {
      msg.failed = true;
      msg.pending = false;
      this.pending.delete(id);
      this.emit('messages', this.messages);
      this.onError({ code: 'offline', message: 'Not connected. Message not sent.' });
      return null;
    }
    return msg;
  }

  react(msgId, emoji, on) {
    this.transport.send({ t: 'react', msgId, emoji, on });
  }

  edit(msgId, text) {
    const body = cleanText(text).trim();
    if (!body) return;
    this.transport.send({ t: 'edit', msgId, text: body });
  }

  remove(msgId) {
    this.transport.send({ t: 'delete', msgId });
  }

  createRoom({ name, topic, icon }) {
    const id = toRoomId(name);
    if (!id) {
      this.onError({ code: 'bad_room', message: 'Pick a name with letters or numbers.' });
      return null;
    }
    this.transport.send({ t: 'create_room', id, name: name.trim().slice(0, 24), topic, icon });
    return id;
  }

  /* ---------- inbound ---------- */

  frame(f) {
    switch (f.t) {
      case 'welcome':
        this.ready = true;
        this.selfId = f.you?.id;
        this.rooms = Array.isArray(f.rooms) ? f.rooms : this.rooms;
        this.room = f.room || this.rooms[0] || null;
        this.messages = sortMessages(Array.isArray(f.history) ? f.history : []);
        for (const m of this.messages) {
          m.mine = m.author?.id === this.selfId;
          if (this.pending.has(m.id)) this.pending.delete(m.id);
          m.pending = false;
        }
        this.members = Array.isArray(f.members) ? f.members : [];
        this.computeUnread();
        this.markRead(this.room?.id);
        this.emit('rooms', this.rooms);
        this.emit('room', this.room);
        this.emit('messages', this.messages);
        this.emit('presence', this.members);
        this.emit('ready', { room: this.room, local: !!f.local });
        break;

      case 'msg': {
        const m = f.msg;
        if (!m || !m.id) return;
        if (this.room && m.room && m.room !== this.room.id) return;
        m.mine = m.author?.id === this.selfId;
        m.pending = false;
        this.pending.delete(m.id);
        this.upsert(m);
        if (!m.mine) this.bumpTyping(m.author?.id, false);
        this.emit('messages', this.messages);
        this.emit('message', m);
        if (document.hidden || !this.isFocused()) {
          if (!m.mine) this.bumpUnread(this.room?.id);
        } else {
          this.markRead(this.room?.id);
        }
        break;
      }

      case 'edit': {
        const m = this.messages.find((x) => x.id === f.msg?.id);
        if (m) {
          m.text = f.msg.text;
          m.edited = f.msg.edited || Date.now();
          this.emit('messages', this.messages);
          this.emit('message-edit', m);
        }
        break;
      }

      case 'delete':
        this.messages = this.messages.filter((m) => m.id !== f.msgId);
        this.emit('messages', this.messages);
        this.emit('delete', f.msgId);
        break;

      case 'react': {
        const m = this.messages.find((x) => x.id === f.msgId);
        if (!m) return;
        if (!m.reactions) m.reactions = {};
        const set = new Set(m.reactions[f.emoji] || []);
        if (f.on === false) set.delete(f.by);
        else set.add(f.by);
        if (set.size) m.reactions[f.emoji] = [...set];
        else delete m.reactions[f.emoji];
        this.emit('react', { msg: m, emoji: f.emoji, by: f.by, on: f.on !== false });
        break;
      }

      case 'presence':
        if (f.room && this.room && f.room !== this.room.id) return;
        this.members = Array.isArray(f.members) ? f.members : [];
        this.emit('presence', this.members);
        break;

      case 'typing':
        this.bumpTyping(f.member?.id, f.on, f.member);
        break;

      case 'rooms':
        this.rooms = Array.isArray(f.rooms) ? f.rooms : this.rooms;
        this.computeUnread();
        this.emit('rooms', this.rooms);
        break;

      case 'room': {
        const room = f.room;
        if (!room) return;
        const i = this.rooms.findIndex((r) => r.id === room.id);
        if (i >= 0) this.rooms[i] = { ...this.rooms[i], ...room };
        else this.rooms.push(room);
        this.rooms.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
        this.emit('rooms', this.rooms);
        this.emit('room-created', room);
        break;
      }

      case 'error':
        this.onError(f);
        break;

      default:
        break;
    }
  }

  /* ---------- helpers ---------- */

  upsert(m) {
    const i = this.messages.findIndex((x) => x.id === m.id);
    if (i >= 0) this.messages[i] = { ...this.messages[i], ...m, pending: false };
    else this.messages.push(m);
    this.messages.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    if (this.messages.length > 500) this.messages = this.messages.slice(-500);
  }

  bumpTyping(id, on, member) {
    if (!id) return;
    if (on) this.typing.set(id, { at: Date.now(), name: member?.name || '' });
    else this.typing.delete(id);
    this.emit('typing', [...this.typing.keys()]);
  }

  setTyping(on) {
    const now = Date.now();
    if (on) {
      if (this.typingOn && now - this.typingSentAt < 2500) return;
      this.typingSentAt = now;
      if (!this.typingOn) {
        this.typingOn = true;
        this.transport.send({ t: 'typing', on: true });
      }
      clearTimeout(this.typingTimer);
      this.typingTimer = setTimeout(() => this.setTyping(false), 4000);
    } else if (this.typingOn) {
      this.typingOn = false;
      clearTimeout(this.typingTimer);
      this.transport.send({ t: 'typing', on: false });
    }
  }

  isFocused() {
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  markRead(id) {
    if (!id) return;
    this.lastRead[id] = Date.now();
    writeStore(this.lastRead);
    if (this.unread.get(id)) {
      this.unread.delete(id);
      this.emit('rooms', this.rooms);
    }
  }

  bumpUnread(id) {
    if (!id) return;
    this.unread.set(id, (this.unread.get(id) || 0) + 1);
    this.emit('rooms', this.rooms);
  }

  computeUnread() {
    for (const r of this.rooms) {
      const seen = this.lastRead[r.id] || 0;
      const last = r.last?.ts || 0;
      if (last > seen && r.id !== this.room?.id) {
        if (!this.unread.has(r.id)) this.unread.set(r.id, 1);
      } else if (r.id !== this.room?.id) {
        this.unread.delete(r.id);
      }
    }
  }

  roomById(id) {
    return this.rooms.find((r) => r.id === id) || null;
  }
}

function sortMessages(list) {
  return list
    .filter((m) => m && typeof m.ts === 'number' && m.id)
    .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}
