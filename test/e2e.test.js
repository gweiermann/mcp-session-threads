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
  const expected = ['add_message', 'backup_board', 'create_thread', 'defer_thread', 'export_board', 'finish_working', 'get_board_url', 'get_notes', 'import_threads', 'list_boards', 'list_threads', 'mark_thread_done', 'reopen_thread', 'resume_thread', 'resolve_thread', 'set_summary', 'start_working', 'use_board', 'wait_for_feedback', 'work_on_thread'];
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

test('wait_for_feedback flips the board to "your turn" while blocking, and back on return', async (t) => {
  killPort();
  rmSync(DATA, { recursive: true, force: true });
  const D = makeClient('D', '/proj/turn');
  t.after(async () => { await D.client.close().catch(() => {}); killPort(); rmSync(DATA, { recursive: true, force: true }); });
  await D.client.connect(D.transport);
  const id = boardId(await urlOf(D.client));
  const tid = textOf(await D.client.callTool({ name: 'create_thread', arguments: { title: 'T' } })).match(/thread (\w+)/)[1];

  const status = async () => (await (await fetch(`${BASE}/api/b/${id}/state`)).json()).agent.status;
  const until = async (want, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await status()) === want) return true; await new Promise((r) => setTimeout(r, 40)); } return false; };

  // fire the long call without awaiting, so we can observe the blocked state
  const waiting = D.client.callTool({ name: 'wait_for_feedback', arguments: { timeout_seconds: 20 } });
  assert.ok(await until('waiting'), 'board shows "waiting" (your turn) while wait_for_feedback blocks');

  await fetch(`${BASE}/api/b/${id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ replies: [{ thread_id: tid, action: 'Approve' }], notes: '' }) });
  assert.ok(textOf(await waiting).includes('Approve'), 'submit unblocks the call with the reply');
  assert.ok(await until('idle'), 'board returns to "idle" once feedback is delivered');
});

test('defer_thread parks a thread; resume_thread un-parks it and posts a why-now message', async (t) => {
  killPort();
  rmSync(DATA, { recursive: true, force: true });
  const E = makeClient('E', '/proj/defer');
  t.after(async () => { await E.client.close().catch(() => {}); killPort(); rmSync(DATA, { recursive: true, force: true }); });
  await E.client.connect(E.transport);
  const id = boardId(await urlOf(E.client));
  const tid = textOf(await E.client.callTool({ name: 'create_thread', arguments: { title: 'Later work' } })).match(/thread (\w+)/)[1];
  const threadState = async () => (await (await fetch(`${BASE}/api/b/${id}/state`)).json()).threads.find((x) => x.id === tid);

  await E.client.callTool({ name: 'defer_thread', arguments: { thread_id: tid, reason: 'blocked on the stack landing' } });
  let th = await threadState();
  assert.equal(th.deferred, true, 'defer_thread sets deferred:true');
  assert.ok(th.messages.some((m) => m.author === 'agent' && /Deferred: blocked/.test(m.text)), 'defer reason posted as an agent note');

  await E.client.callTool({ name: 'resume_thread', arguments: { thread_id: tid, message: 'Stack landed — good time to pick this up now.' } });
  th = await threadState();
  assert.equal(th.deferred, false, 'resume_thread clears deferred');
  assert.ok(th.messages.some((m) => m.author === 'agent' && /good time to pick this up/.test(m.text)), 'resume posts the why-now recommendation');
});

test('wait_for_feedback reminds the agent of every thread awaiting its response (except deferred/done)', async (t) => {
  killPort();
  rmSync(DATA, { recursive: true, force: true });
  const G = makeClient('G', '/proj/remind');
  t.after(async () => { await G.client.close().catch(() => {}); killPort(); rmSync(DATA, { recursive: true, force: true }); });
  await G.client.connect(G.transport);
  const id = boardId(await urlOf(G.client));
  const mk = async (title) => textOf(await G.client.callTool({ name: 'create_thread', arguments: { title } })).match(/thread (\w+)/)[1];
  const addr = await mk('Address me'); // stays awaiting -> must be reminded
  const done = await mk('Marked done'); // agent marks done -> hidden from reminder
  const defer = await mk('Deferred'); // agent defers -> hidden from reminder
  const submit = (b) => fetch(`${BASE}/api/b/${id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

  // user replies to all three (delivered as pending; the next wait consumes them)
  await submit({ replies: [addr, done, defer].map((thread_id) => ({ thread_id, action: 'Look' })), notes: '' });
  // agent parks two of them
  await G.client.callTool({ name: 'mark_thread_done', arguments: { thread_id: done } });
  await G.client.callTool({ name: 'defer_thread', arguments: { thread_id: defer } });

  const out = textOf(await G.client.callTool({ name: 'wait_for_feedback', arguments: { timeout_seconds: 15 } }));
  // assert against the CHECKLIST section only (the "Feedback received" echo lists all submitted ids)
  assert.match(out, /awaiting YOUR response/, 'includes the outstanding checklist');
  const checklist = out.split('awaiting YOUR response')[1] || '';
  assert.ok(checklist.includes(addr), 'reminds about the un-parked awaiting-agent thread');
  assert.ok(!checklist.includes(done), 'a thread the agent marked done is NOT in the checklist');
  assert.ok(!checklist.includes(defer), 'a deferred thread is NOT in the checklist');
});

test('wait_for_feedback survives a daemon restart mid-wait (recovers without a manual retry)', async (t) => {
  killPort();
  rmSync(DATA, { recursive: true, force: true });
  const F = makeClient('F', '/proj/recover');
  t.after(async () => { await F.client.close().catch(() => {}); killPort(); rmSync(DATA, { recursive: true, force: true }); });
  await F.client.connect(F.transport);
  const id = boardId(await urlOf(F.client));
  const tid = textOf(await F.client.callTool({ name: 'create_thread', arguments: { title: 'Recover me' } })).match(/thread (\w+)/)[1];

  const healthy = async () => { try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; } };
  const untilHealthy = async (ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await healthy()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

  // start a long wait, let it block, then kill the daemon out from under it
  const waiting = F.client.callTool({ name: 'wait_for_feedback', arguments: { timeout_seconds: 40 } });
  await new Promise((r) => setTimeout(r, 700));
  killPort(); // simulate a code-change daemon restart while the wait is in flight

  // the client auto-restarts the daemon; once it is back, submit through it
  assert.ok(await untilHealthy(), 'daemon came back after being killed (client auto-restarted it)');
  await fetch(`${BASE}/api/b/${id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ replies: [{ thread_id: tid, action: 'Fix', text: 'still here after the bounce' }], notes: '' }) });

  assert.ok(textOf(await waiting).includes('still here after the bounce'), 'the SAME wait call recovered and returned the feedback — no manual retry needed');
});
