import { route, send, body } from './_lib/auth.js';
import { db, q } from './_lib/db.js';

const T = { sections: 'threads_sections', chats: 'threads_chats', settings: 'threads_settings' };
const COLS = {
  sections: ['id', 'name', 'position', 'is_inbox', 'created_at', 'parent_id', 'color', 'icon', 'project_uuid', 'archived_at'],
  chats: ['id', 'section_id', 'name', 'chat_uuid', 'kind', 'url', 'notes', 'todos', 'position', 'pinned', 'pin_position', 'archived_at', 'last_opened_at', 'created_at'],
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
    return send(res, 200, { sections, chats, settings });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST.' });
  const { ops } = body(req);
  if (!Array.isArray(ops) || !ops.length || ops.length > 50) throw bad('Bad request.');
  for (const op of ops) await apply(op); // in order: moves land before a delete
  send(res, 200, { ok: true });
});
