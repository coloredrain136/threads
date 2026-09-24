import crypto from 'node:crypto';

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw Object.assign(new Error('SESSION_SECRET is missing or too short. Set it in Vercel, then redeploy.'), { status: 500 });
  }
  return s;
}

const mac = (b) => crypto.createHmac('sha256', secret()).update(b).digest('base64url');

export function sign(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b}.${mac(b)}`;
}

export function verify(token, kind) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [b, sig] = token.split('.');
  if (!b || !sig) return null;
  const x = Buffer.from(sig), y = Buffer.from(mac(b));
  if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(b, 'base64url').toString()); } catch { return null; }
  if (kind && p.kind !== kind) return null;
  if (p.exp && Date.now() > p.exp) return null;
  return p;
}

export function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

export function send(res, status, data) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(data);
}

export function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

// Checks the session token and turns thrown errors into JSON.
// Only a bad session returns 401, so a Supabase hiccup never signs you out.
export function route(handler) {
  return async (req, res) => {
    try {
      const h = req.headers.authorization || '';
      const session = verify(h.startsWith('Bearer ') ? h.slice(7) : '', 'session');
      if (!session) return send(res, 401, { error: 'Your session ended. Enter your passcode again.' });
      await handler(req, res, session);
    } catch (err) {
      console.error(err);
      let status = Number(err.status) || 500;
      if (status === 401 || status === 403) status = 502;
      send(res, status, { error: err.message || 'Something went wrong.' });
    }
  };
}
