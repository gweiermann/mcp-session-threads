import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore } from '../src/board-store.js';
import { FeedbackHub } from '../src/feedback.js';
import { createServer } from '../src/http-server.js';

async function startServer() {
  const root = mkdtempSync(join(tmpdir(), 'rt-http-'));
  const dataDir = join(root, 'boards');
  const store = new BoardStore(dataDir);
  const hub = new FeedbackHub();
  const config = { host: '127.0.0.1', port: 0, baseUrl: 'http://127.0.0.1', dataDir };
  const server = createServer(store, hub, config);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    root,
    async close() {
      await new Promise((r) => server.close(r));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const jget = async (u) => (await fetch(u)).json();
const jpost = async (u, body) => (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })).json();

test('health + get-or-create board by key is stable', async () => {
  const s = await startServer();
  assert.equal(await (await fetch(`${s.base}/health`)).text(), 'ok');
  const a = await jpost(`${s.base}/api/boards`, { key: '/k1', label: 'one' });
  const a2 = await jpost(`${s.base}/api/boards`, { key: '/k1' });
  assert.equal(a.id, a2.id);
  const b = await jpost(`${s.base}/api/boards`, { key: '/k2' });
  assert.notEqual(a.id, b.id);
  await s.close();
});

test('thread create + state + threads list', async () => {
  const s = await startServer();
  const { id } = await jpost(`${s.base}/api/boards`, { key: '/k' });
  const t = await jpost(`${s.base}/api/b/${id}/thread`, { title: 'N+1', tags: ['finding', 'high'] });
  const state = await jget(`${s.base}/api/b/${id}/state`);
  assert.equal(state.threads.length, 1);
  assert.deepEqual(state.threads[0].tags, ['finding', 'high']);
  const list = await jget(`${s.base}/api/b/${id}/threads`);
  assert.equal(list.threads[0].id, t.id);
  await s.close();
});

test('submit -> wait delivers reply + notes; unknown board 404s', async () => {
  const s = await startServer();
  const { id } = await jpost(`${s.base}/api/boards`, { key: '/k' });
  const t = await jpost(`${s.base}/api/b/${id}/thread`, { title: 't' });
  await jpost(`${s.base}/api/b/${id}/submit`, { replies: [{ thread_id: t.id, action: 'Fix', text: 'keep cache' }], notes: 'NOTE-A' });
  const p = await jget(`${s.base}/api/b/${id}/wait?timeout=5`);
  assert.equal(p.status, 'feedback');
  assert.equal(p.replies[0].action, 'Fix');
  assert.equal(p.notes[0].text, 'NOTE-A');

  const missing = await fetch(`${s.base}/api/b/NOPE/state`);
  assert.equal(missing.status, 404);
  await s.close();
});

test('backup writes a file', async () => {
  const s = await startServer();
  const { id } = await jpost(`${s.base}/api/boards`, { key: '/k' });
  await jpost(`${s.base}/api/b/${id}/thread`, { title: 't' });
  const r = await jpost(`${s.base}/api/b/${id}/backup`, {});
  assert.equal(r.ok, true);
  assert.ok(existsSync(r.file));
  await s.close();
});

test('serves the web UI and markdown module', async () => {
  const s = await startServer();
  const { id } = await jpost(`${s.base}/api/boards`, { key: '/k' });
  const html = await (await fetch(`${s.base}/b/${id}`)).text();
  assert.ok(html.includes('Session Threads'));
  const md = await fetch(`${s.base}/markdown.js`);
  assert.ok(md.headers.get('content-type').includes('javascript'));
  await s.close();
});
