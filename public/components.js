// components.js — presentational DOM builders shared by the live board
// (index.html) and the storybook (stories.js).
//
// These functions build elements from data + a bound thread-logic bundle `L`
// (see thread-logic.js). They deliberately hold NO app state: interaction is
// injected via small callbacks (onOpen, onEdit), so the storybook can render the
// exact same component inertly while the live board wires real navigation.

import { mdToHtml } from '/markdown.js';
import { tagsFor } from '/thread-logic.js';

// A single status chip: <span class="chip <cls>">text</span>.
export function chip(text, cls) {
  const c = document.createElement('span');
  c.className = 'chip ' + cls;
  c.textContent = text;
  return c;
}

// Render a thread-logic chip descriptor ({text, cls} | null) into an element.
export function statusChipEl(t, L) {
  const d = L.statusChipDescriptor(t);
  return d ? chip(d.text, d.cls) : null;
}

// tag string -> a colour class, by keyword. Purely presentational.
export function tagClass(tag) {
  const s = tag.toLowerCase();
  if (/(crit|block|high|urgent|error|\bbug\b|fail|danger|sec)/.test(s)) return 'tag-red';
  if (/(med|warn|moderate|todo)/.test(s)) return 'tag-amber';
  if (/(low|minor|nit|info|note|trivial)/.test(s)) return 'tag-muted';
  if (/(question|ask|decide|discuss|clarif)/.test(s)) return 'tag-blue';
  if (/(good|approve|pass|done|resolved|ok|lgtm|nice)/.test(s)) return 'tag-green';
  return 'tag-default';
}

export function renderTags(host, t) {
  for (const tag of tagsFor(t)) {
    const b = document.createElement('span');
    b.className = 'badge ' + tagClass(tag);
    b.textContent = tag;
    host.appendChild(b);
  }
}

// intent -> subtle rendering hint (a caption on the bubble, not a tag badge)
export const INTENT_META = {
  status: { label: '⏳ working', cls: 'msg-status' },
  proposal: { label: 'proposal', cls: 'msg-proposal' },
  question: { label: 'question', cls: 'msg-proposal' },
  discussion: { label: 'needs discussion', cls: 'msg-proposal' },
  done: { label: '✓ done', cls: 'msg-done' },
};

// A chat message bubble (agent/user), with the intent caption + colour.
export function bubbleEl(m) {
  const b = document.createElement('div');
  b.className = 'bubble ' + (m.author === 'user' ? 'user' : 'agent');
  const meta = m.author === 'agent' && m.intent ? INTENT_META[m.intent] : null;
  if (meta) b.classList.add(meta.cls);
  else if (m.author === 'agent' && m.intent) b.classList.add('msg-proposal'); // unknown intent -> generic caption style
  const who = document.createElement('span'); who.className = 'who';
  who.textContent = m.author === 'user' ? 'you' : (m.intent ? 'agent · ' + (meta ? meta.label : m.intent) : 'agent');
  const tx = document.createElement('div'); tx.className = 'txt md'; tx.innerHTML = mdToHtml(m.text);
  b.append(who, tx);
  return b;
}

// The thread body / a plain bubble from already-rendered HTML.
export function chatBubble(author, html) {
  const b = document.createElement('div'); b.className = 'bubble ' + author;
  const who = document.createElement('span'); who.className = 'who'; who.textContent = author === 'user' ? 'you' : 'agent';
  const tx = document.createElement('div'); tx.className = 'txt md'; tx.innerHTML = html;
  b.append(who, tx);
  return b;
}

// A staged (pending, un-submitted) reply, rendered from a draft.
export function replyText(d) {
  const parts = [];
  if (d.action) parts.push('**' + d.action + '**');
  const t = (d.text || '').trim(); if (t) parts.push(t);
  let s = parts.join(' — ');
  if (d.resolve) s += (s ? '\n\n' : '') + '_marks thread resolved_';
  return s || '_(empty)_';
}

export function pendingBubble(t, d, { onEdit } = {}) {
  const b = document.createElement('div'); b.className = 'pending-bubble'; b.title = 'Click to edit';
  const cap = document.createElement('div'); cap.className = 'pending-cap'; cap.textContent = '◷ you · pending';
  const tx = document.createElement('div'); tx.className = 'txt md'; tx.innerHTML = mdToHtml(replyText(d));
  b.append(cap, tx);
  if (onEdit) b.onclick = onEdit;
  return b;
}

// A list-view thread card (the row you click into). Computes its own classes +
// status chip from the bound logic `L`; `onOpen(id)` handles in-page navigation
// (a plain left click), while cmd/ctrl/shift/middle-click fall through to the
// real <a href> so the browser opens the thread in a new tab.
export function threadCard(t, L, { onOpen } = {}) {
  const resolved = t.status === 'resolved';
  const answered = L.isAnswered(t) || L.isRead(t); // dim handled cards, incl. read/acknowledged
  const unread = L.isUnread(t);
  const deferred = L.isDeferred(t);
  const card = document.createElement('div');
  card.className = 'card' + (resolved ? ' resolved' : '') + (deferred ? ' deferred' : '') + (answered ? ' replied' : '') + (unread ? ' unread' : '');
  // A real <a href> so middle-click / cmd-click opens the thread in a new tab.
  const head = document.createElement('a'); head.className = 'row-head'; head.href = '#/t/' + t.id;

  const main = document.createElement('div'); main.className = 'row-main';
  const dotSlot = document.createElement('span'); dotSlot.className = 'dot-slot';
  if (unread) { const dot = document.createElement('span'); dot.className = 'new-dot'; dot.title = 'Unread — needs your response'; dotSlot.appendChild(dot); }
  const title = document.createElement('span'); title.className = 'rtitle'; title.textContent = t.title;
  main.append(dotSlot, title); head.appendChild(main);

  const sc = statusChipEl(t, L); if (sc) head.appendChild(sc);

  const chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '›'; head.appendChild(chev);
  head.onclick = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    if (onOpen) onOpen(t.id);
  };
  card.appendChild(head);
  return card;
}
