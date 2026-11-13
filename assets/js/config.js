// Neegy-Talk :: config
// Edit this file, nothing else, to point the site at your own services.

export const CONFIG = {
  siteName: 'Neegy-Talk',

  // '' = same origin. Set to 'https://your-proxy.example.com' if /api/room lives elsewhere.
  apiBase: '',

  // Drop a PNG/JPG here to replace the built-in vector Neegy, e.g. 'assets/neegy/neegy.png'
  art: null,

  room: {
    region: 'NA',            // NA | EU | AS
    startUrl: 'https://neal.fun/'
  },

  chat: {
    minTypingMs: 450,
    maxTypingMs: 1600
  }
};
