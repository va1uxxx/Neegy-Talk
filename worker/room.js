/**
 * Neegy-Talk :: Cloudflare Worker room proxy
 * Deploy this when the site itself is on GitHub Pages.
 *
 *   wrangler deploy worker/room.js --name neegy-room
 *   wrangler secret put HYPERBEAM_API_KEY
 *
 * Then set apiBase in assets/js/config.js to the worker URL.
 */

const HB_API = 'https://engine.hyperbeam.com/v0/vm';
const REGIONS = new Set(['NA', 'EU', 'AS']);

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) }
  });
}

function safeUrl(input, fallback) {
  if (typeof input !== 'string' || !input) return fallback;
  try {
    const u = new URL(input);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fallback;
    return u.toString();
  } catch (e) {
    return fallback;
  }
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || request.headers.get('Origin') || '*';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (url.pathname !== '/api/room' && url.pathname !== '/') {
      return json({ error: 'not_found' }, 404, origin);
    }

    const key = env.HYPERBEAM_API_KEY;
    if (!key) return json({ error: 'not_configured', message: 'HYPERBEAM_API_KEY is not set on this worker.' }, 503, origin);

    try {
      if (request.method === 'DELETE') {
        const id = url.searchParams.get('session_id') || '';
        if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) return json({ error: 'bad_session' }, 400, origin);
        const r = await fetch(`${HB_API}/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${key}` } });
        return json({ ended: r.ok }, r.ok ? 200 : r.status, origin);
      }

      if (request.method !== 'POST') return json({ error: 'method' }, 405, origin);

      const body = await request.json().catch(() => ({}));
      const payload = {
        start_url: safeUrl(body.start_url),
        region: REGIONS.has(body.region) ? body.region : 'NA',
        kiosk: false,
        dark: true,
        adblock: true,
        width: 1280,
        height: 720,
        fps: 30,
        timeout: { offline: 600, inactive: 1800 }
      };

      const upstream = await fetch(HB_API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await upstream.json().catch(() => ({}));

      if (!upstream.ok) {
        const code = upstream.status === 401 || upstream.status === 403 ? 'unauthorized' : `http_${upstream.status}`;
        return json({ error: code, message: data.message || 'Hyperbeam refused the request.' }, upstream.status, origin);
      }

      return json({
        session_id: data.session_id,
        embed_url: data.embed_url,
        admin_token: data.admin_token
      }, 200, origin);
    } catch (err) {
      return json({ error: 'network', message: String(err.message || err) }, 502, origin);
    }
  }
};
