// Neegy-Talk :: config
// Edit this file, nothing else, to point the site at your own services.

export const CONFIG = {
  siteName: 'Neegy-Talk',

  // null = same origin (ws(s)://<this host>/ws). Set the full URL when the chat
  // hub lives somewhere else, e.g. 'wss://chat.example.com/ws'.
  wsUrl: null,

  // '' = same origin, for /api/room (the optional Hyperbeam proxy).
  apiBase: '',

  chat: {
    // 'auto'   probe for a hub, fall back to local mode when none answers
    // 'server' always use the hub (shows a reconnect banner if it is down)
    // 'local'  never open a socket; tabs only (demo)
    mode: 'auto'
  }
};
