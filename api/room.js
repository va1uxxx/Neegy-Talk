// Neegy-Talk :: /api/room
// Vercel-style serverless proxy. The Hyperbeam key stays in the environment.

const HB_API = 'https://engine.hyperbeam.com/v0/vm';
const REGIONS = new Set(['NA', 'EU', 'AS']);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
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

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const key = process.env.HYPERBEAM_API_KEY;
  if (!key) {
    return res.status(503).json({
      error: 'not_configured',
      message: 'HYPERBEAM_API_KEY is not set on this deployment.'
    });
  }

  try {
    if (req.method === 'DELETE') {
      const id = req.query && req.query.session_id;
      if (!id || !/^[a-zA-Z0-9-]{8,64}$/.test(id)) {
        return res.status(400).json({ error: 'bad_session', message: 'Missing session_id.' });
      }
      const r = await fetch(`${HB_API}/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${key}` }
      });
      return res.status(r.ok ? 200 : r.status).json({ ended: r.ok });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method', message: 'POST or DELETE only.' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const startUrl = safeUrl(body.start_url, 'about:blank');
    const region = REGIONS.has(body.region) ? body.region : 'NA';

    const payload = {
      start_url: startUrl,
      region,
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
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      const code = upstream.status === 401 || upstream.status === 403 ? 'unauthorized' : `http_${upstream.status}`;
      return res.status(upstream.status).json({
        error: code,
        message: data.message || data.error || 'Hyperbeam refused the request.'
      });
    }

    return res.status(200).json({
      session_id: data.session_id,
      embed_url: data.embed_url,
      admin_token: data.admin_token
    });
  } catch (err) {
    return res.status(502).json({ error: 'network', message: String(err.message || err) });
  }
}
