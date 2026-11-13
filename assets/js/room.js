// Neegy-Talk :: Hyperbeam room client
// The API key never touches the browser. Only /api/room sees it.

import { CONFIG } from './config.js';

const SDK_URL = 'https://unpkg.com/@hyperbeam/web@latest/dist/index.js';

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

let client = null;

function endpoint(path = '') {
  return `${CONFIG.apiBase}/api/room${path}`;
}

export async function createRoom({ startUrl, region } = {}) {
  let res;
  try {
    res = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start_url: startUrl || CONFIG.room.startUrl,
        region: region || CONFIG.room.region
      })
    });
  } catch (e) {
    throw new RoomError('network', 'Could not reach the room service. Is /api/room deployed?');
  }

  let data = null;
  try { data = await res.json(); } catch (e) { /* non-json */ }

  if (!res.ok) {
    throw new RoomError(data && data.error ? data.error : `http_${res.status}`,
      (data && data.message) || 'The room service refused the request.');
  }
  if (!data || !data.embed_url) {
    throw new RoomError('bad_response', 'The room service answered with no embed URL.');
  }

  return {
    sessionId: data.session_id,
    embedUrl: data.embed_url,
    adminToken: data.admin_token || null
  };
}

export async function endRoom(sessionId) {
  if (!sessionId) return;
  try {
    await fetch(endpoint(`?session_id=${encodeURIComponent(sessionId)}`), { method: 'DELETE' });
  } catch (e) {
    console.warn('[neegy] could not end the room cleanly', e);
  }
}

/**
 * Attach the virtual browser to a container.
 * Falls back to a plain iframe if the SDK cannot be imported.
 */
export async function mountRoom(container, embedUrl, opts = {}) {
  await unmountRoom();
  try {
    const mod = await import(/* @vite-ignore */ SDK_URL);
    const Hyperbeam = mod.default || mod.Hyperbeam;
    if (typeof Hyperbeam !== 'function') throw new Error('SDK export missing');
    client = await Hyperbeam(container, embedUrl, {
      timeout: 20000,
      volume: typeof opts.volume === 'number' ? opts.volume : 0.35,
      delegateKeyboard: false,
      adminToken: opts.adminToken || undefined,
      onDisconnect: () => { opts.onDisconnect && opts.onDisconnect(); },
      onConnectionStateChange: (s) => { opts.onState && opts.onState(s.state); }
    });
    return client;
  } catch (e) {
    console.warn('[neegy] SDK unavailable, using iframe fallback', e);
    container.innerHTML = '';
    const frame = document.createElement('iframe');
    frame.src = embedUrl;
    frame.allow = 'autoplay; clipboard-read; clipboard-write; fullscreen';
    frame.setAttribute('allowfullscreen', '');
    frame.title = "Neegy's Room";
    container.appendChild(frame);
    return null;
  }
}

export async function unmountRoom() {
  if (!client) return;
  try { client.destroy(); } catch (e) { /* already gone */ }
  client = null;
}

export function setVolume(v) {
  if (client) client.volume = Math.max(0, Math.min(1, v));
}

export function currentClient() {
  return client;
}
