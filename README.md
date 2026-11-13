# Neegy-Talk

Real chat rooms for people. No bot, no account, no build step. Pick a name, join a room, talk.

- **Rooms** — seeded rooms plus user-created rooms (level 3+), room search, unread dots, per-room history.
- **Realtime** — WebSocket hub with presence, typing, reactions, replies, edit/delete, and reconnect.
- **Runs anywhere** — Python hub for a real multi-user backend, Cloudflare Worker + Durable Object for serverless, or local mode (tabs on one browser) so the static site still works.
- **Progress** — local profile, XP, 15 levels, and a theme-aware accent that recolors the UI as you level. Progress lives in this browser.
- **Polished** — responsive three-pane layout, dark/light theme, keyboard shortcuts, command palette, emoji picker, markdown-lite messages, XSS-safe rendering.

The chat UI is plain ES modules and CSS. No framework, no bundler.

## Project layout

```
index.html             app shell, SVG sprite, skeleton
assets/css/base.css    theme tokens, reset, controls
assets/css/app.css     layout and components
assets/js/config.js    deploy knobs (wsUrl, apiBase, chat mode)  ← edit this
assets/js/data.js      levels, XP rates, seeds
assets/js/app.js       UI wiring
assets/js/chat.js      client state and protocol handling
assets/js/local.js     offline/local hub (BroadcastChannel + localStorage)
assets/js/socket.js    WebSocket transport
assets/js/protocol.js  frame names and validation
assets/js/ui.js        DOM builders
server.py              stdlib WebSocket hub + static server + /api/room proxy
worker/index.js        Cloudflare Worker + Durable Object hub
wrangler.toml          Worker/DO/assets config
.github/workflows/     GitHub Pages deploy (stages site files only)
test/ws_test.py        WebSocket integration suite (stdlib)
test/ui.mjs            Playwright browser suite
```

## Run locally (real multi-user chat)

Needs Python 3. No packages.

```bash
python3 server.py
# → http://localhost:8080
```

Open it in two tabs or two browsers. Messages, presence, typing, reactions, edits, deletes, and rooms sync in real time. State is persisted to `data/chat.json` (gitignored).

Options:

```bash
python3 server.py --host 0.0.0.0 --port 8080 --data ./data/chat.json
```

The static server refuses to serve private files (`server.py`, `worker/`, `data/`, `test/`, dotfiles, etc.).

## Deploy

### 1. Cloudflare Worker + Durable Object (serverless hub)

The Worker serves the site and runs the chat hub in one Durable Object named `hub` (single writer for rooms, presence, and history). WebSockets use the hibernation API.

```bash
npx wrangler deploy
```

The site and `wss://<your-worker>/ws` come up together. No client config change needed when the hub is same-origin.

Notes:
- `wrangler.toml` binds static assets from the repo (filtered by `.assetsignore`) and routes `/ws` and `/api/*` to the Worker.
- History is stored in Durable Object storage (bounded). This is a small-room setup, not a hosted SaaS.

### 2. Python hub on a VPS (or any host that can run a process)

Run `server.py` behind a reverse proxy that forwards WebSockets. Point the static site at it in `assets/js/config.js`:

```js
export const CONFIG = {
  wsUrl: 'wss://chat.example.com/ws', // null = same origin /ws
  apiBase: '',                         // same origin for /api/room
  chat: { mode: 'auto' }               // 'auto' | 'server' | 'local'
};
```

`mode: 'auto'` probes for a hub and falls back to local mode if none answers. `server` requires the hub and shows a reconnect banner when it is down. `local` never opens a socket.

### 3. GitHub Pages (static only)

The included workflow stages `index.html`, `manifest.webmanifest`, and `assets/` into `_site` and deploys on push to `main`. Enable once: **Settings → Pages → Source: GitHub Actions**.

**Important:** GitHub Pages cannot run a WebSocket hub, so the live Pages URL runs in **local mode** (tabs on the same browser only). To make it multi-user for everyone, deploy a hub (option 1 or 2) and set `CONFIG.wsUrl` to it.

## Optional: Neegy's Room (Hyperbeam)

`/api/room` is an optional proxy for creating a Hyperbeam browser VM. It is not wired into the chat UI. To use it, supply a key to the hub process (never to the browser):

```bash
export HYPERBEAM_API_KEY=hbr_your_key_here
python3 server.py
# or: npx wrangler secret put HYPERBEAM_API_KEY
```

`POST /api/room` creates a session, `DELETE /api/room/:id` ends it. Hyperbeam is billed per VM minute; this path is not exercised by the automated tests.

## Levels and XP

15 levels, stored locally per browser. XP comes from social/chat actions:

| action | xp |
|---|---|
| message sent | small, rate-limited |
| room joined / people met | once per target |
| reaction given | capped |
| profile set | once |

Exact values and thresholds live in `assets/js/data.js`. Gated perks are minimal: avatar emoji at level 2, room creation at level 3. The level accent recolors the UI.

## Tests

WebSocket integration suite (stdlib, server must be running):

```bash
python3 server.py --port 8099 &
python3 test/ws_test.py 8099
```

Browser suite (Playwright, headless chromium):

```bash
node test/ui.mjs http://127.0.0.1:8099
```

The UI suite checks layout/overflow at 360–1920px, dark/light contrast, XSS-safe rendering, the server chat loop, two-client realtime, local-mode fallback/persistence, a11y names, and console errors. `test/` and `data/` are not deployed.

## Notes

- **No secrets in the client.** Hyperbeam keys live in the server/worker environment only.
- **Identity is local.** Name, emoji, level, and history are stored in this browser (`localStorage`). Clearing site data resets them.
- **XSS-safe by construction.** Messages render as text/parsed markdown-lite into DOM nodes, never via raw HTML injection.
- **The character image was never readable.** The UI uses a generated SVG mark instead of a bitmap portrait.
- **Hub required for cross-device chat.** Without a deployed hub, Pages serves a working single-browser demo (local mode), not a shared room.
