import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedbackHub } from '../src/feedback.js';

test('a waiting caller is woken the instant feedback is delivered', async () => {
  const hub = new FeedbackHub();
  const p = hub.wait('b1', 1000);
  hub.deliver('b1', [{ thread_id: 't1', action: 'Fix' }]);
  const r = await p;
  assert.equal(r.status, 'feedback');
  assert.equal(r.replies.length, 1);
});

test('feedback delivered before a wait is queued and returned immediately', async () => {
  const hub = new FeedbackHub();
  hub.deliver('b1', [{ thread_id: 't1' }]);
  const r = await hub.wait('b1', 50);
  assert.equal(r.status, 'feedback');
  assert.equal(r.replies.length, 1);
});

test('two deliveries with no waiter accumulate into the next wait', async () => {
  const hub = new FeedbackHub();
  hub.deliver('b1', [{ thread_id: 'a' }]);
  hub.deliver('b1', [{ thread_id: 'b' }]);
  const r = await hub.wait('b1', 50);
  assert.deepEqual(r.replies.map((x) => x.thread_id), ['a', 'b']);
});

test('wait times out cleanly when nothing arrives', async () => {
  const hub = new FeedbackHub();
  const r = await hub.wait('b1', 20);
  assert.equal(r.status, 'timeout');
  assert.deepEqual(r.replies, []);
});

test('boards are isolated', async () => {
  const hub = new FeedbackHub();
  const p = hub.wait('b1', 40);
  hub.deliver('b2', [{ thread_id: 'x' }]); // different board must not wake b1
  const r = await p;
  assert.equal(r.status, 'timeout');
});
