// Home Screen widget feed (threads-14): read-only build status for the Scriptable "Build Status" widget.
// URL: https://<threads>/widget/<THREADS_WIDGET_KEY>  (rewrite in vercel.json → /api/widget?key=…)
// Its own key, separate from THREADS_MCP_KEY, and it can only read. Wrong or missing key → 404.
// Health matches the app: Stuck > Waiting on you > Healthy, same day limits from Settings → Health.
import { safeEqual } from './_lib/auth.js';
import { loadAll } from './_lib/apply.js';
import { APP_VERSION } from './_lib/version.js';

const docOf = (s) => (s?.doc && typeof s.doc === 'object' ? s.doc : {});
const syncOf = (s) => { const x = docOf(s).sync; return x && typeof x === 'object' ? x : {}; };
const slugOf = (s) => syncOf(s).slug || String(s.name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const tierOf = (s) => (s.status === 'active' ? 'active' : s.status === 'archived' ? 'archived' : 'parked');
const iso = (t) => (t ? new Date(t).toISOString() : null);

export function buildFeed({ sections, chats, settings }, now = Date.now()) {
  const h = settings.health || {};
  const lim = { active: +h.active || 5, parked: +h.parked || 30 };
  const kids = (id) => sections.filter((s) => s.parent_id === id).flatMap((s) => [s.id, ...kids(s.id)]);
  const projects = sections.filter((s) => !s.parent_id && !s.is_inbox && !docOf(s).system && tierOf(s) !== 'archived');
  const out = projects.map((s) => {
    const sy = syncOf(s), d = docOf(s), tier = tierOf(s);
    const ids = new Set([s.id, ...kids(s.id)]);
    let la = Date.parse(sy.last_activity || '') || 0;
    for (const c of chats) if (ids.has(c.section_id) && !c.archived_at && c.claude_updated_at) la = Math.max(la, Date.parse(c.claude_updated_at) || 0);
    let health = 'ok';
    if (!sy.synced_at) health = 'unknown';
    else {
      const days = la ? Math.floor((now - la) / 864e5) : null;
      if (days === null || days >= lim[tier]) health = 'stuck';
      else if (sy.deployed === false || sy.next_owner === 'joe') health = 'waiting';
    }
    return {
      name: s.name, slug: slugOf(s), icon: s.icon || null, tier, health,
      status: d.status || null, build: sy.build || null, deployed: sy.deployed ?? null,
      now: d.now || null, next: d.next || null, next_owner: sy.next_owner || null,
      current_chat: sy.current_chat || null, last_activity: iso(la), gaps: (sy.gaps || []).length,
      position: s.position ?? 0,
    };
  });
  out.sort((a, b) => (Date.parse(b.last_activity || 0) || 0) - (Date.parse(a.last_activity || 0) || 0) || a.position - b.position);
  out.forEach((p) => delete p.position);
  return { version: APP_VERSION, generated_at: iso(now), last_synced: settings.sync?.last_synced || null, projects: out };
}

export default async function handler(req, res) {
  const key = process.env.THREADS_WIDGET_KEY;
  const given = (req.query && req.query.key) || new URL(req.url, 'http://x').searchParams.get('key') || '';
  res.setHeader('Cache-Control', 'no-store');
  if (!key || key.length < 24) return res.status(503).json({ error: 'The widget feed is off. Set THREADS_WIDGET_KEY in Vercel, then redeploy.' });
  if (!given || !safeEqual(given, key)) return res.status(404).json({ error: 'Not found' });
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Use GET.' }); }
  try {
    const feed = buildFeed(await loadAll());
    feed.app_url = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    return res.status(200).json(feed);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Something went wrong.' });
  }
}
