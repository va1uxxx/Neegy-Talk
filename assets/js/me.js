// Neegy-Talk :: you
// Name, avatar, level, streaks. All local to this browser.

import { LEVELS, XP, levelFor, nextLevel, progress } from './data.js';
import { uid, clamp, hueFrom } from './dom.js';

const KEY = 'neegy.me.v2';
const listeners = new Set();

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fresh() {
  const id = uid(8);
  return {
    id,
    name: 'guest-' + id.slice(0, 4),
    hue: hueFrom(id),
    emoji: null,
    xp: 0,
    xpDay: today(),
    xpToday: { message: 0, reactionGiven: 0, reactionReceived: 0 },
    lastMsgAt: 0,
    streak: 0,
    lastVisit: '',
    seenRooms: [],
    muted: false,
    createdAt: Date.now()
  };
}

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fresh();
    const base = fresh();
    const merged = { ...base, ...parsed };
    merged.xpToday = { ...base.xpToday, ...(parsed.xpToday || {}) };
    merged.seenRooms = Array.isArray(parsed.seenRooms) ? parsed.seenRooms.slice(0, 60) : [];
    merged.xp = Math.max(0, Number(merged.xp) || 0);
    merged.hue = clamp(Number(merged.hue) || base.hue, 0, 359);
    merged.streak = Math.max(0, Number(merged.streak) || 0);
    return merged;
  } catch {
    return fresh();
  }
}

const state = read();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* quota or private mode: keep in memory */
  }
}

function emit(detail = {}) {
  save();
  for (const fn of listeners) {
    try {
      fn(state, detail);
    } catch (err) {
      console.error(err);
    }
  }
}

export const ME = {
  get state() {
    return state;
  },
  get level() {
    return levelFor(state.xp);
  },
  get progress() {
    return progress(state.xp);
  },
  get next() {
    return nextLevel(levelFor(state.xp).n);
  },
  get isMax() {
    return levelFor(state.xp).n >= LEVELS[LEVELS.length - 1].n;
  },
  get displayName() {
    return state.name;
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  setName(name) {
    const next = String(name).trim().slice(0, 24);
    if (!next || next === state.name) return false;
    state.name = next;
    emit({ reason: 'name' });
    return true;
  },

  setEmoji(emoji) {
    state.emoji = emoji || null;
    emit({ reason: 'avatar' });
  },

  setHue(hue) {
    state.hue = clamp(Math.round(Number(hue) || 0), 0, 359);
    emit({ reason: 'avatar' });
  },

  /** Roll the daily counters, return anything earned while away. */
  tick() {
    const now = today();
    if (state.xpDay === now) return { visit: 0, streak: state.streak, fresh: false };
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const y = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    state.streak = state.lastVisit === y ? state.streak + 1 : 1;
    state.lastVisit = now;
    state.xpDay = now;
    state.xpToday = { message: 0, reactionGiven: 0, reactionReceived: 0 };
    const bonus = Math.min((state.streak - 1) * XP.streakBonus, XP.streakCap);
    const gained = XP.dailyVisit + bonus;
    state.xp += gained;
    emit({ reason: 'daily', gained });
    return { visit: gained, streak: state.streak, fresh: true };
  },

  /** @param {'message'|'reactionGiven'|'reactionReceived'|'room'|'fixed'} kind */
  award(kind, amount = 0, meta = {}) {
    if (kind === 'message') {
      const now = Date.now();
      if (now - state.lastMsgAt < XP.messageCooldownMs) return null;
      if (state.xpToday.message >= XP.messageDailyCap) return null;
      state.lastMsgAt = now;
      state.xpToday.message += 1;
      amount = XP.message;
    } else if (kind === 'reactionGiven') {
      if (state.xpToday.reactionGiven >= XP.reactionGivenDailyCap) return null;
      state.xpToday.reactionGiven += 1;
      amount = XP.reactionGiven;
    } else if (kind === 'reactionReceived') {
      if (state.xpToday.reactionReceived >= XP.reactionReceivedDailyCap) return null;
      state.xpToday.reactionReceived += 1;
      amount = XP.reactionReceived;
    } else if (kind === 'room') {
      amount = XP.newRoomBonus;
    }

    if (!amount) return null;
    const before = levelFor(state.xp).n;
    state.xp += amount;
    const after = levelFor(state.xp).n;
    const detail = { reason: kind, gained: amount, levelUp: after > before ? after : 0, ...meta };
    emit(detail);
    return detail;
  },

  markRoom(id) {
    if (state.seenRooms.includes(id)) return false;
    state.seenRooms = [id, ...state.seenRooms].slice(0, 60);
    save();
    return true;
  },

  hasRoom(id) {
    return state.seenRooms.includes(id);
  },

  export() {
    return JSON.stringify({ version: 2, profile: state }, null, 2);
  },

  reset() {
    Object.assign(state, fresh());
    emit({ reason: 'reset' });
  }
};
