// stories.js — the component storybook.
//
// Everything here is rendered by the SAME modules the live board runs:
//   thread-logic.js  — the situation → decision layer (predicates, statusChip)
//   components.js     — the presentational builders (card, chip, bubble, …)
// A story is just a thread fixture + a context; we bind the real logic to it and
// render the real component. So a situation you see (or dial up in the Sandbox)
// classifies and paints exactly as it would on the board.

import { bind, DEFAULT_ACTIONS } from '/thread-logic.js';
import { chip, statusChipEl, renderTags, bubbleEl, chatBubble, pendingBubble, threadCard } from '/components.js';

const root = document.getElementById('sb-root');
const toc = document.getElementById('toc');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ---- fixture helpers -------------------------------------------------------

// A stable clock for fixtures (real Date is fine in the browser). Times are
// expressed as "seconds since a base"; bigger = fresher.
const BASE = Date.parse('2026-08-05T10:00:00Z');
const at = (sec) => new Date(BASE + sec * 1000).toISOString();

let seq = 0;
function thread(over = {}) {
  const id = over.id || 'st' + (++seq).toString(36).padStart(2, '0');
  return {
    id,
    title: over.title || 'Example thread',
    body: 'body' in over ? over.body : 'Some agent finding or question about the code.',
    tags: over.tags || [],
    status: over.status || 'open',
    deferred: over.deferred || false,
    pickupHint: over.pickupHint || '',
    priority: over.priority || 0,
    work: over.work || null,
    createdBy: over.createdBy || 'agent',
    actions: over.actions || [...DEFAULT_ACTIONS],
    messages: over.messages || [],
    createdAt: over.createdAt || at(0),
    updatedAt: over.updatedAt || at(over.messages && over.messages.length ? over.messages[over.messages.length - 1]._sec || 10 : 10),
  };
}
// message shorthands
const aMsg = (text, sec, intent) => ({ author: 'agent', text, ts: at(sec), _sec: sec, ...(intent ? { intent } : {}) });
const uMsg = (text, sec) => ({ author: 'user', text, ts: at(sec), _sec: sec });

// Build a ctx for a set of threads. drafts/readMarks/agent overridable.
function makeCtx({ threads, agent = {}, drafts = {}, readMarks = {} }) {
  return {
    agent: { status: 'idle', activity: '', consumedAt: null, finishedAt: null, ...agent },
    threads,
    drafts,
    readMarks,
  };
}

// The predicates we surface in each story's decision panel.
const PRED_NAMES = ['isUnread', 'needsAttention', 'isAnswered', 'awaitingAgent', 'ignoredByAgent', 'notPickedUp', 'isStaged', 'isRead', 'isDeferred', 'needsInput', 'agentWorkingLast'];

// ---- section / story rendering --------------------------------------------

function section(id, title, note) {
  const s = el('section', 'sb-section'); s.id = id;
  s.appendChild(el('h2', null, title));
  if (note) s.appendChild(el('div', 'sb-note', note));
  const a = el('a', null, title); a.href = '#' + id; toc.appendChild(a);
  root.appendChild(s);
  return s;
}
function grid(parent) { const g = el('div', 'sb-grid'); parent.appendChild(g); return g; }

// One card story: real threadCard + a decision panel showing the chip + predicates.
function cardStory(host, { title, desc, trigger, thread: t, ctx }) {
  const L = bind(ctx);
  const box = el('div', 'sb-story');
  const head = el('div', 'sb-story-head');
  head.appendChild(el('div', 'sb-title', title));
  if (desc) head.appendChild(el('div', 'sb-desc', desc));
  if (trigger) head.appendChild(el('div', 'sb-trigger', trigger));
  box.appendChild(head);

  const stage = el('div', 'sb-stage');
  stage.appendChild(threadCard(t, L, { onOpen: () => {} }));
  box.appendChild(stage);

  box.appendChild(decisionPanel(t, L));
  host.appendChild(box);
}

function decisionPanel(t, L) {
  const d = el('div', 'sb-decision');
  d.appendChild(el('div', 'sb-dlabel', 'Decision (shared logic)'));
  const desc = L.statusChipDescriptor(t);
  const chipLine = el('div');
  chipLine.style.marginBottom = '8px';
  chipLine.appendChild(document.createTextNode('statusChip → '));
  if (desc) chipLine.appendChild(chip(desc.text, desc.cls));
  else { const none = el('span', 'sb-pred f', 'null (unread dot only)'); chipLine.appendChild(none); }
  d.appendChild(chipLine);

  const preds = el('div', 'sb-preds');
  for (const name of PRED_NAMES) {
    let v = false;
    try { v = !!L[name](t); } catch { v = false; }
    preds.appendChild(el('span', 'sb-pred ' + (v ? 't' : 'f'), name + (v ? '✓' : '✗')));
  }
  d.appendChild(preds);
  return d;
}

// ===========================================================================
// 0. SANDBOX — dial any situation by hand and watch the shared logic classify it
// ===========================================================================
function sandbox() {
  const s = section('sandbox', 'Sandbox', 'Change any field and the card, chip, and predicate table below re-render through the real thread-logic. This is the "simulate a situation and verify it by hand" tool — every control maps to a field the board reads.');
  const wrap = el('div', 'sb-sandbox');
  const controls = el('div', 'sb-controls');
  const out = el('div', 'sb-sandbox-out');
  wrap.append(controls, out);
  s.appendChild(wrap);

  const model = {
    status: 'open', deferred: false, work: '', createdBy: 'agent',
    lastAuthor: 'agent', intent: '', staged: false, stagedAction: 'Fix',
    read: false, agentStatus: 'idle', pickedUp: false, finished: false,
  };

  const select = (label, key, opts) => {
    const c = el('div', 'sb-ctrl'); c.appendChild(el('label', null, label));
    const sel = el('select');
    for (const o of opts) { const op = el('option', null, o.label); op.value = o.value; sel.appendChild(op); }
    sel.value = model[key];
    sel.onchange = () => { model[key] = sel.value; renderOut(); };
    c.appendChild(sel); controls.appendChild(c); return sel;
  };
  const check = (label, key) => {
    const c = el('div', 'sb-ctrl row'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = model[key];
    cb.onchange = () => { model[key] = cb.checked; renderOut(); };
    const lab = el('label', null, label); lab.prepend(cb);
    c.appendChild(lab); controls.appendChild(c);
  };

  select('Thread status', 'status', [{ label: 'open', value: 'open' }, { label: 'resolved', value: 'resolved' }]);
  check('deferred (parked)', 'deferred');
  select('Agent work marker', 'work', [{ label: '(none)', value: '' }, { label: 'seen 👀', value: 'seen' }, { label: 'working ⚙', value: 'working' }, { label: 'done ✓', value: 'done' }]);
  select('Created by', 'createdBy', [{ label: 'agent', value: 'agent' }, { label: 'you', value: 'user' }]);
  select('Last message from', 'lastAuthor', [{ label: '(no messages)', value: 'none' }, { label: 'agent', value: 'agent' }, { label: 'you', value: 'user' }]);
  select('…agent message intent', 'intent', [{ label: '(none)', value: '' }, { label: 'status (working)', value: 'status' }, { label: 'question', value: 'question' }, { label: 'proposal', value: 'proposal' }, { label: 'discussion', value: 'discussion' }, { label: 'done', value: 'done' }]);
  check('you staged a reply (not submitted)', 'staged');
  select('…staged action', 'stagedAction', [{ label: 'Fix', value: 'Fix' }, { label: 'Approve', value: 'Approve' }, { label: '(text only)', value: '' }]);
  check('you marked it read', 'read');
  select('Agent status', 'agentStatus', [{ label: 'idle', value: 'idle' }, { label: 'working', value: 'working' }, { label: 'waiting', value: 'waiting' }]);
  check('agent picked up your last reply', 'pickedUp');
  check('agent finished a round after pickup', 'finished');

  // card + chip + predicate readout
  const cardOut = el('div', 'sb-outbox'); cardOut.appendChild(el('h4', null, 'Rendered card')); const cardHost = el('div'); cardOut.appendChild(cardHost);
  const chipReadout = el('div', 'sb-chip-readout'); cardOut.appendChild(chipReadout);
  const predOut = el('div', 'sb-outbox'); predOut.appendChild(el('h4', null, 'Predicates (thread-logic)')); const predHost = el('div', 'sb-preds'); predOut.appendChild(predHost);
  out.append(cardOut, predOut);

  function build() {
    // reply timestamp is older than pickup/finish so the picked-up / ignored math works
    const rSec = 10;
    const messages = [];
    if (model.lastAuthor === 'agent') messages.push(aMsg('Agent message.', rSec, model.intent || undefined));
    else if (model.lastAuthor === 'user') messages.push(uMsg('Your reply.', rSec));
    const t = thread({
      id: 'sandbox', title: 'Sandbox thread', status: model.status, deferred: model.deferred,
      work: model.work || null, createdBy: model.createdBy, messages, updatedAt: at(rSec + 1),
    });
    const drafts = {};
    if (model.staged) drafts[t.id] = { action: model.stagedAction || null, text: model.stagedAction ? '' : 'looks good', resolve: false, saved: true };
    const readMarks = {};
    if (model.read) readMarks[t.id] = at(rSec + 100);
    const agent = { status: model.agentStatus, activity: 'Refactoring auth', consumedAt: model.pickedUp ? at(rSec + 2) : null, finishedAt: model.finished ? at(rSec + 3) : null };
    return { t, ctx: makeCtx({ threads: [t], drafts, readMarks, agent }) };
  }

  function renderOut() {
    const { t, ctx } = build();
    const L = bind(ctx);
    cardHost.innerHTML = ''; cardHost.appendChild(threadCard(t, L, { onOpen: () => {} }));
    const d = L.statusChipDescriptor(t);
    chipReadout.textContent = 'statusChip → ' + (d ? `{ text: "${d.text}", cls: "${d.cls}" }` : 'null  (no chip — unread dot only)');
    predHost.innerHTML = '';
    for (const name of PRED_NAMES) {
      let v = false; try { v = !!L[name](t); } catch {}
      predHost.appendChild(el('span', 'sb-pred ' + (v ? 't' : 'f'), name + (v ? '✓' : '✗')));
    }
  }
  renderOut();
}

// ===========================================================================
// 1. STATUS CHIPS — every branch of statusChipDescriptor(), in precedence order
// ===========================================================================
function statusChips() {
  const s = section('chips', 'Status chips — every situation', 'The one chip a thread shows at a glance. statusChipDescriptor() checks these in order; the first match wins. Each card below is the minimal board state that triggers that branch.');
  const g = grid(s);
  const mk = (over, agent, drafts, readMarks) => { const t = thread(over); return { thread: t, ctx: makeCtx({ threads: [t], agent, drafts, readMarks }) }; };

  cardStory(g, { title: '1 · resolved', desc: 'Closed — history.', trigger: "status: 'resolved'", ...mk({ title: 'Fix null deref in parser', status: 'resolved' }) });

  cardStory(g, { title: '2 · deferred', desc: 'Agent parked it in the Deferred lane until later.', trigger: 'deferred: true', ...mk({ title: 'Revisit caching after the API lands', deferred: true, pickupHint: 'once the API ships' }) });

  { const t = thread({ title: 'Rename userSvc → accountSvc' }); cardStory(g, { title: '3 · staged reply (pending)', desc: 'You picked an action but have not submitted yet.', trigger: "drafts[id] = { action:'Fix', saved:true }", thread: t, ctx: makeCtx({ threads: [t], drafts: { [t.id]: { action: 'Fix', text: '', resolve: false, saved: true } } }) }); }

  cardStory(g, { title: '4 · agent done', desc: 'Agent set its per-thread marker to done.', trigger: "work: 'done'", ...mk({ title: 'Add index on orders.created_at', work: 'done' }) });

  { // ignored by agent: you replied last, agent consumed then finished without answering
    const t = thread({ title: 'Should we log PII here?', messages: [aMsg('Proposed change.', 5), uMsg('No — redact it first.', 10)], updatedAt: at(10) });
    cardStory(g, { title: '5 · ignored by agent', desc: 'You replied, the agent picked it up and finished a round without answering.', trigger: 'consumedAt ≥ reply.ts  &&  finishedAt ≥ consumedAt', thread: t, ctx: makeCtx({ threads: [t], agent: { consumedAt: at(11), finishedAt: at(12) } }) });
  }

  cardStory(g, { title: '6 · working', desc: 'Agent marked this thread as in-progress.', trigger: "work: 'working'", ...mk({ title: 'Extract retry helper', work: 'working' }) });

  cardStory(g, { title: '7 · seen', desc: 'Agent acknowledged it but has not started.', trigger: "work: 'seen'", ...mk({ title: 'Typo in error message', work: 'seen' }) });

  { const t = thread({ title: 'Migrating the config loader…', messages: [aMsg('Working on it — halfway through.', 8, 'status')], updatedAt: at(8) });
    cardStory(g, { title: '8 · working (status message)', desc: "Agent's last message is a status update → still its turn.", trigger: "last msg: agent, intent:'status'", thread: t, ctx: makeCtx({ threads: [t] }) }); }

  { const t = thread({ title: 'Use const over let here', messages: [aMsg('Suggest const.', 5), uMsg('Agreed, go ahead.', 10)], updatedAt: at(10) });
    cardStory(g, { title: '9 · replied (not picked up)', desc: 'You replied; the agent has not consumed the batch yet.', trigger: 'you replied last  &&  consumedAt < reply.ts', thread: t, ctx: makeCtx({ threads: [t], agent: { consumedAt: null } }) }); }

  { const t = thread({ title: 'Split this 300-line function', messages: [aMsg('Here is a plan.', 5), uMsg('Do it.', 10)], updatedAt: at(10) });
    cardStory(g, { title: '10 · waiting on agent', desc: 'Your reply was picked up but the round is not finished.', trigger: 'consumedAt ≥ reply.ts  &&  finishedAt < consumedAt', thread: t, ctx: makeCtx({ threads: [t], agent: { status: 'working', consumedAt: at(11), finishedAt: null } }) }); }

  { const t = thread({ title: 'Nit: trailing whitespace', messages: [aMsg('Minor: trailing whitespace on L42.', 10)], updatedAt: at(10) });
    cardStory(g, { title: '11 · read (acknowledged)', desc: 'You marked it read without replying.', trigger: 'readMarks[id] ≥ updatedAt', thread: t, ctx: makeCtx({ threads: [t], readMarks: { [t.id]: at(20) } }) }); }

  { const t = thread({ title: 'Which timeout — 5s or 30s?', messages: [aMsg('Should the timeout be 5s or 30s?', 10, 'question')], updatedAt: at(10) });
    cardStory(g, { title: '12 · needs your input', desc: "Agent's last message asks a question / proposal / discussion.", trigger: "last msg: agent, intent:'question'", thread: t, ctx: makeCtx({ threads: [t] }) }); }

  { const t = thread({ title: 'Consider batching these writes', messages: [aMsg('You could batch these DB writes.', 10)], updatedAt: at(10) });
    cardStory(g, { title: '13 · fresh finding (no chip)', desc: 'A plain finding on your plate — only the unread dot, no chip.', trigger: 'agent finding, no intent, not read', thread: t, ctx: makeCtx({ threads: [t] }) }); }
}

// ===========================================================================
// 2. CARD VARIANTS — the row's own visual states
// ===========================================================================
function cardVariants() {
  const s = section('cards', 'Card variants', 'The same threadCard, in the visual states the list uses: the accent-bar unread card, the dimmed "handled" card, the dashed deferred card, the faded resolved card, and the keyboard-selected outline.');
  const g = grid(s);
  const one = (over, ctxOver, label, desc, extraClass) => {
    const t = thread(over); const ctx = makeCtx({ threads: [t], ...ctxOver });
    const L = bind(ctx);
    const box = el('div', 'sb-story'); const head = el('div', 'sb-story-head');
    head.appendChild(el('div', 'sb-title', label)); if (desc) head.appendChild(el('div', 'sb-desc', desc)); box.appendChild(head);
    const stage = el('div', 'sb-stage'); const card = threadCard(t, L, { onOpen: () => {} });
    if (extraClass) card.classList.add(extraClass);
    stage.appendChild(card); box.appendChild(stage); g.appendChild(box);
  };
  one({ title: 'Unread finding (accent bar + dot)', messages: [aMsg('New finding.', 10)] }, {}, 'unread', 'needs your response — left accent bar, bold title, blue dot');
  { const t = thread({ title: 'Handled — dimmed' }); one({ title: 'Handled — dimmed (staged)', id: t.id }, { drafts: { [t.id]: undefined } }, 'replied', 'dimmed once handled'); }
  one({ title: 'Deferred — dashed border', deferred: true }, {}, 'deferred (dashed)', 'parked: faded, dashed outline');
  one({ title: 'Resolved — faded', status: 'resolved' }, {}, 'resolved', 'closed: most faded');
  one({ title: 'Selected (keyboard j/k)', messages: [aMsg('x', 10)] }, {}, 'selected', 'the .sel outline the keyboard cursor adds', 'sel');
}

// ===========================================================================
// 3. MESSAGE BUBBLES — agent intents, user, pending, markdown
// ===========================================================================
function bubbles() {
  const s = section('bubbles', 'Message bubbles', 'Chat bubbles as bubbleEl() builds them. Agent intents only change the small caption + its colour — the body stays a normal readable bubble. User replies sit on the right; a staged reply shows as a dashed pending bubble.');
  const g = grid(s);
  const story = (title, desc, build) => {
    const box = el('div', 'sb-story'); const head = el('div', 'sb-story-head');
    head.appendChild(el('div', 'sb-title', title)); if (desc) head.appendChild(el('div', 'sb-desc', desc)); box.appendChild(head);
    const stage = el('div', 'sb-stage'); const bb = el('div', 'sb-bubbles chat-inner'); build(bb); stage.appendChild(bb); box.appendChild(stage); g.appendChild(box);
  };
  story('agent · plain', 'no intent', (b) => b.appendChild(bubbleEl(aMsg('A plain agent finding with no intent.', 1))));
  story('agent · status (working)', "intent:'status' → amber caption", (b) => b.appendChild(bubbleEl(aMsg('Still refactoring the loader — about halfway.', 1, 'status'))));
  story('agent · question', "intent:'question'", (b) => b.appendChild(bubbleEl(aMsg('Should this be configurable, or hard-code 30s?', 1, 'question'))));
  story('agent · proposal', "intent:'proposal'", (b) => b.appendChild(bubbleEl(aMsg('Proposal: extract a `RetryPolicy` and inject it.', 1, 'proposal'))));
  story('agent · discussion', "intent:'discussion'", (b) => b.appendChild(bubbleEl(aMsg('Worth discussing whether we even need this cache.', 1, 'discussion'))));
  story('agent · done', "intent:'done' → green caption", (b) => b.appendChild(bubbleEl(aMsg('Done — extracted and tests pass.', 1, 'done'))));
  story('agent · unknown intent', 'falls back to the generic caption style', (b) => b.appendChild(bubbleEl(aMsg('Something with a novel intent value.', 1, 'brainstorm'))));
  story('you (user reply)', 'right-aligned, green caption', (b) => b.appendChild(bubbleEl(uMsg('Go with 30s and make it configurable.', 2))));
  story('a back-and-forth', 'agent finding → your reply → agent status', (b) => { b.appendChild(bubbleEl(aMsg('This query is N+1.', 1))); b.appendChild(bubbleEl(uMsg('Batch it.', 2))); b.appendChild(bubbleEl(aMsg('On it.', 3, 'status'))); });
  story('pending (staged) reply', 'the dashed bubble for an un-submitted reply', (b) => b.appendChild(pendingBubble(thread(), { action: 'Fix', text: 'rename it and add a test', resolve: true, saved: true })));
  story('markdown rendering', 'bubbleEl renders markdown: code, lists, file links', (b) => b.appendChild(bubbleEl(aMsg('Change `getUser()` in [auth.js:42](src/auth.js:42):\n\n- guard the null case\n- add a test\n\n```js\nif (!u) return null;\n```', 1))));
  story('thread body + reply', 'chatBubble for the body, then a message', (b) => { b.appendChild(chatBubble('agent', 'The parser drops the last token on empty input.')); b.appendChild(bubbleEl(uMsg('Nice catch — fix it.', 2))); });
}

// ===========================================================================
// 4. TAGS & BADGES — the keyword → colour mapping
// ===========================================================================
function tags() {
  const s = section('tags', 'Tags & badges', 'renderTags() colours each tag by keyword (tagClass). The "you" badge marks threads you opened.');
  const g = grid(s);
  const story = (title, over, extra) => {
    const t = thread(over);
    const box = el('div', 'sb-story'); const head = el('div', 'sb-story-head'); head.appendChild(el('div', 'sb-title', title)); box.appendChild(head);
    const stage = el('div', 'sb-stage'); const host = el('div', 'detail-head'); host.style.display = 'flex'; host.style.gap = '6px'; host.style.flexWrap = 'wrap';
    if (extra === 'you') { const y = el('span', 'badge you', 'you'); host.appendChild(y); }
    renderTags(host, t); stage.appendChild(host); box.appendChild(stage); g.appendChild(box);
  };
  story('red — critical / bug / security', { tags: ['critical', 'bug', 'security'] });
  story('amber — medium / todo / warning', { tags: ['medium', 'todo', 'warning'] });
  story('muted — nit / info / minor', { tags: ['nit', 'info', 'minor'] });
  story('blue — question / decide / discuss', { tags: ['question', 'decide', 'discuss'] });
  story('green — approved / lgtm / passing', { tags: ['approved', 'lgtm', 'passing'] });
  story('default — unrecognised', { tags: ['refactor', 'housekeeping'] });
  story('“you” badge (user-created)', { tags: ['question'] }, 'you');
}

// ===========================================================================
// 5. LIST GROUPING — openThreads() splits & orders the board
// ===========================================================================
function listGrouping() {
  const s = section('grouping', 'List grouping & ordering', 'The overview groups threads with the SAME openThreads()/isUnread the board uses: "Needs your attention" (unread, priority-sorted) first, then "Waiting on agent", then Deferred and Resolved lanes. This mini-board is one fixture rendered through that logic.');
  const threads = [
    thread({ title: 'CRITICAL: SQL injection in search', tags: ['critical', 'security'], priority: 5, messages: [aMsg('User input reaches the query unescaped.', 30)], updatedAt: at(30) }),
    thread({ title: 'Should we cache this?', tags: ['question'], messages: [aMsg('Cache the results?', 25, 'question')], updatedAt: at(25) }),
    thread({ title: 'Rename for clarity', messages: [aMsg('rename x→count', 20)], updatedAt: at(20) }),
    thread({ title: 'Extracting the helper…', work: 'working', messages: [aMsg('Working on it.', 18, 'status')], updatedAt: at(18) }),
    thread({ title: 'Batch the writes', messages: [aMsg('plan', 10), uMsg('do it', 15)], updatedAt: at(15) }),
    thread({ title: 'Revisit after API lands', deferred: true, pickupHint: 'after API', messages: [aMsg('parking this', 12)], updatedAt: at(12) }),
    thread({ title: 'Fixed the typo', status: 'resolved', messages: [aMsg('done', 5), uMsg('Approve', 6)], updatedAt: at(6) }),
  ];
  const ctx = makeCtx({ threads, agent: { status: 'waiting', consumedAt: at(16), finishedAt: at(17) } });
  const L = bind(ctx);

  const board = el('div', 'list-inner'); board.style.maxWidth = '760px';
  const open = L.openThreads();
  const attn = open.filter(L.isUnread);
  const waiting = open.filter((t) => !L.isUnread(t));
  const deferred = threads.filter(L.isDeferred);
  const resolved = threads.filter((t) => t.status === 'resolved');

  const sect = (label) => { const h = el('div', 'section-title', label); board.appendChild(h); };
  sect(`Needs your attention — ${attn.length}`); attn.forEach((t) => board.appendChild(threadCard(t, L, { onOpen: () => {} })));
  if (waiting.length) { sect(`Waiting on agent — ${waiting.length}`); waiting.forEach((t) => board.appendChild(threadCard(t, L, { onOpen: () => {} }))); }
  if (deferred.length) { sect(`Deferred — ${deferred.length}`); deferred.forEach((t) => board.appendChild(threadCard(t, L, { onOpen: () => {} }))); }
  if (resolved.length) { sect(`Resolved — ${resolved.length}`); resolved.forEach((t) => board.appendChild(threadCard(t, L, { onOpen: () => {} }))); }
  s.appendChild(board);
}

// ===========================================================================
// 6. HEADER & PROGRESS — headerModel() across whose-turn permutations
// ===========================================================================
function headerStates() {
  const s = section('header', 'Header & progress', 'The counts line, the progress bar, and the browser-tab title all come from headerModel(). It switches dimension by whose turn it is: green (agent progress) while the agent works, blue (your replies) otherwise.');
  const g = grid(s); g.style.gridTemplateColumns = 'repeat(auto-fill, minmax(420px, 1fr))';

  const scenarios = [
    {
      title: 'Agent working', desc: 'green bar leads with the agent’s done-count',
      threads: [thread({ work: 'done', messages: [aMsg('x', 5), uMsg('y', 6)], updatedAt: at(6) }), thread({ work: 'working', messages: [aMsg('z', 7, 'status')], updatedAt: at(7) }), thread({ messages: [aMsg('needs you', 8)], updatedAt: at(8) })],
      agent: { status: 'working', activity: 'Refactoring auth', consumedAt: at(6), finishedAt: null },
    },
    {
      title: 'Your turn (waiting)', desc: 'blue bar; “N to reply”',
      threads: [thread({ messages: [aMsg('a', 8)], updatedAt: at(8) }), thread({ messages: [aMsg('b', 9, 'question')], updatedAt: at(9) })],
      agent: { status: 'waiting' },
    },
    {
      title: 'All answered — ready', desc: 'every thread on your plate handled',
      threads: (() => { const t1 = thread({ id: 'h1', messages: [aMsg('a', 8)], updatedAt: at(8) }); const t2 = thread({ id: 'h2', messages: [aMsg('b', 9)], updatedAt: at(9) }); return [t1, t2]; })(),
      drafts: { h1: { action: 'Fix', saved: true }, h2: { action: 'Approve', saved: true } }, agent: { status: 'waiting' },
    },
    { title: 'Idle / empty board', desc: 'no threads', threads: [], agent: { status: 'idle' } },
  ];

  for (const sc of scenarios) {
    const ctx = makeCtx({ threads: sc.threads, agent: sc.agent, drafts: sc.drafts || {} });
    const L = bind(ctx); const h = L.headerModel();
    const box = el('div', 'sb-story'); const head = el('div', 'sb-story-head'); head.appendChild(el('div', 'sb-title', sc.title)); head.appendChild(el('div', 'sb-desc', sc.desc)); box.appendChild(head);
    const stage = el('div', 'sb-stage');
    const bar = el('div', 'sb-headerbar');
    const fh = el('div', 'fake-header');
    fh.appendChild(el('span', 'agent-activity', h.activityText));
    const spacer = el('span'); spacer.style.flex = '1'; fh.appendChild(spacer);
    fh.appendChild(el('span', 'counts', h.countsText));
    bar.appendChild(fh);
    const pb = el('div', 'progressbar');
    const done = el('div', 'pb-done'); done.style.width = (h.progress.mode === 'agent' ? h.progress.donePct : 0) + '%';
    const rep = el('div', 'pb-replied'); rep.style.width = (h.progress.mode === 'you' ? h.progress.repliedPct : 0) + '%';
    pb.append(rep, done); bar.appendChild(pb);
    stage.appendChild(bar);
    stage.appendChild(el('div', 'sb-doctitle', 'tab title: ' + h.docTitle));
    box.appendChild(stage); g.appendChild(box);
  }
}

// ---- build the page --------------------------------------------------------
sandbox();
statusChips();
cardVariants();
bubbles();
tags();
listGrouping();
headerStates();
