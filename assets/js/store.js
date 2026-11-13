// Neegy-Talk :: progress store
// Everything lives in localStorage. No accounts, no backend, no telemetry.

import { XP, LORE, QUEST_POOL, LEVELS, MAX_LEVEL, levelFor, nextLevel, progress } from './data.js';

const KEY = 'neegy.state.v1';

const pad = (n) => String(n).padStart(2, '0');
export function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function defaultState() {
  return {
    v: 1,
    xp: 0,
    level: 1,
    name: null,
    createdAt: Date.now(),
    lastSeen: null,
    visits: 0,
    topics: [],
    lore: [],
    quests: { date: null, list: [] },
    checkin: { last: null, streak: 0 },
    room: { lastOpen: 0, minutesToday: 0, date: null },
    stats: { msgs: 0, words: [], longMsgs: 0 },
    daily: { date: null, chatXp: 0 },
    settings: { sound: true, reduced: false }
  };
}

function migrate(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const s = { ...base, ...raw };
  s.stats = { ...base.stats, ...(raw.stats || {}) };
  s.quests = { ...base.quests, ...(raw.quests || {}) };
  s.checkin = { ...base.checkin, ...(raw.checkin || {}) };
  s.room = { ...base.room, ...(raw.room || {}) };
  s.daily = { ...base.daily, ...(raw.daily || {}) };
  s.settings = { ...base.settings, ...(raw.settings || {}) };
  s.topics = Array.isArray(s.topics) ? s.topics : [];
  s.lore = Array.isArray(s.lore) ? s.lore : [];
  s.stats.words = Array.isArray(s.stats.words) ? s.stats.words : [];
  s.xp = Number(s.xp) || 0;
  s.level = levelFor(s.xp).n;
  return s;
}

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rollQuests(date) {
  const rand = mulberry32(hash32('neegy:' + date));
  const pool = QUEST_POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3).map((q) => ({ ...q, progress: 0, done: false }));
}

export function createStore() {
  let state = migrate(safeRead());
  const listeners = new Map(); // event type -> Set<fn>, '*' receives everything

  function emit(type, detail) {
    const safe = (fn, args) => {
      try { fn(...args); } catch (e) { console.error('[neegy] listener failed', e); }
    };
    const typed = listeners.get(type);
    if (typed) for (const fn of typed) safe(fn, [detail, state]);
    const all = listeners.get('*');
    if (all) for (const fn of all) safe(fn, [type, detail, state]);
  }

  function safeRead() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn('[neegy] could not read saved progress', e);
      return null;
    }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { console.warn('[neegy] could not save progress', e); }
  }

  function touchDaily() {
    const today = todayKey();
    if (state.daily.date !== today) {
      state.daily = { date: today, chatXp: 0 };
    }
    if (state.room.date !== today) {
      state.room.date = today;
      state.room.minutesToday = 0;
    }
    if (state.quests.date !== today) {
      state.quests = { date: today, list: rollQuests(today) };
      emit('quests', null);
    }
  }

  function award(n, reason) {
    if (!n) return 0;
    const before = state.level;
    state.xp += n;
    const target = levelFor(state.xp).n;
    let ups = 0;
    while (state.level < target) {
      state.level++;
      ups++;
      const l = LEVELS.find((x) => x.n === state.level);
      emit('levelup', l);
    }
    emit('xp', { amount: n, reason });
    if (ups === 0 && state.level !== before) emit('change');
    save();
    return n;
  }

  function bumpQuest(kind, amount) {
    let changed = false;
    for (const q of state.quests.list) {
      if (q.kind !== kind || q.done) continue;
      q.progress = Math.min(q.target, q.progress + amount);
      if (q.progress >= q.target) {
        q.done = true;
        changed = true;
        emit('questDone', q);
        award(q.xp, 'quest:' + q.id);
      }
    }
    if (changed) save();
    return changed;
  }

  const api = {
    get state() { return state; },

    /** on(type, fn) or on(fn) for everything. Returns an unsubscribe function. */
    on(type, fn) {
      if (typeof type === 'function') { fn = type; type = '*'; }
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => { const s = listeners.get(type); if (s) s.delete(fn); };
    },

    init() {
      touchDaily();
      const today = todayKey();
      state.visits++;
      state.returning = state.lastSeen === today;
      state.lastSeen = today;
      save();
      emit('change');
      return state;
    },

    levelInfo() {
      return { level: levelFor(state.xp), next: nextLevel(levelFor(state.xp).n), prog: progress(state.xp) };
    },

    award,

    checkIn() {
      const today = todayKey();
      if (state.checkin.last === today) return { ok: false, streak: state.checkin.streak, xp: 0 };
      const y = new Date();
      y.setDate(y.getDate() - 1);
      const yesterday = todayKey(y);
      state.checkin.streak = state.checkin.last === yesterday ? state.checkin.streak + 1 : 1;
      state.checkin.last = today;
      const bonus = Math.min(XP.checkinStreakCap, (state.checkin.streak - 1) * XP.checkinStreakBonus);
      const total = XP.checkin + bonus;
      award(total, 'checkin');
      bumpQuest('checkin', 1);
      save();
      return { ok: true, streak: state.checkin.streak, xp: total };
    },

    checkedInToday() {
      return state.checkin.last === todayKey();
    },

    /** Register a chat message. Returns xp earned. */
    recordMessage(text, now = Date.now()) {
      touchDaily();
      state.stats.msgs++;
      bumpQuest('msg', 1);

      if (text.length > 40) {
        state.stats.longMsgs++;
        bumpQuest('longMsg', 1);
      }

      const words = new Set(state.stats.words);
      const tokens = text.toLowerCase().match(/[a-z']{2,}/g) || [];
      const fresh = [];
      for (const w of tokens) {
        if (!words.has(w)) { words.add(w); fresh.push(w); }
      }
      if (fresh.length) {
        state.stats.words = Array.from(words).slice(-2000);
        bumpQuest('word', fresh.length);
        // small drip for vocabulary, capped by the chat cap below
        if (state.daily.chatXp + fresh.length <= XP.chatDailyCap) {
          state.daily.chatXp += Math.min(fresh.length, 5);
          award(Math.min(fresh.length, 5), 'words');
        }
      }

      let earned = 0;
      if (state.daily.chatXp < XP.chatDailyCap) {
        const since = now - (state.lastChatXp || 0);
        if (since >= XP.chatCooldownMs) {
          state.lastChatXp = now;
          state.daily.chatXp += XP.chat;
          earned += award(XP.chat, 'chat');
        }
      }
      save();
      return earned;
    },

    /** Register newly mentioned topics. Returns xp earned. */
    recordTopics(ids) {
      let earned = 0;
      let fresh = 0;
      for (const id of ids) {
        if (state.topics.includes(id)) continue;
        state.topics.push(id);
        fresh++;
        earned += award(XP.topic, 'topic:' + id);
      }
      if (fresh) bumpQuest('topic', fresh);
      save();
      return earned;
    },

    readLore(id) {
      const entry = LORE.find((l) => l.id === id);
      if (!entry) return 0;
      if (state.lore.includes(id)) return 0;
      state.lore.push(id);
      const got = award(XP.lore, 'lore');
      bumpQuest('lore', 1);
      save();
      return got;
    },

    isLoreRead(id) { return state.lore.includes(id); },
    unlockedLore() { return LORE.filter((l) => l.at <= state.level); },

    quests() { touchDaily(); return state.quests; },

    roomAvailableAt() { return 2; },
    roomUnlocked() { return state.level >= 2; },
    roomOpenXpReady(now = Date.now()) {
      return now - state.room.lastOpen >= XP.roomOpenCooldownMs;
    },
    markRoomOpen(now = Date.now()) {
      touchDaily();
      state.room.lastOpen = now;
      let earned = 0;
      if (now - (state.room.lastOpenXpAt || 0) >= XP.roomOpenCooldownMs) {
        state.room.lastOpenXpAt = now;
        earned += award(XP.roomOpen, 'room');
      }
      save();
      return earned;
    },
    addRoomMinutes(minutes = 1) {
      touchDaily();
      if (state.room.minutesToday >= XP.roomMinuteCap) return 0;
      const add = Math.min(minutes, XP.roomMinuteCap - state.room.minutesToday);
      state.room.minutesToday += add;
      const earned = award(XP.roomMinute * add, 'roomTime');
      bumpQuest('roomMin', add);
      save();
      return earned;
    },

    setSetting(k, v) { state.settings[k] = v; save(); emit('change'); },

    setName(name) {
      if (!name) return;
      state.name = name;
      save();
      emit('change');
    },

    reset() {
      state = defaultState();
      try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
      touchDaily();
      emit('change');
      save();
    },

    exportJSON() { return JSON.stringify(state, null, 2); },
    importJSON(text) {
      const raw = JSON.parse(text);
      state = migrate(raw);
      touchDaily();
      save();
      emit('change');
      return state;
    },

    MAX_LEVEL
  };

  touchDaily();
  return api;
}
