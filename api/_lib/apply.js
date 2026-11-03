// Applies a threads_sync v2 payload straight to the database (used by the Threads connector).
// Same rules as the in-app Import: chats by link (Claude title wins), projects by slug/name,
// tiers never change, new projects Building if touched in 7 days else On Hold, folder chats filed,
// builds merged, secrets stripped (by api/data.js cleanDoc on the way in).
import crypto from 'node:crypto';
import { db, q } from './db.js';
import { cleanDocExport as cleanDoc } from './clean.js';
import { normTier } from './tiers.js';

const T = { sections: 'threads_sections', chats: 'threads_chats', settings: 'threads_settings' };
const COLORS = ['gold', 'coral', 'rose', 'violet', 'blue', 'teal', 'green', 'slate'];
const SYSTEM = {
  ideas: { name: 'Ideas', icon: '💡', color: 'gold' },
  general: { name: 'General', icon: '💬', color: 'blue' },
  shortcuts: { name: 'Apple Shortcuts', icon: '⚡', color: 'violet' },
  sync: { name: 'Sync Chats', icon: '🔄', color: 'slate' },
};
const SYS_KEYS = Object.keys(SYSTEM);
const SYNC_RE = /^(sync threads|threads\s*[-–]\s*sync)\b/i;
const SHORTCUT_RE = /^(\[shortcut\]|shortcut\s*[-–:]|apple shortcut)/i;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ARC = [['live', 'Live app'], ['github', 'GitHub'], ['vercel', 'Vercel'], ['supabase', 'Supabase']];
const URL_OK = (u) => /^https?:\/\//i.test(u || '');
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const nowISO = () => new Date().toISOString();
const isoOr = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const uid = () => crypto.randomUUID();
const bad = (m) => Object.assign(new Error(m), { status: 400 });

const chatIdFrom = (link) => {
  const t = String(link || '').trim();
  const m = t.match(new RegExp(`claude\\.ai/chat/(${UUID})`, 'i')) || t.match(new RegExp(`^(${UUID})$`, 'i'));
  return m ? m[1].toLowerCase() : null;
};
function linkKind(l) {
  const u = String(l.url || '').toLowerCase(), t = String(l.label || '').toLowerCase();
  if (u.includes('github.com')) return 'github';
  if (u.includes('vercel.com')) return 'vercel';
  if (u.includes('supabase.')) return 'supabase';
  if (/^(live|app|site|website|prod)/.test(t) || /\.vercel\.app|netlify\.app|pages\.dev/.test(u)) return 'live';
  return 'other';
}
function mergeLinks(cur, map) {
  const out = (Array.isArray(cur) ? cur : []).map((l) => ({ ...l }));
  for (const [k, label] of ARC) {
    const u = String(map[k] || '').trim();
    if (!URL_OK(u)) continue;
    const l = { label, url: u.slice(0, 500) }, i = out.findIndex((x) => linkKind(x) === k);
    if (i >= 0) out[i] = l; else out.push(l);
  }
  for (const [k, v] of Object.entries(map)) {
    if (ARC.some((a) => a[0] === k) || !URL_OK(v) || out.some((l) => l.url === v)) continue;
    out.push({ label: String(k).replace(/[_-]+/g, ' ').replace(/^./, (x) => x.toUpperCase()).slice(0, 60), url: String(v).slice(0, 500) });
  }
  const rank = (l) => { const i = ARC.findIndex((a) => a[0] === linkKind(l)); return i < 0 ? 9 : i; };
  return out.sort((a, b) => rank(a) - rank(b)).slice(0, 40);
}
function mergeBuilds(old, add) {
  const m = new Map();
  for (const b of [...(Array.isArray(old) ? old : []), ...add]) m.set(b.n != null ? 'n' + b.n : 's' + b.summary, b);
  return [...m.values()].sort((a, b) => (b.n ?? 0) - (a.n ?? 0) || String(b.date).localeCompare(String(a.date))).slice(0, 60);
}
function syncPatch(p, kind, at) {
  const patch = {};
  if ('status' in p) patch.status = str(p.status, 24);
  if ('now' in p) patch.now = str(p.now, 400);
  if ('next' in p) patch.next = str(p.next, 400);
  if (Array.isArray(p.details)) patch.details = p.details.map((x) => str(x, 200)).filter(Boolean).slice(0, 3);
  if (p.setup && typeof p.setup === 'object') for (const k of ['tools', 'accounts', 'env', 'notes']) if (Array.isArray(p.setup[k])) patch[k] = p.setup[k];
  const sy = { synced_at: at };
  for (const k of ['slug', 'build', 'current_chat', 'next_owner']) if (p[k] != null && p[k] !== '') sy[k] = str(p[k], k === 'current_chat' ? 80 : 40);
  if (sy.slug) sy.slug = sy.slug.toLowerCase();
  if (sy.next_owner) sy.next_owner = sy.next_owner.toLowerCase();
  if ('build_n' in p) sy.build_n = Number.isFinite(+p.build_n) ? Math.round(+p.build_n) : null;
  if ('deployed' in p) sy.deployed = p.deployed === null ? null : !!p.deployed;
  if ('last_activity' in p) sy.last_activity = isoOr(p.last_activity);
  if ('updates_in_chat' in p) sy.updates_in_chat = Number.isFinite(+p.updates_in_chat) ? Math.max(0, Math.round(+p.updates_in_chat)) : null;
  if (p.docs && typeof p.docs === 'object') sy.docs = { scope: !!p.docs.scope, log: !!p.docs.log, carryover: !!p.docs.carryover };
  if (Array.isArray(p.gaps)) sy.gaps = p.gaps.slice(0, 30).map((g) => ({ check: str(g?.check, 30).toLowerCase(), text: str(g?.text, 200), fix: str(g?.fix, 1500) })).filter((g) => g.text);
  if (Array.isArray(p.builds)) sy.builds = p.builds.slice(0, kind === 'project' ? 60 : 12).map((b) => ({ n: Number.isFinite(+b?.n) && b?.n !== null && b?.n !== '' ? Math.round(+b.n) : null, date: str(b?.date, 10), summary: str(b?.summary, 200) })).filter((b) => b.summary || b.n != null);
  return { patch, sy };
}

export async function loadAll() {
  const [sections, chats, settings] = await Promise.all([
    q(db().from(T.sections).select('*').order('position')),
    q(db().from(T.chats).select('*')),
    q(db().from(T.settings).select('id,value')),
  ]);
  return { sections, chats, settings: Object.fromEntries(settings.map((r) => [r.id, r.value])) };
}
const docOf = (s) => (s?.doc && typeof s.doc === 'object' ? s.doc : {});
const sysOf = (s) => docOf(s).system || null;
const slugOf = (s) => docOf(s).sync?.slug || String(s.name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export async function applySync(j, source = 'connector') {
  if (!j || typeof j !== 'object') throw bad('Expected a threads_sync object.');
  if (Number(j.threads_sync) !== 2) throw bad('threads_sync must be 2.');
  if (j.kind === 'docs') throw bad('Docs syncs are not supported yet.');
  const kind = j.kind === 'project' ? 'project' : 'all';
  const at = isoOr(j.synced_at) || nowISO();
  const { sections, chats, settings } = await loadAll();
  const byId = new Map(sections.map((s) => [s.id, s]));
  const topOf = (s) => { let x = s; for (let i = 0; i < 20 && x?.parent_id && byId.get(x.parent_id); i++) x = byId.get(x.parent_id); return x; };
  const inbox = sections.find((s) => s.is_inbox);
  const projects = sections.filter((s) => !s.parent_id && !s.is_inbox && !sysOf(s)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const sysSec = (k) => sections.find((s) => !s.parent_id && sysOf(s) === k);

  const reg = new Map();
  const add = (k, s) => { k = String(k || '').trim().toLowerCase(); if (k && !reg.has(k)) reg.set(k, s); };
  for (const s of projects) { add(docOf(s).sync?.slug, s); add(s.name, s); }
  for (const s of projects) add(slugOf(s), s);
  const find = (name, slug) => reg.get(String(slug || '').trim().toLowerCase()) || reg.get(String(name || '').trim().toLowerCase())
    || reg.get(String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));

  const newSecs = [], projUps = [], newChats = [], chatUps = [], sysNew = {};
  let colorIdx = projects.length, renamed = 0, moved = 0, badLinks = 0;
  let pos = Math.max(0, ...projects.map((s) => s.position || 0)) + 1;
  const create = (name, p, act) => {
    const recent = act && Date.now() - Date.parse(act) < 7 * 864e5;
    const row = { id: uid(), name: str(name, 80), parent_id: null, position: pos++, is_inbox: false, status: recent ? 'building' : 'hold',
      icon: p?.icon ? str(p.icon, 16) : null, color: COLORS.includes(p?.color) ? p.color : COLORS[colorIdx++ % COLORS.length],
      project_uuid: null, archived_at: null, home_chat_id: null, activated_at: recent ? nowISO() : null, doc: { sync: { is_new: true } }, created_at: nowISO() };
    newSecs.push(row); add(row.name, row); add(p?.slug, row);
    return row;
  };
  const ensureSys = (k) => sysSec(k) || sysNew[k] || (sysNew[k] = (() => {
    const r = { id: uid(), name: SYSTEM[k].name, icon: SYSTEM[k].icon, color: SYSTEM[k].color, parent_id: null, position: 9000, is_inbox: false, status: 'hold',
      project_uuid: null, archived_at: null, home_chat_id: null, activated_at: null, doc: { system: k }, created_at: nowISO() };
    newSecs.push(r); return r;
  })());

  for (const p of (Array.isArray(j.projects) ? j.projects : []).slice(0, 80)) {
    const name = str(p?.name, 80);
    if (!name) continue;
    let s = find(name, p.slug);
    const isNew = !s;
    if (isNew) s = create(name, p, p.last_activity);
    if (projUps.some((u) => u.s === s)) continue;
    const { patch, sy } = syncPatch(p, kind, at);
    const look = {};
    if (p.icon && !s.icon) look.icon = str(p.icon, 16);
    if (COLORS.includes(p.color) && !s.color) look.color = p.color;
    if (p.links && typeof p.links === 'object' && !Array.isArray(p.links)) patch.links = mergeLinks(docOf(s).links, p.links);
    projUps.push({ s, isNew, patch, sy, look });
  }

  const seen = new Set();
  const minPos = (sid) => Math.min(0, ...chats.filter((c) => c.section_id === sid).map((c) => c.position ?? 0), ...newChats.filter((c) => c.section_id === sid).map((c) => c.position ?? 0));
  for (const c of (Array.isArray(j.chats) ? j.chats : []).slice(0, 500)) {
    const id = chatIdFrom(c?.link);
    if (!id) { badLinks++; continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    const title = str(c.title || c.name, 80) || 'Untitled';
    const upd = isoOr(c.updated_at);
    const isSync = SYNC_RE.test(title);
    let target = c.project ? (find(c.project) || create(c.project, null, upd)) : null;
    const fk = isSync ? 'sync' : !target && SYS_KEYS.includes(c.folder) ? c.folder : !target && SHORTCUT_RE.test(title) ? 'shortcuts' : null;
    if (fk) target = ensureSys(fk);
    const sug = isSync || fk ? null : 'proper' in c ? (c.proper === false ? (str(c.suggest, 80) || null) : null) : undefined;
    const ex = chats.find((x) => x.chat_uuid === id);
    if (ex) {
      const up = { id: ex.id };
      if (title !== ex.name) { up.name = title; renamed++; }
      if (upd && upd !== (ex.claude_updated_at && new Date(ex.claude_updated_at).toISOString())) up.claude_updated_at = upd;
      if (sug !== undefined && (sug || null) !== (ex.suggest || null)) up.suggest = sug;
      const cur = byId.get(ex.section_id) || inbox, curTop = topOf(cur);
      if (!ex.archived_at && target && curTop?.id !== target.id && (cur?.is_inbox || c.proper === true || isSync)) { up.section_id = target.id; up.position = minPos(target.id) - 1; moved++; }
      if (fk && sug === null && ex.suggest) up.suggest = null;
      if (Object.keys(up).length > 1) chatUps.push(up);
    } else {
      const sec = target || inbox;
      if (!sec) continue;
      newChats.push({ id: uid(), section_id: sec.id, name: title, chat_uuid: id, kind: 'chat', url: null, notes: str(c.notes, 2000), todos: [],
        position: minPos(sec.id) - 1, pinned: false, pin_position: null, archived_at: null, last_opened_at: null, created_at: nowISO(), claude_updated_at: upd, suggest: sug || null });
    }
  }

  // Build the project docs (merged), cleaned the same way the app's API cleans them.
  const secPatches = [];
  for (const u of projUps) {
    const d = { ...docOf(u.s) };
    for (const k of Object.keys(u.patch)) d[k] = u.patch[k];
    if ('now' in u.patch) delete d.summary;
    const old = d.sync && typeof d.sync === 'object' ? d.sync : {};
    const sy = { ...old, ...u.sy };
    if (u.sy.builds) sy.builds = mergeBuilds(old.builds, u.sy.builds);
    if (u.isNew) sy.is_new = true;
    d.sync = sy; d.updated_at = nowISO();
    const clean = cleanDoc(d);
    if (u.isNew) { u.s.doc = clean; Object.assign(u.s, u.look); }
    else secPatches.push({ id: u.s.id, doc: clean, ...u.look });
  }

  // Write: new sections first (chats reference them), then patches, then chats, then settings.
  if (newSecs.length) await q(db().from(T.sections).upsert(newSecs.map((r) => ({ ...r, doc: cleanDoc(r.doc) }))));
  for (const r of secPatches) { const { id, ...rest } = r; await q(db().from(T.sections).update(rest).eq('id', id)); }
  for (let i = 0; i < newChats.length; i += 150) await q(db().from(T.chats).upsert(newChats.slice(i, i + 150)));
  for (const r of chatUps) { const { id, ...rest } = r; await q(db().from(T.chats).update(rest).eq('id', id)); }
  const syncSet = { ...(settings.sync || {}), last_synced: at, last_source: source };
  await q(db().from(T.settings).upsert({ id: 'sync', value: syncSet }));

  return {
    kind, synced_at: at,
    projects_updated: projUps.filter((u) => !u.isNew).map((u) => u.s.name),
    projects_new: projUps.filter((u) => u.isNew).map((u) => `${u.s.name} (${u.s.status})`).concat(newSecs.filter((r) => !sysOf(r) && !projUps.some((u) => u.s === r)).map((r) => `${r.name} (${r.status})`)),
    chats_new: newChats.length, chats_renamed: renamed, chats_moved: moved, chats_with_bad_links: badLinks,
  };
}

// Short read-only view for Claude: where every project stands (no secrets live in Threads anyway).
export async function status(projectName) {
  const { sections, chats, settings } = await loadAll();
  const projects = sections.filter((s) => !s.parent_id && !s.is_inbox && !sysOf(s));
  const one = projectName ? projects.find((s) => s.name.toLowerCase() === String(projectName).toLowerCase() || slugOf(s) === String(projectName).toLowerCase()) : null;
  const brief = (s) => {
    const d = docOf(s), sy = d.sync || {};
    return { name: s.name, slug: slugOf(s), tier: normTier(s.status), status: d.status || null, build: sy.build || null, deployed: sy.deployed ?? null,
      now: d.now || null, next: d.next || null, next_owner: sy.next_owner || null, current_chat: sy.current_chat || null, updates_in_chat: sy.updates_in_chat ?? null,
      synced_at: sy.synced_at || null, gaps: (sy.gaps || []).map((g) => g.text) };
  };
  if (projectName && !one) return { error: `No project called "${projectName}". Projects: ${projects.map((s) => s.name).join(', ')}` };
  if (one) {
    const d = docOf(one), ids = new Set([one.id, ...sections.filter((s) => s.parent_id === one.id).map((s) => s.id)]);
    return { ...brief(one), links: d.links || [], recent_builds: (d.sync?.builds || []).slice(0, 10),
      chats: chats.filter((c) => ids.has(c.section_id) && !c.archived_at).map((c) => ({ title: c.name, link: c.chat_uuid ? `https://claude.ai/chat/${c.chat_uuid}` : c.url })),
      stack: (d.tools || []).map((t) => t.name), env_names: (d.env || []).map((e) => e.name) };
  }
  return { last_synced: settings.sync?.last_synced || null, projects: projects.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(brief) };
}
