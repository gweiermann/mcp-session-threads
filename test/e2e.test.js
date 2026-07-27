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

  await E.client.callTool({ name: 'defer_thread', arguments: { thread_id: tid, pickup_hint: 'resume once the stack lands', reason: 'blocked on the stack landing' } });
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
  await G.client.callTool({ name: 'defer_thread', arguments: { thread_id: defer, pickup_hint: 'resume when the user asks' } });

  const out = textOf(await G.client.callTool({ name: 'wait_for_feedback', arguments: { timeout_seconds: 15 } }));
  // assert against the CHECKLIST section only — the "Feedback received" echo lists
  // every submitted id, and the parked-threads section follows the checklist.
  assert.match(out, /awaiting YOUR response/, 'includes the outstanding checklist');
  const checklist = (out.split('awaiting YOUR response')[1] || '').split('deferred thread')[0];
  assert.ok(checklist.includes(addr), 'reminds about the un-parked awaiting-agent thread');
  assert.ok(!checklist.includes(done), 'a thread the agent marked done is NOT in the checklist');
  assert.ok(!checklist.includes(defer), 'a deferred thread is NOT in the reply checklist');
});

test('an agent "status" message keeps the thread in the agent-court checklist; a plain reply does not', async (t) => {
  killPort();
  rmSync(DATA, { recursive: true, force: true });
  const H = makeClient('H', '/proj/intent');
  t.after(async () => { await H.client.close().catch(() => {}); killPort(); rmSync(DATA, { recursive: true, force: true }); });
  await H.client.connect(H.transport);
  const id = boardId(await urlOf(H.client));
  const mk = async (title) => textOf(await H.client.callTool({ name: 'create_thread', arguments: { title } })).match(/thread (\w+)/)[1];
  const working = await mk('Working thread');
  const answered = await mk('Answered thread'); // agent gave a real reply -> user's court, not reminded
  const userReplied = await mk('User replied thread');

  await H.client.callTool({ name: 'add_message', arguments: { thread_id: working, text: 'On it — here is the plan…', intent: 'status' } });
  await H.client.callTool({ name: 'add_message', arguments: { thread_id: answered, text: 'Here is the answer.' } });

  // verify intent persisted on the message
  const st = await (await fetch(`${BASE}/api/b/${id}/state`)).json();
  const wt = st.threads.find((x) => x.id === working);
  assert.equal(wt.messages[wt.messages.length - 1].intent, 'status', 'status intent persisted on the message');

  await fetch(`${BASE}/api/b/${id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ replies: [{ thread_id: userReplied, action: 'ping' }], notes: '' }) });
  const out = textOf(await H.client.callTool({ name: 'wait_for_feedback', arguments: { timeout_seconds: 15 } }));
  const checklist = out.split('awaiting YOUR response')[1] || '';
  assert.ok(checklist.includes(working), 'a status (still-working) thread stays on the agent checklist');
  assert.ok(checklist.includes(userReplied), 'a thread the user replied to is on the checklist');
  assert.ok(!checklist.includes(answered), 'a thread the agent already replied to (user\'s court) is NOT on the checklist');
});

test('prioritize_threads reorders the review list (most-important first); create_thread priority applies', async (t) => {
  killPort();
  rmSync(DATA, { recursive: true, force: true });
  const P = makeClient('P', '/proj/prio');
  t.after(async () => { await P.client.close().catch(() => {}); killPort(); rmSync(DATA, { recursive: true, force: true }); });
  await P.client.connect(P.transport);
  const id = boardId(await urlOf(P.client));
  const mk = async (title, priority) => textOf(await P.client.callTool({ name: 'create_thread', arguments: priority == null ? { title } : { title, priority } })).match(/thread (\w+)/)[1];
  const a = await mk('A');
  const b = await mk('B');
  const c = await mk('C', 5); // created already-important

  const prio = async () => { const s = await (await fetch(`${BASE}/api/b/${id}/state`)).json(); return Object.fromEntries(s.threads.map((x) => [x.id, x.priority])); };
  let p = await prio();
  assert.equal(p[c], 5, 'create_thread priority is stored');
  assert.equal(p[a], 0, 'default priority is 0');

  // reorder: B first, then A -> B highest
  await P.client.callTool({ name: 'prioritize_threads', arguments: { thread_ids: [b, a] } });
  p = await prio();
  assert.ok(p[b] > p[a] && p[a] > 0, 'listed order sets descending priority (B > A > 0)');
  assert.equal(p[c], 5, 'unlisted thread keeps its priority');
});

test('create_thread insert_after places the new thread right after the anchor (not at the top by freshness)', async (t) => {
  killPort();
  rmSync(DATA, { recursive: true, force: true });
  const I = makeClient('I', '/proj/insert');
  t.after(async () => { await I.client.close().catch(() => {}); killPort(); rmSync(DATA, { recursive: true, force: true }); });
  await I.client.connect(I.transport);
  const id = boardId(await urlOf(I.client));
  const mk = async (title, extra) => textOf(await I.client.callTool({ name: 'create_thread', arguments: { title, ...(extra || {}) } })).match(/thread (\w+)/)[1];
  const anchor = await mk('Anchor');
  await mk('Newer top'); // created after the anchor -> would sort ABOVE it by freshness
  const split = await mk('Split piece', { insert_after: anchor });

  // sort the open threads the way the UI does: priority desc, then freshness desc
  const s = await (await fetch(`${BASE}/api/b/${id}/state`)).json();
  const ts = (x) => x.updatedAt || x.createdAt;
  const order = s.threads.slice().sort((a, b) => (b.priority - a.priority) || (ts(a) < ts(b) ? 1 : ts(a) > ts(b) ? -1 : 0)).map((x) => x.id);
  assert.equal(order[order.indexOf(anchor) + 1], split, 'the split thread sorts immediately after its anchor');
});

test('deferred threads: pickup hints reach the agent, a user reply un-parks, and a resolve resolves', async (t) => {
  killPort();
  rmSync(DATA, { recursive: true, force: true });
  const D = makeClient('D2', '/proj/defer2');
  t.after(async () => { await D.client.close().catch(() => {}); killPort(); rmSync(DATA, { recursive: true, force: true }); });
  await D.client.connect(D.transport);
  const id = boardId(await urlOf(D.client));
  const mk = async (title) => textOf(await D.client.callTool({ name: 'create_thread', arguments: { title } })).match(/thread (\w+)/)[1];
  const parked = await mk('Parked work');
  const replied = await mk('Parked then replied');
  const closed = await mk('Parked then resolved');
  const ping = await mk('Something to submit with');

  for (const [tid, hint] of [[parked, 'resume after the stack rebases'], [replied, 'resume next week'], [closed, 'resume never, probably']]) {
    await D.client.callTool({ name: 'defer_thread', arguments: { thread_id: tid, pickup_hint: hint } });
  }
  const state = async () => (await (await fetch(`${BASE}/api/b/${id}/state`)).json()).threads;
  assert.equal((await state()).find((x) => x.id === parked).pickupHint, 'resume after the stack rebases', 'pickup hint stored');

  // user replies on one parked thread and resolves another (as the UI submits them)
  await fetch(`${BASE}/api/b/${id}/submit`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replies: [{ thread_id: replied, text: 'actually do it now' }, { thread_id: closed, action: 'drop it', resolve: true }, { thread_id: ping, action: 'ping' }], notes: '' }),
  });
  let th = await state();
  assert.equal(th.find((x) => x.id === replied).deferred, false, 'a user reply un-parks a deferred thread');
  assert.equal(th.find((x) => x.id === closed).status, 'resolved', 'resolving a deferred thread really resolves it');
  assert.equal(th.find((x) => x.id === closed).deferred, false, 'and clears its deferred flag');

  const out = textOf(await D.client.callTool({ name: 'wait_for_feedback', arguments: { timeout_seconds: 15 } }));
  assert.match(out, /deferred thread\(s\) parked by you/, 'wait_for_feedback reports parked threads');
  assert.ok(out.includes('resume after the stack rebases'), 'the pickup hint is injected into the result');
  const checklist = out.split('awaiting YOUR response')[1].split('deferred thread')[0];
  assert.ok(checklist.includes(replied), 'the un-parked thread is on the agent checklist');
  assert.ok(!checklist.includes(parked), 'a still-parked thread is not on the reply checklist');
});

test('retitle_thread renames without reordering or marking the thread unread', async (t) => {
  killPort();
  rmSync(DATA, { recursive: true, force: true });
  const R = makeClient('R2', '/proj/retitle');
  t.after(async () => { await R.client.close().catch(() => {}); killPort(); rmSync(DATA, { recursive: true, force: true }); });
  await R.client.connect(R.transport);
  const id = boardId(await urlOf(R.client));
  const tid = textOf(await R.client.callTool({ name: 'create_thread', arguments: { title: 'Q: should we cache this?' } })).match(/thread (\w+)/)[1];
  const before = (await (await fetch(`${BASE}/api/b/${id}/state`)).json()).threads[0];

  await R.client.callTool({ name: 'retitle_thread', arguments: { thread_id: tid, title: 'Cache this: LRU proposal' } });
  const after = (await (await fetch(`${BASE}/api/b/${id}/state`)).json()).threads[0];
  assert.equal(after.title, 'Cache this: LRU proposal', 'title updated');
  assert.equal(after.updatedAt, before.updatedAt, 'updatedAt untouched -> no reshuffle / no false unread');
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
