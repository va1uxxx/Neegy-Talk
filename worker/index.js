// Neegy-Talk :: Cloudflare Worker
// One Durable Object holds every room, so presence, the room list, and
// cross-room broadcast stay consistent. Sockets use the hibernation API, so an
// idle room costs nothing and a busy one is still a single ordered writer.
//
//   /ws            WebSocket chat
//   /api/rooms     room list as JSON
//   /api/room      POST create Hyperbeam VM, DELETE /api/room/:id
//   everything else is served from the assets binding.

const SEED_ROOMS = [
  { id: 'general', name: 'general', icon: '💬', topic: 'Anything. Start here.', pinned: true },
  { id: 'intros', name: 'intros', icon: '👋', topic: 'Who you are, once.', pinned: true },
  { id: 'offtopic', name: 'off-topic', icon: '🌀', topic: 'The other ninety percent.', pinned: true },
  { id: 'music', name: 'music', icon: '🎧', topic: 'What is on loop right now.', pinned: false },
  { id: 'help', name: 'help', icon: '🛠️', topic: 'Ask, answer, move on.', pinned: false }
];

const MAX_ROOMS = 40;
const MAX_TEXT = 2000;
const HISTORY = 200;
const PERSIST = 120;
const ROOM_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
const UID = /^[a-z0-9]{6,40}$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const HB_API = 'https://engine.hyperbeam.com/v0/vm';

const clean = (v, n) => String(v ?? '').replace(CONTROL, '').slice(0, n).trim();
const intIn = (v, lo, hi, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const newId = (prefix) => prefix + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, '0')).join('');

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws' || url.pathname === '/ws/') {
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return json({ error: 'upgrade_required' }, 426);
      }
      return env.CHAT.get(env.CHAT.idFromName('hub')).fetch(request);
    }

    if (url.pathname === '/api/rooms') {
      return env.CHAT.get(env.CHAT.idFromName('hub')).fetch('https://chat/rooms');
    }

    if (url.pathname === '/api/room' || url.pathname.startsWith('/api/room/')) {
      return hyperbeam(request, url, env);
    }

    return env.ASSETS.fetch(request);
  }
};

/* ── Hyperbeam proxy: the key never leaves the worker ─────────────────── */

async function hyperbeam(request, url, env) {
  const key = env.HYPERBEAM_API_KEY;
  if (!key) return json({ error: 'not_configured', message: 'Set HYPERBEAM_API_KEY.' }, 503);

  if (request.method === 'POST' && url.pathname === '/api/room') {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const region = ['NA', 'EU', 'AS'].includes(String(body.region || '').toUpperCase()) ? String(body.region).toUpperCase() : 'NA';
    const start = typeof body.start_url === 'string' && /^https?:\/\//.test(body.start_url) ? body.start_url : 'about:blank';
    const upstream = await fetch(HB_API, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ region, start_url: start, timeout: { offline: 600, idle: 900 } })
    });
    const text = await upstream.text();
    if (!upstream.ok) return json({ error: 'upstream', status: upstream.status, message: upstream.status === 401 ? 'Hyperbeam key is not valid' : 'Hyperbeam rejected the request' }, 502);
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      return json({ error: 'upstream_bad_json' }, 502);
    }
    return json({ session_id: data.session_id, embed_url: data.embed_url, admin_token: data.admin_token });
  }

  if (request.method === 'DELETE' && url.pathname.startsWith('/api/room/')) {
    const session = url.pathname.split('/').pop();
    if (!/^[A-Za-z0-9_.-]{4,80}$/.test(session)) return json({ error: 'bad_session' }, 400);
    const upstream = await fetch(`${HB_API}/${session}`, { method: 'DELETE', headers: { authorization: `Bearer ${key}` } });
    if (!upstream.ok && upstream.status !== 404 && upstream.status !== 410) {
      return json({ error: 'upstream', status: upstream.status }, 502);
    }
    return json({ ok: true });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

/* ── the hub ──────────────────────────────────────────────────────────── */

export class Chat {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = null;
    this.cache = new Map();
    this.hits = new Map();
    this.loading = null;
  }

  /* storage */

  load() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const saved = await this.state.storage.get('meta');
      const rooms = new Map();
      for (const r of SEED_ROOMS) rooms.set(r.id, { ...r, created: 0, by: 'system' });
      if (Array.isArray(saved?.rooms)) {
        for (const r of saved.rooms) {
          if (r && typeof r.id === 'string' && ROOM_ID.test(r.id)) rooms.set(r.id, r);
        }
      }
      this.rooms = rooms;
    })();
    return this.loading;
  }

  async messages(room) {
    if (this.cache.has(room)) return this.cache.get(room);
    const saved = await this.state.storage.get('room:' + room);
    const list = Array.isArray(saved) ? saved.slice(-HISTORY) : [];
    this.cache.set(room, list);
    return list;
  }

  saveMeta() {
    return this.state.storage.put('meta', { rooms: [...this.rooms.values()] });
  }

  saveRoom(id) {
    const list = this.cache.get(id) || [];
    return this.state.storage.put('room:' + id, list.slice(-PERSIST));
  }

  /* views */

  meta(room) {
    const list = room.id ? this.cache.get(room.id) || [] : [];
    const last = list[list.length - 1];
    return {
      id: room.id,
      name: room.name,
      icon: room.icon,
      topic: room.topic,
      pinned: !!room.pinned,
      created: room.created || 0,
      last: last ? { ts: last.ts, author: last.author.name, text: String(last.text).slice(0, 70) } : null
    };
  }

  async roomList() {
    const list = [...this.rooms.values()].map((r) => this.meta(r));
    list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
    return list;
  }

  sockets() {
    return this.state.getWebSockets();
  }

  people() {
    const seen = new Map();
    for (const ws of this.sockets()) {
      const a = ws.deserializeAttachment();
      if (!a || !a.uid) continue;
      if (!seen.has(a.uid)) seen.set(a.uid, { id: a.uid, name: a.name, emoji: a.emoji, hue: a.hue, level: a.level, room: a.room });
    }
    return [...seen.values()];
  }

  members(room) {
    return this.people().filter((p) => p.room === room).map(({ room: _r, ...rest }) => rest);
  }

  send(ws, frame) {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* socket already gone */
    }
  }

  toRoom(room, frame, except = null) {
    const data = JSON.stringify(frame);
    for (const ws of this.sockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment();
      if (!a || a.room !== room) continue;
      try {
        ws.send(data);
      } catch {
        /* drop it */
      }
    }
  }

  toAll(frame, except = null) {
    const data = JSON.stringify(frame);
    for (const ws of this.sockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        /* drop it */
      }
    }
  }

  presence(room) {
    this.toRoom(room, { t: 'presence', room, members: this.members(room) });
  }

  /* entry */

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);

    if (url.pathname === '/rooms') return json({ rooms: await this.roomList() });

    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return json({ error: 'upgrade_required' }, 426);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({
      cid: newId('c_'),
      uid: null,
      name: 'guest',
      emoji: null,
      hue: 250,
      level: 1,
      room: 'general'
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  /* frames */

  async webSocketMessage(ws, raw) {
    await this.load();
    let frame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    const fn = this.handlers[frame.t];
    if (!fn) return;
    try {
      await fn.call(this, ws, frame);
    } catch (err) {
      this.send(ws, { t: 'error', code: 'internal', message: 'That did not go through.' });
    }
  }

  async webSocketClose(ws) {
    const a = ws.deserializeAttachment();
    try {
      ws.close(1000, 'bye');
    } catch {
      /* already closed */
    }
    if (!a) return;
    await this.load();
    this.presence(a.room);
    this.toAll({ t: 'rooms', rooms: await this.roomList() });
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  handlers = {
    async ping(ws, f) {
      this.send(ws, { t: 'pong', ts: f.ts });
    },

    async hello(ws, f) {
      const a = ws.deserializeAttachment();
      const profile = f.profile && typeof f.profile === 'object' ? f.profile : {};
      const name = clean(profile.name, 24);
      if (name.length >= 2) a.name = name;
      else if (!a.uid) a.name = 'guest-' + a.cid.slice(2, 6);
      const supplied = clean(profile.id, 40);
      if (UID.test(supplied)) a.uid = supplied.toLowerCase();
      else if (!a.uid) a.uid = newId('u_');
      if ('emoji' in profile) a.emoji = clean(profile.emoji, 8) || null;
      a.hue = intIn(profile.hue, 0, 359, a.hue);
      a.level = intIn(profile.level, 1, 15, a.level);

      let room = clean(f.room, 24) || a.room;
      if (!this.rooms.has(room)) room = 'general';
      a.room = room;
      ws.serializeAttachment(a);

      const list = await this.messages(room);
      const since = intIn(f.since, 0, Number.MAX_SAFE_INTEGER, 0);
      const history = since > 0 ? list.filter((m) => m.ts > since) : list.slice(-HISTORY);

      this.send(ws, {
        t: 'welcome',
        v: 2,
        you: { id: a.uid, name: a.name, emoji: a.emoji, hue: a.hue, level: a.level },
        rooms: await this.roomList(),
        room: this.meta(this.rooms.get(room)),
        history,
        members: this.members(room),
        serverTime: Date.now()
      });
      this.presence(room);
    },

    async join(ws, f) {
      const a = ws.deserializeAttachment();
      const target = clean(f.room, 24);
      if (!this.rooms.has(target)) {
        this.send(ws, { t: 'error', code: 'bad_room', message: 'That room is gone.' });
        return;
      }
      const old = a.room;
      a.room = target;
      ws.serializeAttachment(a);
      const list = await this.messages(target);
      this.send(ws, {
        t: 'welcome',
        v: 2,
        you: { id: a.uid, name: a.name, emoji: a.emoji, hue: a.hue, level: a.level },
        rooms: await this.roomList(),
        room: this.meta(this.rooms.get(target)),
        history: list.slice(-HISTORY),
        members: this.members(target),
        serverTime: Date.now()
      });
      if (old !== target) this.presence(old);
      this.presence(target);
    },

    async msg(ws, f) {
      const a = ws.deserializeAttachment();
      if (!a.uid) return;
      if (!this.rateOk(a.cid)) {
        this.send(ws, { t: 'error', code: 'rate', message: 'One at a time.' });
        return;
      }
      const text = clean(f.text, MAX_TEXT);
      const id = clean(f.id, 64);
      if (!text || id.length < 6) return;
      const room = this.rooms.get(a.room);
      if (!room) return;
      const list = await this.messages(a.room);
      if (list.some((m) => m.id === id)) return;

      let replyTo = null;
      if (f.replyTo && list.some((m) => m.id === f.replyTo)) replyTo = f.replyTo;

      const msg = {
        id,
        room: a.room,
        author: { id: a.uid, name: a.name, emoji: a.emoji, hue: a.hue, level: a.level },
        text,
        ts: Date.now(),
        replyTo,
        reactions: {}
      };
      list.push(msg);
      if (list.length > HISTORY) list.splice(0, list.length - HISTORY);
      this.state.waitUntil(this.saveRoom(a.room));
      this.toRoom(a.room, { t: 'msg', msg });
      this.toAll({ t: 'rooms', rooms: await this.roomList() }, ws);
      this.send(ws, { t: 'rooms', rooms: await this.roomList() });
    },

    async react(ws, f) {
      const a = ws.deserializeAttachment();
      if (!a.uid) return;
      const emoji = clean(f.emoji, 8);
      if (!emoji) return;
      const list = await this.messages(a.room);
      const msg = list.find((m) => m.id === f.msgId);
      if (!msg) return;
      const on = f.on !== false;
      const reactions = (msg.reactions ||= {});
      if (Object.keys(reactions).length > 24 && !reactions[emoji]) return;
      const who = new Set(reactions[emoji] || []);
      if (on) who.add(a.uid);
      else who.delete(a.uid);
      if (who.size) reactions[emoji] = [...who].sort();
      else delete reactions[emoji];
      this.state.waitUntil(this.saveRoom(a.room));
      this.toRoom(a.room, { t: 'react', room: a.room, msgId: msg.id, emoji, by: a.uid, on });
    },

    async edit(ws, f) {
      const a = ws.deserializeAttachment();
      const list = await this.messages(a.room);
      const msg = list.find((m) => m.id === f.msgId);
      if (!msg || msg.author.id !== a.uid) return;
      const text = clean(f.text, MAX_TEXT);
      if (!text) return;
      msg.text = text;
      msg.edited = Date.now();
      this.state.waitUntil(this.saveRoom(a.room));
      this.toRoom(a.room, { t: 'edit', msg });
    },

    async delete(ws, f) {
      const a = ws.deserializeAttachment();
      const list = await this.messages(a.room);
      const i = list.findIndex((m) => m.id === f.msgId);
      if (i < 0 || list[i].author.id !== a.uid) return;
      list.splice(i, 1);
      this.state.waitUntil(this.saveRoom(a.room));
      this.toRoom(a.room, { t: 'delete', room: a.room, msgId: f.msgId });
    },

    async typing(ws, f) {
      const a = ws.deserializeAttachment();
      this.toRoom(
        a.room,
        { t: 'typing', room: a.room, member: { id: a.uid, name: a.name, emoji: a.emoji, hue: a.hue, level: a.level }, on: f.on !== false },
        ws
      );
    },

    async profile(ws, f) {
      const a = ws.deserializeAttachment();
      const profile = f.profile && typeof f.profile === 'object' ? f.profile : {};
      const name = clean(profile.name, 24);
      if (name.length >= 2) a.name = name;
      if ('emoji' in profile) a.emoji = clean(profile.emoji, 8) || null;
      a.hue = intIn(profile.hue, 0, 359, a.hue);
      a.level = intIn(profile.level, 1, 15, a.level);
      ws.serializeAttachment(a);
      this.presence(a.room);
    },

    async create_room(ws, f) {
      const a = ws.deserializeAttachment();
      if (!this.rateOk('room:' + a.cid, 5, 600_000)) {
        this.send(ws, { t: 'error', code: 'room_limit', message: 'Slow down on new rooms.' });
        return;
      }
      const id = clean(f.id, 24);
      if (!ROOM_ID.test(id)) {
        this.send(ws, { t: 'error', code: 'bad_room', message: 'Letters, numbers and dashes only.' });
        return;
      }
      if (this.rooms.has(id)) {
        this.send(ws, { t: 'error', code: 'room_exists', message: 'That room already exists.' });
        return;
      }
      if (this.rooms.size >= MAX_ROOMS) {
        this.send(ws, { t: 'error', code: 'room_limit', message: 'Room limit reached.' });
        return;
      }
      const room = {
        id,
        name: clean(f.name, 24) || id,
        icon: clean(f.icon, 8) || '💬',
        topic: clean(f.topic, 80) || 'No topic yet.',
        pinned: false,
        created: Date.now(),
        by: a.name
      };
      this.rooms.set(id, room);
      this.cache.set(id, []);
      await this.saveMeta();
      const meta = this.meta(room);
      this.toAll({ t: 'room', room: meta });
      this.toAll({ t: 'rooms', rooms: await this.roomList() });
    }
  };

  /** Sliding window: 8 frames per 5s, and no two closer than 450ms. */
  rateOk(key, limit = 8, windowMs = 5000) {
    const now = Date.now();
    const hits = (this.hits.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
      this.hits.set(key, hits);
      return false;
    }
    if (hits.length && now - hits[hits.length - 1] < 450) {
      this.hits.set(key, hits);
      return false;
    }
    hits.push(now);
    this.hits.set(key, hits);
    if (this.hits.size > 500) this.hits.delete(this.hits.keys().next().value);
    return true;
  }
}
