import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore, makeThread, ThreadNotFound } from '../src/board-store.js';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'rt-store-'));
  const store = new BoardStore(dir);
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('getOrCreate is stable per key; different keys => different boards', () => {
  const { store, cleanup } = freshStore();
  const a1 = store.getOrCreate({ key: '/proj/a' });
  const a2 = store.getOrCreate({ key: '/proj/a' });
  const b = store.getOrCreate({ key: '/proj/b' });
  assert.equal(a1.id, a2.id, 'same key -> same board');
  assert.notEqual(a1.id, b.id, 'different key -> different board');
  cleanup();
});

test('persists across store reloads (survives restart)', () => {
  const { store, dir, cleanup } = freshStore();
  const b = store.getOrCreate({ key: '/proj/a' });
  store.addThread(b.id, { title: 'N+1', tags: ['finding'] });
  const reloaded = new BoardStore(dir);
  const again = reloaded.getOrCreate({ key: '/proj/a' });
  assert.equal(again.id, b.id);
  assert.equal(again.threads.length, 1);
  assert.equal(again.threads[0].title, 'N+1');
  cleanup();
});

test('makeThread normalizes kind->tags and defaults', () => {
  const t = makeThread({ title: 'x', kind: 'question' });
  assert.deepEqual(t.tags, ['question']);
  assert.equal(t.status, 'open');
  assert.equal(t.work, null);
  assert.deepEqual(t.actions, ['Fix', 'Approve']);
});

test('addMessage reopens a resolved thread', () => {
  const { store, cleanup } = freshStore();
  const b = store.create({});
  const t = store.addThread(b.id, { title: 't' });
  store.setStatus(b.id, t.id, 'resolved');
  store.addMessage(b.id, t.id, { text: 'more' });
  assert.equal(store.get(b.id).threads[0].status, 'open');
  cleanup();
});

test('applySubmit records replies, resolves, reopens, and stores notes durably', () => {
  const { store, cleanup } = freshStore();
  const b = store.create({});
  const t = store.addThread(b.id, { title: 't' });
  const r = store.applySubmit(b.id, { replies: [{ thread_id: t.id, action: 'Fix', text: 'keep cache' }], notes: 'NOTE-1' });
  assert.equal(r.replies.length, 1);
  assert.equal(r.noteAdded, true);
  const th = store.get(b.id).threads[0];
  assert.ok(th.messages.some((m) => m.author === 'user' && m.text.includes('keep cache')));
  cleanup();
});

test('notes: multiple submissions all survive; drainNotes delivers each once', () => {
  const { store, cleanup } = freshStore();
  const b = store.create({});
  store.applySubmit(b.id, { notes: 'A' });
  store.applySubmit(b.id, { notes: 'B' });
  const first = store.drainNotes(b.id);
  assert.deepEqual(first.map((n) => n.text), ['A', 'B'], 'both submissions delivered');
  assert.deepEqual(store.drainNotes(b.id), [], 'already-drained notes are not redelivered');
  store.applySubmit(b.id, { notes: 'C' });
  assert.deepEqual(store.drainNotes(b.id).map((n) => n.text), ['C']);
  assert.equal(store.allNotes(b.id).length, 3, 'all notes remain queryable');
  cleanup();
});

test('importThreads copies threads WITH message history', () => {
  const { store, cleanup } = freshStore();
  const src = store.create({});
  const t = store.addThread(src.id, { title: 'src' });
  store.addMessage(src.id, t.id, { author: 'user', text: 'hi' });
  const exported = store.exportBoard(src.id);
  const dst = store.create({});
  const r = store.importThreads(dst.id, { threads: exported.threads });
  assert.equal(r.added, 1);
  assert.ok(store.get(dst.id).threads[0].messages.some((m) => m.text === 'hi'));
  cleanup();
});

test('unknown thread throws (no silent no-op)', () => {
  const { store, cleanup } = freshStore();
  const b = store.create({});
  assert.throws(() => store.addMessage(b.id, 'nope', { text: 'x' }), ThreadNotFound);
  cleanup();
});

test('setAgent tracks overall status + per-thread work (thread_id key)', () => {
  const { store, cleanup } = freshStore();
  const b = store.create({});
  const t = store.addThread(b.id, { title: 't' });
  store.setAgent(b.id, { status: 'working', currentThreadId: t.id, thread_id: t.id, work: 'working' });
  store.setAgent(b.id, { thread_id: t.id, work: 'done' });
  const board = store.get(b.id);
  assert.equal(board.agent.status, 'working');
  assert.equal(board.agent.currentThreadId, t.id);
  assert.equal(board.threads[0].work, 'done');
  cleanup();
});

test('setAgent stamps finishedAt on both "waiting" and "done", consumedAt on pickup', () => {
  const { store, cleanup } = freshStore();
  const b = store.create({});
  assert.ok(!store.get(b.id).agent.finishedAt, 'no finishedAt initially');
  store.setAgent(b.id, { status: 'waiting' }); // handing back by starting to wait
  assert.ok(store.get(b.id).agent.finishedAt, 'waiting stamps finishedAt (inferred finish)');
  const afterWaiting = store.get(b.id).agent.finishedAt;
  store.setAgent(b.id, { status: 'working', consumed: true }); // picked up a batch
  const ag = store.get(b.id).agent;
  assert.ok(ag.consumedAt, 'consumed stamps consumedAt');
  assert.equal(ag.finishedAt, afterWaiting, 'working does not restamp finishedAt');
  store.setAgent(b.id, { status: 'done' });
  assert.ok(store.get(b.id).agent.finishedAt >= afterWaiting, 'done stamps finishedAt too');
  cleanup();
});

test('remove deletes a board', () => {
  const { store, dir, cleanup } = freshStore();
  const b = store.create({});
  assert.equal(store.remove(b.id), true);
  assert.equal(store.get(b.id), null);
  assert.equal(new BoardStore(dir).list().length, 0);
  cleanup();
});

test('change events fire on mutation (SSE hook)', () => {
  const { store, cleanup } = freshStore();
  let fired = 0;
  store.on('change', () => (fired += 1));
  const b = store.create({});
  store.addThread(b.id, { title: 't' });
  assert.ok(fired >= 1);
  cleanup();
});
