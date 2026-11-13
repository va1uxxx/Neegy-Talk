# Neegy-Talk

A chat site built around **Neegy** — 15 levels, XP from the things you actually do, lore that unlocks as you go, and a live virtual browser called *Neegy's Room* (Hyperbeam).

No build step. No framework. No accounts. Progress lives in `localStorage`.

```
index.html            the whole page
assets/css/app.css    theme
assets/js/data.js     levels, lore, quests, places, topics, xp rates  ← tune here
assets/js/dialogue.js Neegy's local reply engine
assets/js/store.js    xp, levels, quests, persistence
assets/js/room.js     Hyperbeam client (SDK with iframe fallback)
assets/js/app.js      UI wiring
api/room.js           serverless proxy (Vercel)
worker/room.js        Cloudflare Worker proxy (for GitHub Pages)
server.py             local server + proxy, zero dependencies
```

---

## Run it locally

```bash
export HYPERBEAM_API_KEY=hbr_your_key_here
python3 server.py
# → http://localhost:8080
```

The chat works with no key. The room needs one.

Get a key at <https://hyperbeam.com/dashboard> → **API keys**. Keys look like `hbr_…`. The free tier is enough to test; every open room is a billed VM minute.

> ES modules do not load from `file://`. Use `server.py`, or any static server.

---

## Deploy

### Everything in one place (simplest)

Vercel / Netlify / any Node host:

1. Import the repo.
2. Set `HYPERBEAM_API_KEY` in the environment.
3. `api/room.js` becomes `/api/room` automatically. `assets/js/config.js` already points at same-origin.

### GitHub Pages (site) + Cloudflare Worker (proxy)

GitHub Pages cannot run server code, so the key needs a proxy somewhere else.

```bash
npx wrangler deploy worker/room.js --name neegy-room
npx wrangler secret put HYPERBEAM_API_KEY
```

Then in `assets/js/config.js`:

```js
apiBase: 'https://neegy-room.<your-subdomain>.workers.dev'
```

and set the worker's `ALLOW_ORIGIN` to your Pages origin:

```bash
npx wrangler secret put ALLOW_ORIGIN   # https://va1uxxx.github.io
```

The included workflow (`.github/workflows/pages.yml`) stages `index.html`, `assets/` and the manifest into `_site` and publishes that on push to `main` — the proxy sources and `server.py` stay off the public site.

Enable it once: **Settings → Pages → Source: GitHub Actions**.

---

## Levels

15 of them. Each one changes Neegy's accent, unlocks lore, and shifts how Neegy writes to you — clipped and machine-like at 1, warm at 6, uncomfortably fond at 12+.

| # | name | xp | what changes |
|---|------|-----|--------------|
| 1 | Stranger | 0 | Neegy answers. Barely. |
| 2 | Heard | 120 | Neegy's Room unlocks |
| 3 | Regular | 300 | Neegy remembers what you said |
| 4 | Familiar | 580 | Neegy uses your name |
| 5 | Confidant | 950 | most lore opens |
| 6 | Kept | 1,420 | secrets |
| 7 | Anchor | 2,050 | Neegy picks the room |
| 8 | Signal | 2,800 | proper backtalk |
| 9 | Kindred | 3,750 | attachment, admitted |
| 10 | Resonance | 4,900 | distance collapses |
| 11 | Luminary | 6,250 | glow |
| 12 | Constellation | 7,800 | lines written for you |
| 13 | Static Saint | 9,600 | forgiveness |
| 14 | Neegy's Own | 11,700 | exclusive |
| 15 | Same Wavelength | 14,200 | no seam |

## Where XP comes from

| action | xp | limit |
|--------|----|-------|
| message | +6 | 30s cooldown, 300/day |
| new word used | +1 to +5 | 300/day shared with messages |
| new topic first mentioned | +12 | 16 topics, once each |
| daily check-in | +25 | once a day |
| streak bonus | +5 per day | capped at +40 |
| daily quest | +25 to +80 | 3 per day, seeded by date |
| lore entry read | +15 | 10 entries |
| open the room | +20 | once per 6 hours |
| time in the room | +2/min | 40 xp/day |

All of it lives in `assets/js/data.js` under `XP`. Change the numbers and the whole curve moves.

---

## Making Neegy yours

**The face.** Drop a PNG at `assets/neegy/neegy.png` and set it in `assets/js/config.js`:

```js
art: 'assets/neegy/neegy.png'
```

The built-in Neegy is a vector placeholder (`index.html`, the inline `<svg class="neegy">`) — it blinks, floats, and takes its iris colour from the current level accent. Nothing else depends on it.

**The voice.** `assets/js/dialogue.js`. Three registers per intent — `low` (1–5), `mid` (6–10), `high` (11–15). Add lines to the arrays; the rotation never repeats the same line twice running.

**The lore.** `assets/js/data.js` → `LORE`. Each entry has `at` (level), `title`, `body`. Ten slots, easy to extend.

**The room.** `PLACES` in `data.js` is the chip list Neegy can take you to. The default start URL is in `config.js`.

---

## Notes and gotchas

- **The key never reaches the browser.** Only `/api/room` sees it. Do not put it in `config.js`.
- The SDK is loaded from `unpkg` (`@hyperbeam/web`). If it fails, the room falls back to a plain iframe — same session, no volume control.
- Rooms are billed per minute. `server.py` rate-limits to 6 per IP per 10 minutes; `timeout.offline` kills abandoned rooms after 10 minutes.
- `admin_token` is returned to the client so the place chips can navigate the room. Each visitor creates their own session, so there is nothing to protect.
- Sound is synthesised with WebAudio — no audio files. Toggle it in the top bar.
- Progress is per browser. Settings → Export JSON if you care about it.
- If you wipe `localStorage`, Neegy starts over at Stranger and says so.
