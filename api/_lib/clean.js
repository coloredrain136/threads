// Cleans project docs before they're stored: no passwords, keys, tokens or env values.
// Shared by api/data.js (the app) and api/_lib/apply.js (the Threads connector).
// Project doc v2: status, now, next, details, tools, accounts (where logins live in
// 1Password, never the secret), env (names + where set, never values), links, notes.
// Older v1 docs (summary, string tools) are still accepted.
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const URLRE = /^https?:\/\//i;
const OPRE = /^(https:\/\/(start|my)\.1password\.(com|ca|eu)\/|onepassword:\/\/)/i;
const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
// Setup checks (threads-18): true = confirmed, false = missing, left out = not checked yet.
const tri = (v) => (v === true || /^(yes|true|confirmed|ok|set)$/i.test(String(v ?? '')) ? true : v === false || /^(no|false|missing)$/i.test(String(v ?? '')) ? false : null);
function checks(e, keys) {
  const o = {};
  for (const k of keys) { const t = tri(e?.[k]); if (t !== null) o[k] = t; }
  const c = str(e?.checked, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(c)) o.checked = c;
  return o;
}
// A sync that resends env/accounts without checks keeps the ones Joe already set (matched by name).
export function carryChecks(oldL, newL, keys) {
  const m = new Map((Array.isArray(oldL) ? oldL : []).map((e) => [String(e?.name || '').toLowerCase(), e]));
  return (Array.isArray(newL) ? newL : []).map((e) => {
    const o = m.get(String(e?.name || '').toLowerCase());
    if (!o || !e || typeof e !== 'object') return e;
    const x = { ...e };
    for (const k of [...keys, 'checked']) if (!(k in x) && k in o) x[k] = o[k];
    return x;
  });
}
export function cleanDoc(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return {};
  const o = {};
  if ('status' in d) o.status = str(d.status, 24);
  if ('now' in d) o.now = str(d.now, 400);
  if ('next' in d) o.next = str(d.next, 400);
  if ('summary' in d) o.summary = str(d.summary, 1500);
  if ('details' in d) o.details = list(d.details, 12).map((x) => str(x, 200)).filter(Boolean);
  if ('notes' in d) o.notes = list(d.notes, 30).map((x) => str(x, 300)).filter(Boolean);
  if ('tools' in d) o.tools = list(d.tools, 40).map((t) => (typeof t === 'string' ? { name: str(t, 60), role: '', url: '' }
    : { name: str(t?.name, 60), role: str(t?.role, 120), url: URLRE.test(str(t?.url, 500)) ? str(t.url, 500) : '' })).filter((t) => t.name);
  if ('accounts' in d) o.accounts = list(d.accounts, 40).map((a) => ({ name: str(a?.name, 80), item: str(a?.item, 120), vault: str(a?.vault, 60),
    link: OPRE.test(str(a?.link, 600)) ? str(a.link, 600) : '', ...checks(a, ['op']) })).filter((a) => a.name);
  if ('env' in d) o.env = list(d.env, 60).map((e) => ({ name: str(String(e?.name ?? '').split('=')[0], 80), where: str(e?.where, 60), ...checks(e, ['vercel', 'op']) })).filter((e) => e.name);
  if ('links' in d) o.links = list(d.links, 40).map((l) => ({ label: str(l?.label, 60), url: str(l?.url, 500) })).filter((l) => URLRE.test(l.url));
  if ('updated_at' in d) o.updated_at = str(d.updated_at, 40);
  if ('sync' in d) o.sync = cleanSync(d.sync);
  if (['ideas', 'general', 'shortcuts', 'sync'].includes(d.system)) o.system = d.system; // system folders (threads-10)
  return o;
}

// Data from `sync threads` / `sync <project>` (threads_sync v2). Text only, no secrets.
export const iso = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const int = (v, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : null; };
function cleanSync(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return {};
  const o = {};
  if ('slug' in x) o.slug = str(x.slug, 40).toLowerCase().replace(/[^a-z0-9-]/g, '');
  if ('build' in x) o.build = str(x.build, 40);
  if ('build_n' in x) o.build_n = int(x.build_n, 9999);
  if ('deployed' in x) o.deployed = x.deployed === null ? null : !!x.deployed;
  if ('next_owner' in x) o.next_owner = str(x.next_owner, 20).toLowerCase();
  if ('last_activity' in x) o.last_activity = iso(x.last_activity);
  if ('synced_at' in x) o.synced_at = iso(x.synced_at);
  if ('current_chat' in x) o.current_chat = str(x.current_chat, 80);
  if ('updates_in_chat' in x) o.updates_in_chat = int(x.updates_in_chat, 99);
  if ('is_new' in x) o.is_new = !!x.is_new;
  if ('docs' in x && x.docs && typeof x.docs === 'object') o.docs = { scope: !!x.docs.scope, log: !!x.docs.log, carryover: !!x.docs.carryover };
  if ('gaps' in x) o.gaps = list(x.gaps, 30).map((g) => ({ check: str(g?.check, 30).toLowerCase(), text: str(g?.text, 200), fix: str(g?.fix, 1500) })).filter((g) => g.text);
  if ('builds' in x) o.builds = list(x.builds, 60).map((b) => ({ n: int(b?.n, 9999), date: str(b?.date, 10), summary: str(b?.summary, 200) })).filter((b) => b.summary || b.n !== null);
  return o;
}

export const cleanDocExport = cleanDoc;
