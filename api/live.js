// Live Check endpoint (threads-26).
//   GET /api/live            → saved results (session required)
//   GET /api/live?run=1      → run all if the last run is over 5 min old (session required)
//   GET /api/live?slug=bars  → recheck one project (session required, once per 30s)
//   Vercel cron (daily, vercel.json "crons") → run all. Recognized by Vercel's cron user agent; no secret,
//   so the worst a spoofed call can do is one extra round of pings, and never more than one per 5 minutes.
import { verify, send } from './_lib/auth.js';
import { runLive } from './_lib/live.js';
import { loadAll } from './_lib/apply.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, { error: 'Use GET.' }); }
    const u = new URL(req.url, 'http://x');
    const isCron = /^vercel-cron\//i.test(String(req.headers['user-agent'] || ''));
    if (isCron) {
      const r = await runLive({ source: 'cron' });
      return send(res, 200, { ok: true, ran: r.ran, checked: Object.keys(r.live.results || {}).length });
    }
    const h = req.headers.authorization || '';
    if (!verify(h.startsWith('Bearer ') ? h.slice(7) : '', 'session')) return send(res, 401, { error: 'Your session ended. Enter your passcode again.' });
    const slug = u.searchParams.get('slug');
    if (slug || u.searchParams.get('run')) {
      const r = await runLive({ slug: slug || null, source: 'app' });
      return send(res, 200, { ran: r.ran, why: r.why || null, live: r.live });
    }
    const { settings } = await loadAll();
    return send(res, 200, { ran: false, live: settings.live || {} });
  } catch (err) {
    console.error(err);
    return send(res, Number(err.status) && err.status !== 401 ? err.status : 500, { error: err.message || 'Something went wrong.' });
  }
}
