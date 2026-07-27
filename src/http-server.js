// HTTP layer for the daemon: REST + SSE over a BoardStore + FeedbackHub, and
// static serving of the web UI. Returns a plain http.Server (not yet
// listening) so it can be unit/integration tested on an ephemeral port.

import http from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { BoardNotFound, ThreadNotFound, publicView } from './board-store.js';
import { PUBLIC_DIR } from './config.js';

const sendJson = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const sendText = (res, code, type, body) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 16_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
const esc = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function landingHtml(store, baseUrl) {
  const rows = store
    .list()
    .map((b) => {
      const open = b.threads.filter((t) => t.status !== 'resolved').length;
      const name = esc(b.label || (b.summary || '').split('\n')[0] || b.id).slice(0, 90);
      return `<li><a href="/b/${b.id}">${name}</a> <span class="m">${open} open · ${b.threads.length} total · ${esc(b.key)}</span></li>`;
    })
    .join('');
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Session Threads — boards</title>
<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1c2430}@media(prefers-color-scheme:dark){body{background:#0f1216;color:#e7ecf2}a{color:#4f8bff}}h1{font-size:18px}ul{list-style:none;padding:0}li{padding:10px 0;border-bottom:1px solid #8883}a{font-weight:600;text-decoration:none}.m{color:#8a97a6;font-size:13px;margin-left:8px}</style>
<h1>Session Threads — active boards</h1><ul>${rows || '<li class=m>No boards yet.</li>'}</ul><script>setTimeout(()=>location.reload(),5000)</script>`;
}

/**
 * @param {import('./board-store.js').BoardStore} store
 * @param {import('./feedback.js').FeedbackHub} hub
 * @param {{host:string, port:number, baseUrl:string, dataDir:string}} config
 */
export function createServer(store, hub, config) {
  const backupDir = join(dirname(config.dataDir), 'backups');

  // one SSE client set per board; broadcast on any board change
  const sseClients = new Map(); // boardId -> Set<res>
  const clientsFor = (id) => {
    let s = sseClients.get(id);
    if (!s) sseClients.set(id, (s = new Set()));
    return s;
  };
  store.on('change', (board) => {
    const frame = `data: ${JSON.stringify({ type: 'state', state: publicView(board) })}\n\n`;
    for (const res of clientsFor(board.id)) {
      try {
        res.write(frame);
      } catch {
        clientsFor(board.id).delete(res);
      }
    }
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const p = url.pathname;
      const GET = req.method === 'GET';
      const POST = req.method === 'POST';

      if (GET && p === '/health') return sendText(res, 200, 'text/plain', 'ok');
      if (GET && p === '/') return sendText(res, 200, 'text/html; charset=utf-8', landingHtml(store, config.baseUrl));
      if (GET && p === '/markdown.js') return sendText(res, 200, 'application/javascript; charset=utf-8', readFileSync(join(PUBLIC_DIR, 'markdown.js')));

      // create-or-get / list boards
      if (POST && p === '/api/boards') {
        const body = await readJson(req);
        const b = store.getOrCreate({ key: body.key, label: body.label });
        return sendJson(res, 200, { id: b.id, url: `${config.baseUrl}/b/${b.id}`, key: b.key });
      }
      if (GET && p === '/api/boards') {
        return sendJson(res, 200, {
          boards: store.list().map((b) => ({
            id: b.id,
            label: b.label,
            key: b.key,
            url: `${config.baseUrl}/b/${b.id}`,
            threads: b.threads.length,
            open: b.threads.filter((t) => t.status !== 'resolved').length,
          })),
        });
      }

      // web UI for a board
      const web = p.match(/^\/b\/([\w-]+)$/);
      if (GET && web) {
        if (!store.get(web[1])) return sendText(res, 404, 'text/plain', 'no such board');
        return sendText(res, 200, 'text/html; charset=utf-8', readFileSync(join(PUBLIC_DIR, 'index.html')));
      }

      // per-board API
      const m = p.match(/^\/api\/b\/([\w-]+)(?:\/([\w-]+))?$/);
      if (m) {
        const id = m[1];
        const sub = m[2] || '';
        if (!store.get(id)) return sendJson(res, 404, { error: 'no such board' });

        if (GET && sub === 'state') return sendJson(res, 200, publicView(store.get(id)));
        if (GET && sub === 'export') return sendJson(res, 200, store.exportBoard(id));
        if (GET && sub === 'notes') return sendJson(res, 200, { notes: store.allNotes(id) });
        if (GET && sub === 'threads') {
          return sendJson(res, 200, {
            threads: store.get(id).threads.map((t) => {
              const last = t.messages[t.messages.length - 1];
              return { id: t.id, title: t.title, tags: t.tags, status: t.status, deferred: t.deferred, work: t.work, lastAuthor: last ? last.author : null, lastIntent: last ? last.intent || null : null, messages: t.messages.length };
            }),
          });
        }
        if (GET && sub === 'events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write('retry: 2000\n\n');
          res.write(`data: ${JSON.stringify({ type: 'state', state: publicView(store.get(id)) })}\n\n`);
          clientsFor(id).add(res);
          const hb = setInterval(() => {
            try {
              res.write(': hb\n\n');
            } catch {
              /* ignore */
            }
          }, 25000);
          req.on('close', () => {
            clearInterval(hb);
            clientsFor(id).delete(res);
          });
          return;
        }
        if (GET && sub === 'wait') {
          const secs = Math.min(Math.max(Number(url.searchParams.get('timeout')) || 50, 5), 300);
          const payload = await hub.wait(id, secs * 1000);
          payload.notes = store.drainNotes(id);
          if (payload.status === 'timeout' && payload.notes.length) payload.status = 'feedback';
          return sendJson(res, 200, payload);
        }

        if (POST) {
          const body = await readJson(req);
          switch (sub) {
            case 'submit': {
              const r = store.applySubmit(id, body);
              hub.deliver(id, r.replies);
              return sendJson(res, 200, { ok: true, replies: r.replies.length, note: r.noteAdded ? 1 : 0 });
            }
            case 'thread': {
              const t = store.addThread(id, body);
              return sendJson(res, 200, { id: t.id, tags: t.tags, actions: t.actions });
            }
            case 'message':
              store.addMessage(id, body.thread_id, body);
              return sendJson(res, 200, { ok: true });
            case 'resolve':
              store.setStatus(id, body.thread_id, 'resolved');
              return sendJson(res, 200, { ok: true });
            case 'reopen':
              store.setStatus(id, body.thread_id, 'open');
              return sendJson(res, 200, { ok: true });
            case 'defer':
              store.deferThread(id, body.thread_id, body);
              return sendJson(res, 200, { ok: true });
            case 'summary':
              store.setSummary(id, body.text);
              return sendJson(res, 200, { ok: true });
            case 'agent':
              store.setAgent(id, body);
              return sendJson(res, 200, { ok: true });
            case 'import': {
              const r = store.importThreads(id, body);
              return sendJson(res, 200, { ok: true, ...r });
            }
            case 'backup': {
              mkdirSync(backupDir, { recursive: true });
              const file = join(backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}.json`);
              writeFileSync(file, JSON.stringify(store.exportBoard(id), null, 2));
              return sendJson(res, 200, { ok: true, file, threads: store.get(id).threads.length });
            }
            default:
              return sendJson(res, 404, { error: 'unknown endpoint' });
          }
        }
        return sendJson(res, 404, { error: 'unknown endpoint' });
      }

      sendText(res, 404, 'text/plain', 'not found');
    } catch (e) {
      const code = e instanceof BoardNotFound ? 404 : e instanceof ThreadNotFound ? 404 : 500;
      try {
        sendJson(res, code, { error: e.message });
      } catch {
        /* headers already sent */
      }
    }
  });

  return server;
}
