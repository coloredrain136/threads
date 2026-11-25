// Docs (threads-30): the Builds project docs, synced into Threads by Claude (connector tool threads_sync_docs).
//   GET /api/docs            → list (path, project, title, kind, size, updated_at); no text
//   GET /api/docs?path=…     → one doc with its text
// Session required. Read-only from the app: docs are edited in Claude and re-synced.
import { route, send } from './_lib/auth.js';
import { db, q } from './_lib/db.js';

export default route(async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET.' });
  const path = new URL(req.url, 'http://x').searchParams.get('path');
  if (path) {
    const doc = await q(db().from('threads_docs').select('path,project,title,kind,size,updated_at,content').eq('path', path).maybeSingle());
    if (!doc) return send(res, 404, { error: 'That doc is not in Threads.' });
    return send(res, 200, { doc });
  }
  const docs = await q(db().from('threads_docs').select('path,project,title,kind,size,updated_at').order('path'));
  send(res, 200, { docs });
});
