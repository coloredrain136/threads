// Threads connector: a tiny remote MCP server (Streamable HTTP, JSON responses) for Claude.
// Added in Claude → Customize → Connectors → Add custom connector, URL: https://<threads>/mcp/<THREADS_MCP_KEY>
// The key in the URL is the password. Wrong or missing key → 404, so the endpoint stays hidden.
// It only touches Threads' own tables, and every write goes through the same secret stripping as the app.
import { safeEqual, body } from './_lib/auth.js';
import { applySync, status } from './_lib/apply.js';
import { APP_VERSION } from './_lib/version.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = `Threads is Joe's dashboard for his Builds projects. Keep it current so he never has to copy-paste syncs:
- After every build in a Builds project chat (once the build log is updated), call threads_update_project with that project's status.
- When Joe says "sync threads", "sync <project>" or "deep sync <project>", build the threads_sync v2 payload as the threads-sync skill describes and send it with threads_apply_sync instead of replying with a JSON block.
- Use threads_status to see where projects stand before suggesting what to work on.
Never send passwords, API keys, tokens or env var values. Env vars are names only.`;

const s = (description, extra = {}) => ({ type: 'string', description, ...extra });
const TOOLS = [
  {
    name: 'threads_update_project',
    title: 'Update a Project in Threads',
    description: 'Push one Builds project\'s current status into Threads. Call this at the end of every build (after the build log is updated) and whenever the project\'s status, next step or deploy state changes. Only include fields you know; anything left out stays as it was. Never include secret values.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: s('Project display name, Title Case (e.g. "Bracket").'),
        slug: s('Project slug, lowercase with dashes (e.g. "bracket").'),
        status: s('One word: Idea, Scoping, Building, Testing, Live, Paused or Blocked.'),
        build: s('Latest delivered build, e.g. "bracket-17".'),
        build_n: { type: 'integer', description: 'Latest build number, e.g. 17.' },
        deployed: { type: ['boolean', 'null'], description: 'true if Joe confirmed the latest build is deployed, false if delivered but not confirmed, null if unknown.' },
        now: s('One short line (under 90 characters): where the project stands.'),
        next: s('One short line (under 90 characters): the single next step.'),
        next_owner: s('"joe" if the next step is Joe\'s (deploy, test, answer), "claude" if it\'s building.', { enum: ['joe', 'claude'] }),
        current_chat: s('Title of the current session chat, e.g. "Bracket - Build 2".'),
        updates_in_chat: { type: 'integer', description: 'How many updates this build chat has had (about 10 means time for the next session chat).' },
        links: { type: 'object', description: 'Only URLs actually in the docs.', properties: { live: s('Live app URL'), github: s('GitHub repo URL'), vercel: s('Vercel project URL'), supabase: s('Supabase dashboard URL') } },
        docs: { type: 'object', properties: { scope: { type: 'boolean' }, log: { type: 'boolean' }, carryover: { type: 'boolean' } } },
        gaps: { type: 'array', description: 'Playbook audit misses. Send the full current list (an empty list clears them).', items: { type: 'object', properties: { check: s('names, docs, icloud, supabase, env, version or links'), text: s('One short line'), fix: s('Copyable prompt Joe pastes in the project\'s current chat') }, required: ['text'] } },
        builds: { type: 'array', description: 'New or changed builds, newest first. Merged by build number with what Threads has.', items: { type: 'object', properties: { n: { type: 'integer' }, date: s('YYYY-MM-DD'), summary: s('One line') } } },
        setup: { type: 'object', description: 'Optional: stack, accounts (1Password item + vault only; every item is tagged "Projects - <Project Name>"), env var names, deploy notes. Env items: {name, where, vercel, op}; account items: {name, item, vault, op}. vercel / op = true only when Joe confirmed it is set in Vercel / saved in 1Password, false when he said it is missing; leave them out otherwise (Threads keeps the checks it already has).', properties: { tools: { type: 'array', items: { type: 'object' } }, accounts: { type: 'array', items: { type: 'object' } }, env: { type: 'array', items: { type: 'object' } }, notes: { type: 'array', items: { type: 'string' } } } },
      },
    },
    annotations: { title: 'Update a Project in Threads', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'threads_apply_sync',
    title: 'Apply a Threads Sync',
    description: 'Apply a full threads_sync v2 payload (from "sync threads", "sync <project>" or "deep sync <project>", built exactly as the threads-sync skill describes) directly to Threads, instead of giving Joe a JSON block to paste. Chats are matched by link, projects by slug/name; tiers never change.',
    inputSchema: {
      type: 'object',
      required: ['sync'],
      properties: { sync: { type: 'object', description: 'The threads_sync v2 object: {"threads_sync":2,"kind":"all"|"project","synced_at":"ISO","chats":[…],"projects":[…]}' } },
    },
    annotations: { title: 'Apply a Threads Sync', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'threads_status',
    title: 'Read Threads Status',
    description: 'Read where Joe\'s Builds projects stand in Threads: tier (Building, Shipped, On Hold, Backlog, Archived; Joe moves tiers himself in the app), status, latest build, deployed, now/next, current chat, gaps. Pass a project name for its details, links, recent builds and chat links.',
    inputSchema: { type: 'object', properties: { project: s('Optional project name or slug.') } },
    annotations: { title: 'Read Threads Status', readOnlyHint: true, openWorldHint: false },
  },
];

const text = (obj, isError) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args = {}) {
  if (name === 'threads_status') return text(await status(args.project));
  if (name === 'threads_apply_sync') {
    const r = await applySync(args.sync, 'connector: sync');
    return text({ ok: true, ...r, note: 'Applied to Threads. Tell Joe in one line what changed.' });
  }
  if (name === 'threads_update_project') {
    if (!args.name) return text('name is required.', true);
    const p = { ...args };
    if (!p.last_activity) p.last_activity = new Date().toISOString();
    const r = await applySync({ threads_sync: 2, kind: 'project', synced_at: new Date().toISOString(), projects: [p], chats: [] }, 'connector: build');
    return text({ ok: true, ...r });
  }
  return text(`Unknown tool: ${name}`, true);
}

async function handle(m) {
  const id = m?.id ?? null, method = m?.method;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (!method) return err(-32600, 'Invalid request');
  if (id === null || id === undefined) return null; // notifications (e.g. notifications/initialized): no reply
  try {
    if (method === 'initialize') {
      const want = m.params?.protocolVersion;
      return ok({ protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'threads', title: 'Threads', version: APP_VERSION }, instructions: INSTRUCTIONS });
    }
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: TOOLS });
    if (method === 'tools/call') {
      try { return ok(await callTool(m.params?.name, m.params?.arguments || {})); }
      catch (e) { console.error(e); return ok(text(`Threads couldn't apply that: ${e.message}`, true)); }
    }
    if (method === 'resources/list') return ok({ resources: [] });
    if (method === 'prompts/list') return ok({ prompts: [] });
    return err(-32601, `Method not found: ${method}`);
  } catch (e) {
    console.error(e);
    return err(-32603, e.message || 'Internal error');
  }
}

export default async function handler(req, res) {
  const key = process.env.THREADS_MCP_KEY;
  const given = (req.query && req.query.key) || new URL(req.url, 'http://x').searchParams.get('key') || '';
  res.setHeader('Cache-Control', 'no-store');
  if (!key || key.length < 24) return res.status(503).json({ error: 'The Threads connector is off. Set THREADS_MCP_KEY in Vercel, then redeploy.' });
  if (!given || !safeEqual(given, key)) return res.status(404).json({ error: 'Not found' });
  if (req.method === 'DELETE') return res.status(200).end();
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Use POST.' }); }
  const msg = body(req);
  const list = Array.isArray(msg) ? msg : [msg];
  const out = (await Promise.all(list.map(handle))).filter(Boolean);
  if (!out.length) return res.status(202).end();
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).send(JSON.stringify(Array.isArray(msg) ? out : out[0]));
}
