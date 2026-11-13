// Neegy-Talk :: wire protocol
// One JSON object per frame. The server is authoritative for author, time,
// and room membership; the client owns message ids.

export const PROTOCOL_VERSION = 2;
export const MAX_TEXT = 2000;
export const MAX_NAME = 24;
export const MAX_ROOM_NAME = 24;
export const MAX_TOPIC = 80;

export const C2S = Object.freeze({
  HELLO: 'hello',
  MSG: 'msg',
  TYPING: 'typing',
  REACT: 'react',
  EDIT: 'edit',
  DELETE: 'delete',
  JOIN: 'join',
  CREATE_ROOM: 'create_room',
  PROFILE: 'profile',
  PING: 'ping'
});

export const S2C = Object.freeze({
  WELCOME: 'welcome',
  MSG: 'msg',
  EDIT: 'edit',
  DELETE: 'delete',
  REACT: 'react',
  HISTORY: 'history',
  PRESENCE: 'presence',
  TYPING: 'typing',
  ROOMS: 'rooms',
  ROOM: 'room',
  ERROR: 'error',
  PROFILE: 'profile',
  PONG: 'pong'
});

export function cleanText(input) {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, MAX_TEXT);
}

export function cleanName(input) {
  return String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

export function validName(name) {
  return /^[\p{L}\p{N}][\p{L}\p{N} _.-]{1,23}$/u.test(name);
}

export function roomId(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ROOM_NAME);
}

export function isMessage(m) {
  return (
    m &&
    typeof m === 'object' &&
    typeof m.id === 'string' &&
    m.id.length >= 6 &&
    m.id.length <= 64 &&
    typeof m.text === 'string' &&
    m.text.length > 0 &&
    m.text.length <= MAX_TEXT &&
    typeof m.ts === 'number' &&
    m.ts > 0 &&
    m.author &&
    typeof m.author.name === 'string'
  );
}

export function encode(obj) {
  return JSON.stringify(obj);
}

export function decode(str) {
  try {
    const v = JSON.parse(str);
    return v && typeof v === 'object' && typeof v.t === 'string' ? v : null;
  } catch {
    return null;
  }
}
