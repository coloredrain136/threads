import { route, send, body } from './_lib/auth.js';
import { db, q } from './_lib/db.js';

const T = { sections: 'threads_sections', chats: 'threads_chats', settings: 'threads_settings' };
const COLS = {
  sections: ['id', 'name', 'position', 'is_inbox', 'created_at'],
  chats: ['id', 'section_id', 'name', 'chat_uuid', 'position', 'pinned', 'pin_position', 'archived_at', 'last_opened_at', 'created_at'],
  settings: ['id', 'value'],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (m) => Object.assign(new Error(m), { status: 400 });

function pick(table, row) {
  const o = {};
  if (!row || typeof row !== 'object') return o;
  for (const k of COLS[table]) if (k in row) o[k] = row[k];
  if ('name' in o) {
    o.name = String(o.name || '').trim().slice(0, 80);
    if (!o.name) throw bad('Name is required.');
  }
  if ('chat_uuid' in o) {
    o.chat_uuid = String(o.chat_uuid || '').toLowerCase();
    if (!UUID.test(o.chat_uuid)) throw bad('That is not a valid chat link.');
  }
  if (table === 'sections') delete o.is_inbox; // the Inbox is set once by the schema
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
  for (const op of ops) await apply(op); // in order: moves land before a section delete
  send(res, 200, { ok: true });
});
