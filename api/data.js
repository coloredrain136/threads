import { route, send, body } from './_lib/auth.js';
import { db, q } from './_lib/db.js';
import { APP_VERSION } from './_lib/version.js';

const T = { sections: 'threads_sections', chats: 'threads_chats', settings: 'threads_settings' };
const COLS = {
  sections: ['id', 'name', 'position', 'is_inbox', 'created_at', 'parent_id', 'color', 'icon', 'project_uuid', 'archived_at', 'status', 'doc', 'home_chat_id', 'activated_at'],
  chats: ['id', 'section_id', 'name', 'chat_uuid', 'kind', 'url', 'notes', 'todos', 'position', 'pinned', 'pin_position', 'archived_at', 'last_opened_at', 'created_at', 'claude_updated_at', 'suggest'],
  settings: ['id', 'value'],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(['chat', 'cowork', 'code', 'project', 'other']);
const COLORS = new Set(['gold', 'coral', 'rose', 'violet', 'blue', 'teal', 'green', 'slate']);
const bad = (m) => Object.assign(new Error(m), { status: 400 });
const uuidOrNull = (v, label) => {
  if (v === null || v === '' || v === undefined) return null;
  if (!UUID.test(String(v))) throw bad(`Bad ${label}.`);
  return String(v).toLowerCase();
};

// Project doc v2: status, now, next, details, tools, accounts (where logins live in
// 1Password, never the secret), env (names + where set, never values), links, notes.
// Older v1 docs (summary, string tools) are still accepted.
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const URLRE = /^https?:\/\//i;
const OPRE = /^(https:\/\/(start|my)\.1password\.(com|ca|eu)\/|onepassword:\/\/)/i;
const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
function cleanDoc(d) {
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
    link: OPRE.test(str(a?.link, 600)) ? str(a.link, 600) : '' })).filter((a) => a.name);
  if ('env' in d) o.env = list(d.env, 60).map((e) => ({ name: str(String(e?.name ?? '').split('=')[0], 80), where: str(e?.where, 60) })).filter((e) => e.name);
  if ('links' in d) o.links = list(d.links, 40).map((l) => ({ label: str(l?.label, 60), url: str(l?.url, 500) })).filter((l) => URLRE.test(l.url));
  if ('updated_at' in d) o.updated_at = str(d.updated_at, 40);
  if ('sync' in d) o.sync = cleanSync(d.sync);
  if (['ideas', 'sync'].includes(d.system)) o.system = d.system; // system folders (threads-10)
  return o;
}

// Data from `sync threads` / `sync <project>` (threads_sync v2). Text only, no secrets.
const iso = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
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

function pick(table, row) {
  const o = {};
  if (!row || typeof row !== 'object') return o;
  for (const k of COLS[table]) if (k in row) o[k] = row[k];
  if ('name' in o) {
    o.name = String(o.name || '').trim().slice(0, 80);
    if (!o.name) throw bad('Name is required.');
  }
  if (table === 'sections') {
    delete o.is_inbox; // set once by the schema
    if ('parent_id' in o) {
      o.parent_id = uuidOrNull(o.parent_id, 'group');
      if (o.parent_id && o.parent_id === o.id) throw bad("A group can't go inside itself.");
    }
    if ('color' in o) o.color = COLORS.has(o.color) ? o.color : null;
    if ('icon' in o) o.icon = o.icon ? String(o.icon).slice(0, 16) : null;
    if ('project_uuid' in o) o.project_uuid = uuidOrNull(o.project_uuid, 'project link');
    if ('status' in o) o.status = ['active', 'parked', 'archived'].includes(o.status) ? o.status : 'parked'; // tiers
    if ('home_chat_id' in o) o.home_chat_id = uuidOrNull(o.home_chat_id, 'home chat');
    if ('doc' in o) o.doc = cleanDoc(o.doc);
  }
  if (table === 'chats') {
    if ('chat_uuid' in o) o.chat_uuid = uuidOrNull(o.chat_uuid, 'chat link');
    if ('section_id' in o) o.section_id = uuidOrNull(o.section_id, 'group');
    if ('kind' in o && !KINDS.has(o.kind)) throw bad('Bad type.');
    if ('url' in o) {
      o.url = o.url ? String(o.url).trim() : null;
      if (o.url && (!/^(https:\/\/claude\.ai\/|claude:\/\/)/i.test(o.url) || o.url.length > 500)) throw bad('Links must be claude.ai or claude:// links.');
    }
    if ('notes' in o) o.notes = String(o.notes || '').slice(0, 20000);
    if ('claude_updated_at' in o) o.claude_updated_at = o.claude_updated_at ? iso(o.claude_updated_at) : null;
    if ('suggest' in o) o.suggest = o.suggest ? String(o.suggest).trim().slice(0, 80) || null : null;
    if ('todos' in o) {
      if (!Array.isArray(o.todos)) throw bad('Bad checklist.');
      o.todos = o.todos.slice(0, 100).map((t) => ({ id: String(t?.id || '').slice(0, 40), text: String(t?.text || '').slice(0, 300), done: !!t?.done }));
    }
  }
  if (table === 'settings' && 'value' in o && (typeof o.value !== 'object' || o.value === null)) throw bad('Bad setting.');
  return o;
}

async function apply(op) {
  const table = T[op?.table];
  if (!table) throw bad('Unknown table.');
  if (op.op === 'upsert') {
    const row = pick(op.table, op.row);
    if (!row.id) throw bad('id is required.');
    await q(db().from(table).upsert(row));
  } else if (op.op === 'patch') {
    const rows = Array.isArray(op.rows) ? op.rows.slice(0, 300) : [];
    await Promise.all(rows.map((r) => {
      const { id, ...rest } = pick(op.table, r);
      if (!id || !Object.keys(rest).length) return null;
      return q(db().from(table).update(rest).eq('id', id));
    }));
  } else if (op.op === 'delete') {
    if (!op.id || op.table === 'settings') throw bad('Bad delete.');
    if (op.table === 'sections') {
      const s = await q(db().from(T.sections).select('is_inbox').eq('id', op.id).maybeSingle());
      if (s?.is_inbox) throw bad("Inbox can't be deleted.");
    }
    await q(db().from(table).delete().eq('id', op.id));
  } else if (op.op === 'upsert_many') {
    const rows = (Array.isArray(op.rows) ? op.rows.slice(0, 300) : []).map((r) => pick(op.table, r));
    if (!rows.length || rows.some((r) => !r.id) || op.table === 'settings') throw bad('Bad import.');
    await q(db().from(table).upsert(rows));
  } else if (op.op === 'delete_many') {
    const ids = Array.isArray(op.ids) ? op.ids.map(String).slice(0, 500) : [];
    if (!ids.length || op.table === 'settings') throw bad('Bad delete.');
    if (op.table === 'sections') {
      const rows = await q(db().from(T.sections).select('is_inbox').in('id', ids));
      if (rows.some((r) => r.is_inbox)) throw bad("Inbox can't be deleted.");
    }
    await q(db().from(table).delete().in('id', ids));
  } else {
    throw bad('Unknown operation.');
  }
}

export default route(async (req, res) => {
  if (req.method === 'GET') {
    const [sections, chats, settings] = await Promise.all([
      q(db().from(T.sections).select('*').order('position')),
      q(db().from(T.chats).select('*')),
      q(db().from(T.settings).select('id,value')),
    ]);
    return send(res, 200, { sections, chats, settings, version: APP_VERSION });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST.' });
  // An old copy of the page can't write over newer data.
  if (req.headers['x-app-version'] !== APP_VERSION) return send(res, 409, { error: 'Threads was updated. Reload to keep saving.', version: APP_VERSION });
  const { ops } = body(req);
  if (!Array.isArray(ops) || !ops.length || ops.length > 50) throw bad('Bad request.');
  for (const op of ops) await apply(op); // in order: moves land before a delete
  send(res, 200, { ok: true });
});
