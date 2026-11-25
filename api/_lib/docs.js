// Docs sync (threads-30): file each Builds doc under its project by its path, e.g. claude/rally-build-log.md → rally.
import { db, q } from './db.js';
import { loadAll } from './apply.js';

const str = (v, n) => String(v ?? '').slice(0, n);
const SECRET = /(sk-[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{30,})/g;
export function kindOf(path) {
  const f = String(path).toLowerCase();
  if (/\.(js|json|html|css)$/.test(f)) return 'code';
  if (/-scope\.md$/.test(f)) return 'scope';
  if (/-build-log\.md$/.test(f)) return 'log';
  if (/-carryover\.md$/.test(f)) return 'carryover';
  if (/-plan\.md$|build\d+-plan\.md$/.test(f)) return 'plan';
  return 'other';
}
export function titleOf(path) {
  const base = String(path).split('/').pop().replace(/\.(md|txt)$/i, '');
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 120);
}
// Longest project slug that starts the file name wins ("remember-this-scope" → remember-this, not "remember").
export function projectOf(path, slugs) {
  const base = String(path).split('/').pop().toLowerCase();
  const hit = slugs.filter((s) => base === s || base.startsWith(s + '-') || base.startsWith(s + '.')).sort((a, b) => b.length - a.length)[0];
  return hit || 'general';
}
export async function syncDocs({ docs, prune = false } = {}) {
  if (!Array.isArray(docs) || !docs.length) throw Object.assign(new Error('docs must be a non-empty list.'), { status: 400 });
  const { sections } = await loadAll();
  const slugOf = (s) => (s.doc?.sync?.slug || String(s.name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  const slugs = sections.filter((s) => !s.parent_id && !s.is_inbox && !s.doc?.system).map(slugOf);
  const alias = { 'phone-setup': 'phone-setup', pocket: 'pocket', hub: 'domain-hub', 'domain-hub': 'domain-hub', 'build-screen': 'build-screen', 'phone-widgets': 'phone-setup', builds: 'build-screen' };
  const now = new Date().toISOString(), rows = [];
  let redacted = 0;
  for (const d of docs.slice(0, 120)) {
    const path = str(d?.path, 200).trim();
    if (!path || typeof d.content !== 'string') continue;
    let content = d.content.slice(0, 400000);
    content = content.replace(SECRET, () => { redacted++; return '[redacted]'; });
    const base = path.split('/').pop().toLowerCase().replace(/\.[a-z]+$/, '');
    const project = str(d.project, 60).toLowerCase() || alias[base] || projectOf(path, [...slugs, 'hub']); // aliases match whole file names only (builds.js ≠ builds-playbook)
    rows.push({ path, project: alias[project] || project, title: str(d.title, 120) || titleOf(path), kind: kindOf(path), content, size: content.length,
      updated_at: d.updated_at && Number.isFinite(Date.parse(d.updated_at)) ? new Date(d.updated_at).toISOString() : now, synced_at: now });
  }
  if (!rows.length) throw Object.assign(new Error('No docs with a path and content.'), { status: 400 });
  for (let i = 0; i < rows.length; i += 20) await q(db().from('threads_docs').upsert(rows.slice(i, i + 20)));
  let removed = 0;
  if (prune) {
    const keep = new Set(rows.map((r) => r.path));
    const have = await q(db().from('threads_docs').select('path'));
    const gone = have.map((r) => r.path).filter((p) => !keep.has(p));
    if (gone.length) { await q(db().from('threads_docs').delete().in('path', gone)); removed = gone.length; }
  }
  const byProject = {};
  rows.forEach((r) => { byProject[r.project] = (byProject[r.project] || 0) + 1; });
  return { ok: true, saved: rows.length, removed, redacted, by_project: byProject };
}
