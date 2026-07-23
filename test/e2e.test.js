import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'src', 'mcp.js');
const PORT = '4655';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = '/tmp/rt-e2e-boards';

const killPort = () => {
  try {
    // ONLY the listening daemon — never processes that merely hold a client
    // socket (incl. this test runner's fetch keep-alive pool).
    const pids = execSync(`lsof -ti :${PORT} -sTCP:LISTEN`).toString().trim();
    if (pids) execSync(`kill -9 ${pids.split('\n').join(' ')}`);
  } catch {
    /* none */
  }
};
function makeClient(label, key) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: { ...process.env, SESSION_THREADS_PORT: PORT, SESSION_THREADS_DATA_DIR: DATA, SESSION_THREADS_BOARD_KEY: key, SESSION_THREADS_LABEL: label },
  });
  return { client: new Client({ name: label, version: '1' }), transport };
}
const boardId = (url) => (url.match(/\/b\/([\w-]+)/) || [])[1];
const urlOf = async (c) => (await c.callTool({ name: 'get_board_url', arguments: {} })).content[0].text.trim();
const textOf = (r) => r.content[0].text;

test('end-to-end: MCP proxy + daemon full flow', async (t) => {
  killPort();
  rmSync(DATA, { recursive: true, force: true });
  const A = makeClient('A', '/proj/alpha');
  const B = makeClient('B', '/proj/bravo');
  const C = makeClient('C', '/proj/alpha');

  t.after(async () => {
    await Promise.allSettled([A.client.close(), B.client.close(), C.client.close()]);
    killPort();
    rmSync(DATA, { recursive: true, force: true });
  });

  await A.client.connect(A.transport);

  const tools = (await A.client.listTools()).tools.map((x) => x.name).sort();
  const expected = ['add_message', 'backup_board', 'create_thread', 'export_board', 'finish_working', 'get_board_url', 'get_notes', 'import_threads', 'list_boards', 'list_threads', 'mark_thread_done', 'reopen_thread', 'resolve_thread', 'set_summary', 'start_working', 'use_board', 'wait_for_feedback', 'work_on_thread'];
  assert.ok(expected.every((n) => tools.includes(n)), `all ${expected.length} tools registered (got ${tools.length})`);

  const idA = boardId(await urlOf(A.client));
  assert.match(await urlOf(A.client), /^http:\/\/127\.0\.0\.1:4655\/b\/[\w-]+$/);

  const created = textOf(await A.client.callTool({ name: 'create_thread', arguments: { title: 'N+1', body: '| a | b |\n|---|---|\n| 1 | 2 |', tags: ['finding', 'high'] } }));
  const tid = created.match(/thread (\w+)/)[1];

  // different key -> different board
  await B.client.connect(B.transport);
  const idB = boardId(await urlOf(B.client));
  assert.notEqual(idB, idA, 'different key -> different board');

  // same key across a fresh connection -> SAME board (no drift)
  await C.client.connect(C.transport);
  assert.equal(boardId(await urlOf(C.client)), idA, 'same key -> same board (stable, no drift)');

  // progress
  await A.client.callTool({ name: 'work_on_thread', arguments: { thread_id: tid } });
  await A.client.callTool({ name: 'mark_thread_done', arguments: { thread_id: tid } });
  const st = await (await fetch(`${BASE}/api/b/${idA}/state`)).json();
  assert.equal(st.agent.currentThreadId, tid);
  assert.equal(st.threads[0].work, 'done');

  // submit x2 (no read between) -> both notes survive
  const submit = (b) => fetch(`${BASE}/api/b/${idA}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  await submit({ replies: [{ thread_id: tid, action: 'Fix', text: 'keep cache' }], notes: 'NOTE-A' });
  await submit({ replies: [], notes: 'NOTE-B' });
  const fb = textOf(await A.client.callTool({ name: 'wait_for_feedback', arguments: { timeout_seconds: 15 } }));
  assert.ok(fb.includes('keep cache') && fb.includes('NOTE-A') && fb.includes('NOTE-B'), 'reply + both notes delivered');

  // loud failure (the old silent-404 bug)
  const bad = await A.client.callTool({ name: 'add_message', arguments: { thread_id: 'does-not-exist', text: 'x' } });
  assert.ok(bad.isError === true || /fail|error|no such thread/i.test(textOf(bad)), 'write to missing thread fails loudly');

  // import history into B; switch session; backup
  await B.client.callTool({ name: 'import_threads', arguments: { from_board_id: idA } });
  const stB = await (await fetch(`${BASE}/api/b/${idB}/state`)).json();
  assert.ok(stB.threads.length === 1 && stB.threads[0].messages.some((m) => m.author === 'user'), 'import copied threads with history');
  await B.client.callTool({ name: 'use_board', arguments: { board_id: idA } });
  assert.equal(boardId(await urlOf(B.client)), idA, 'use_board switched session');
  assert.match(textOf(await A.client.callTool({ name: 'backup_board', arguments: {} })), /backups\/.*\.json/);
});
