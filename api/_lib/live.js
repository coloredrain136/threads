// Live Check (threads-26): is each Building / Shipped app's site up, and does its version.json match the latest build?
// Results live in threads_settings id "live" as { checked_at, source, results: { <slug>: {...} } }, never in project docs.
// "up" only means the site answers (passcode pages still return 200); backend-only failures don't show here.
import { db, q } from './db.js';
import { loadAll } from './apply.js';
import { normTier } from './tiers.js';

const docOf = (s) => (s?.doc && typeof s.doc === 'object' ? s.doc : {});
const syncOf = (s) => { const x = docOf(s).sync; return x && typeof x === 'object' ? x : {}; };
const slugOf = (s) => syncOf(s).slug || String(s.name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const norm = (v) => String(v ?? '').trim().toLowerCase();
export const FULL_GAP = 5 * 60e3; // no full run if the last one was under 5 min ago
export const ONE_GAP = 30e3; // one project's Recheck: once per 30s
const TIMEOUT = 8e3;

// The live link the same way the app picks it: label starts with live/app/site, or a hosting domain. claude.ai links are skipped.
export function liveUrl(s) {
  const links = Array.isArray(docOf(s).links) ? docOf(s).links : [];
  const l = links.find((x) => {
    const u = norm(x?.url), t = norm(x?.label);
    if (!/^https?:\/\//.test(u) || /github\.com|vercel\.com|supabase\./.test(u)) return false;
    return /^(live|app|site|website|prod)/.test(t) || /\.vercel\.app|netlify\.app|pages\.dev|zerogee\.dev/.test(u);
  });
  if (!l) return null;
  try { const u = new URL(l.url); return /(^|\.)claude\.ai$/i.test(u.hostname) ? null : u.href; } catch { return null; }
}
export const checkable = (sections) => sections.filter((s) => !s.parent_id && !s.is_inbox && !docOf(s).system
  && ['building', 'shipped'].includes(normTier(s.status)) && liveUrl(s));

async function get(url, fetchImpl) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const r = await fetchImpl(url, { redirect: 'follow', signal: ac.signal, cache: 'no-store', headers: { 'user-agent': 'ThreadsLiveCheck/1.0 (+https://threads.zerogee.dev)', accept: '*/*' } });
    const text = await r.text().catch(() => '');
    return { ok: r.ok, code: r.status, url: r.url || url, text };
  } catch (e) {
    return { ok: false, code: null, err: e?.name === 'AbortError' ? 'Timed out after 8s' : String(e?.cause?.code || e?.message || 'No answer').slice(0, 80) };
  } finally { clearTimeout(t); }
}
function versionFrom(text) {
  try {
    const j = JSON.parse(text);
    const v = j && typeof j === 'object' ? (j.version ?? j.v ?? j.build ?? j.APP_VERSION) : null;
    return v == null || v === '' ? null : String(v).slice(0, 60);
  } catch { return null; }
}

// One project → { url, state: up | down | mismatch | no_version, up, code, error?, version, build, match, no_version_file, checked_at }
export async function checkOne(s, fetchImpl = fetch, now = Date.now()) {
  const url = liveUrl(s), build = syncOf(s).build || null;
  const page = await get(url, fetchImpl);
  const r = { url, up: page.ok, code: page.code, build, version: null, match: null, no_version_file: false, checked_at: new Date(now).toISOString() };
  let origin; try { origin = new URL(page.url || url).origin; } catch { origin = new URL(url).origin; }
  const vf = await get(`${origin}/version.json?t=${now}`, fetchImpl);
  // API-only apps (Pocket) answer 404 on "/" but serve version.json: that's up (threads-26 fix).
  if (!page.ok && !(page.code && page.code < 500 && vf.ok && versionFrom(vf.text))) { r.state = 'down'; r.error = page.err || `Answered ${page.code}`; return r; }
  if (!page.ok) { r.up = true; r.api_only = true; }
  r.version = vf.ok ? versionFrom(vf.text) : null;
  r.no_version_file = !r.version;
  if (r.version && build) r.match = norm(r.version) === norm(build);
  r.state = r.no_version_file ? 'no_version' : r.match === false ? 'mismatch' : 'up';
  return r;
}

// Runs the check (all projects, or one slug) and saves it. Returns { ran, live }.
export async function runLive({ slug = null, source = 'app', force = false, fetchImpl = fetch, now = Date.now() } = {}) {
  const { sections, settings } = await loadAll();
  const prev = settings.live && typeof settings.live === 'object' ? settings.live : {};
  const results = { ...(prev.results || {}) };
  const list = checkable(sections);
  if (slug) {
    const s = list.find((x) => slugOf(x) === norm(slug));
    if (!s) return { ran: false, live: prev, why: 'That project has no live link to check.' };
    const last = Date.parse(results[slugOf(s)]?.checked_at || '') || 0;
    if (!force && now - last < ONE_GAP) return { ran: false, live: prev, why: 'Checked a moment ago.' };
    results[slugOf(s)] = await checkOne(s, fetchImpl, now);
  } else {
    const last = Date.parse(prev.checked_at || '') || 0;
    if (!force && now - last < FULL_GAP) return { ran: false, live: prev, why: 'Checked under 5 minutes ago.' };
    const out = await Promise.all(list.map(async (s) => [slugOf(s), await checkOne(s, fetchImpl, now)]));
    for (const k of Object.keys(results)) delete results[k]; // projects that left Building/Shipped or lost their link drop off
    for (const [k, v] of out) results[k] = v;
  }
  const live = { checked_at: slug ? (prev.checked_at || null) : new Date(now).toISOString(), source: slug ? (prev.source || source) : source, results };
  await q(db().from('threads_settings').upsert({ id: 'live', value: live }));
  return { ran: true, live };
}
