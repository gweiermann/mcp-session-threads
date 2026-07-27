// BoardStore — the data model and persistence for review boards.
// Pure logic + JSON-file persistence; no HTTP, no MCP. Emits 'change' (board)
// whenever a board mutates so an HTTP layer can push live updates.

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_ACTIONS = ['Fix', 'Approve'];
const shortId = () => randomUUID().slice(0, 8);
const now = () => new Date().toISOString();
const cleanTags = (tags) =>
  Array.isArray(tags) ? tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()) : [];

/** Normalize an arbitrary object into a valid thread (used for create + import). */
export function makeThread(raw = {}) {
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : shortId(),
    title: (raw.title && String(raw.title)) || '(untitled)',
    body: raw.body ? String(raw.body) : '',
    tags: cleanTags(raw.tags || (raw.kind ? [raw.kind] : [])),
    status: raw.status === 'resolved' ? 'resolved' : 'open',
    // agent-controlled "parked" flag: parks the thread in a Deferred lane until resumed
    deferred: raw.deferred === true,
    // one-sentence reminder of WHEN to pick a deferred thread back up; surfaced
    // to the agent on every wait_for_feedback so parked work is never forgotten
    pickupHint: raw.pickupHint ? String(raw.pickupHint) : '',
    // agent-controlled priority; higher sorts first in the review list (0 = default)
    priority: Number.isFinite(raw.priority) ? raw.priority : 0,
    work: raw.work === 'working' || raw.work === 'done' ? raw.work : null,
    createdBy: raw.createdBy === 'user' ? 'user' : 'agent',
    actions: Array.isArray(raw.actions) ? raw.actions.map(String) : [...DEFAULT_ACTIONS],
    messages: Array.isArray(raw.messages)
      ? raw.messages
          .filter((m) => m && typeof m.text === 'string')
          .map((m) => ({ author: m.author === 'user' ? 'user' : 'agent', text: m.text, ts: m.ts || now(), ...(m.intent ? { intent: String(m.intent) } : {}) }))
      : [],
    createdAt: raw.createdAt || now(),
    updatedAt: raw.updatedAt || now(),
  };
}

function normalizeBoard(raw = {}) {
  return {
    id: raw.id || shortId(),
    key: raw.key || '',
    label: raw.label || '',
    summary: raw.summary || '',
    version: raw.version || 0,
    threads: Array.isArray(raw.threads) ? raw.threads.map(makeThread) : [],
    // durable free-form note submissions; each entry is its own {id,text,ts,consumed}
    notes: Array.isArray(raw.notes) ? raw.notes.map((n) => ({ id: n.id || shortId(), text: String(n.text || ''), ts: n.ts || now(), consumed: !!n.consumed })) : [],
    agent: raw.agent && typeof raw.agent === 'object'
      ? { status: raw.agent.status || 'idle', activity: raw.agent.activity || '', currentThreadId: raw.agent.currentThreadId || null, updatedAt: raw.agent.updatedAt || null }
      : { status: 'idle', activity: '', currentThreadId: null, updatedAt: null },
    createdAt: raw.createdAt || now(),
    updatedAt: raw.updatedAt || now(),
  };
}

/** Public view of a board (what the web UI / API consumers receive). */
export function publicView(b) {
  return { id: b.id, key: b.key, label: b.label, summary: b.summary, version: b.version, threads: b.threads, agent: b.agent };
}

export class BoardStore extends EventEmitter {
  /** @param {string} dataDir directory for one JSON file per board */
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    /** @type {Map<string, object>} */
    this.boards = new Map();
    mkdirSync(dataDir, { recursive: true });
    this.#loadAll();
  }

  #loadAll() {
    for (const f of readdirSync(this.dataDir)) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      try {
        const b = normalizeBoard(JSON.parse(readFileSync(join(this.dataDir, f), 'utf8')));
        this.boards.set(b.id, b);
      } catch {
        /* skip corrupt files */
      }
    }
  }

  #persist(b) {
    const dst = join(this.dataDir, `${b.id}.json`);
    const tmp = `${dst}.tmp`;
    writeFileSync(tmp, JSON.stringify(b, null, 2));
    renameSync(tmp, dst); // atomic-ish
  }

  #touch(b) {
    b.version += 1;
    b.updatedAt = now();
    this.#persist(b);
    this.emit('change', b);
    return b;
  }

  #require(id) {
    const b = this.boards.get(id);
    if (!b) throw new BoardNotFound(id);
    return b;
  }

  #thread(b, threadId) {
    const t = b.threads.find((x) => x.id === threadId);
    if (!t) throw new ThreadNotFound(threadId);
    return t;
  }

  // ---- board lifecycle ----
  create({ key = '', label = '' } = {}) {
    const b = normalizeBoard({ id: shortId(), key, label });
    this.boards.set(b.id, b);
    this.#persist(b);
    this.emit('change', b);
    return b;
  }

  /** Return the board for `key`, creating it if absent (stable identity). */
  getOrCreate({ key, label = '' }) {
    if (key) {
      const existing = [...this.boards.values()].find((b) => b.key === key);
      if (existing) {
        if (label && !existing.label) {
          existing.label = label;
          this.#persist(existing);
        }
        return existing;
      }
    }
    return this.create({ key, label });
  }

  get(id) {
    return this.boards.get(id) || null;
  }

  list() {
    return [...this.boards.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  remove(id) {
    if (!this.boards.has(id)) return false;
    this.boards.delete(id);
    try {
      rmSync(join(this.dataDir, `${id}.json`), { force: true });
    } catch {
      /* ignore */
    }
    return true;
  }

  // ---- thread mutations ----
  addThread(id, { title, body, tags, actions, priority, insert_after } = {}) {
    const b = this.#require(id);
    const t = makeThread({ title, body, tags, actions: Array.isArray(actions) ? actions : undefined, priority });
    if (insert_after) {
      const anchor = b.threads.find((x) => x.id === insert_after);
      if (anchor) {
        // Position the new thread immediately AFTER the anchor: put it in the
        // anchor's priority tier and give it a sort timestamp 1ms older, so with
        // the (priority desc, freshness desc) sort it lands right below the anchor.
        t.priority = anchor.priority;
        const after = new Date(new Date(anchor.updatedAt || anchor.createdAt).getTime() - 1).toISOString();
        t.createdAt = after;
        t.updatedAt = after;
      }
    }
    b.threads.push(t);
    this.#touch(b);
    return t;
  }

  /**
   * Reorder the review list by priority. `threadIds` is MOST-IMPORTANT FIRST;
   * the first gets the highest priority so it sorts to the top. Threads not
   * listed keep their current priority (default 0, i.e. below the prioritized).
   * Does not touch updatedAt, so it never reorders by freshness or marks unread.
   */
  reorderByPriority(id, threadIds = []) {
    const b = this.#require(id);
    const ids = Array.isArray(threadIds) ? threadIds : [];
    let set = 0;
    ids.forEach((tid, i) => {
      const t = b.threads.find((x) => x.id === tid);
      if (t) { t.priority = ids.length - i; set += 1; }
    });
    this.#touch(b);
    return { set, total: ids.length };
  }

  addMessage(id, threadId, { text, author = 'agent', actions, tags, intent } = {}) {
    const b = this.#require(id);
    const t = this.#thread(b, threadId);
    const msg = { author: author === 'user' ? 'user' : 'agent', text: String(text || ''), ts: now() };
    if (intent) msg.intent = String(intent); // UI/turn hint: "status" keeps the thread as waiting-on-agent
    t.messages.push(msg);
    if (Array.isArray(actions)) t.actions = actions.map(String);
    if (Array.isArray(tags)) t.tags = cleanTags(tags);
    if (t.status === 'resolved') t.status = 'open'; // adding a message reopens
    t.updatedAt = now();
    this.#touch(b);
    return t;
  }

  setStatus(id, threadId, status) {
    const b = this.#require(id);
    const t = this.#thread(b, threadId);
    t.status = status === 'resolved' ? 'resolved' : 'open';
    t.updatedAt = now();
    this.#touch(b);
    return t;
  }

  /**
   * Park (deferred:true) or resume (deferred:false) a thread. When resuming,
   * `text` is appended as an agent message (the "why pick it up now" note);
   * appending it also makes the thread the freshest → back atop the review.
   */
  deferThread(id, threadId, { deferred, text, hint } = {}) {
    const b = this.#require(id);
    const t = this.#thread(b, threadId);
    if (text) t.messages.push({ author: 'agent', text: String(text), ts: now() });
    t.deferred = !!deferred;
    t.pickupHint = deferred ? String(hint || '') : ''; // only parked threads carry a pickup hint
    if (!deferred && t.status === 'resolved') t.status = 'open';
    t.updatedAt = now();
    this.#touch(b);
    return t;
  }

  /**
   * Rename a thread. Deliberately does NOT touch updatedAt: a retitle is an
   * edit, not activity, so it never reorders the list or marks the thread unread.
   */
  setTitle(id, threadId, title) {
    const b = this.#require(id);
    const t = this.#thread(b, threadId);
    const next = String(title || '').trim();
    if (next) t.title = next;
    this.#touch(b);
    return t;
  }

  setSummary(id, text) {
    const b = this.#require(id);
    b.summary = text ? String(text) : '';
    this.#touch(b);
    return b;
  }

  setAgent(id, { status, activity, currentThreadId, thread_id: threadId, work } = {}) {
    const b = this.#require(id);
    if (typeof status === 'string') b.agent.status = status;
    if (typeof activity === 'string') b.agent.activity = activity;
    if (currentThreadId !== undefined) b.agent.currentThreadId = currentThreadId;
    b.agent.updatedAt = now();
    if (threadId && (work === 'working' || work === 'done' || work === null)) {
      const t = b.threads.find((x) => x.id === threadId);
      if (t) t.work = work;
    }
    this.#touch(b);
    return b;
  }

  // ---- user feedback (from the web UI) ----
  /**
   * Apply a submit: record user reply messages on threads and store any
   * free-form note durably. Returns {replies:[...], noteAdded:boolean}.
   */
  applySubmit(id, { replies = [], notes = '' } = {}) {
    const b = this.#require(id);
    const ts = now();
    const out = [];
    for (const r of Array.isArray(replies) ? replies : []) {
      const t = b.threads.find((x) => x.id === r.thread_id);
      if (!t) continue;
      const parts = [];
      if (r.action) parts.push(String(r.action));
      const text = (r.text || '').trim();
      if (text) parts.push(text);
      if (!parts.length && !r.resolve) continue;
      if (parts.length) t.messages.push({ author: 'user', text: parts.join(' — '), ts });
      if (r.resolve) t.status = 'resolved';
      else if (parts.length) t.status = 'open'; // any non-resolve reply reopens
      t.work = null; // the user responded -> any prior agent "done" marker is stale; the agent owes a fresh look
      // The user engaged with a parked thread -> un-park it so it is picked up
      // again (and so a resolve on a deferred thread really resolves it).
      if (t.deferred) { t.deferred = false; t.pickupHint = ''; }
      t.updatedAt = ts;
      out.push({ thread_id: t.id, title: t.title, tags: t.tags, action: r.action || null, text, resolved: !!r.resolve });
    }
    const trimmed = (notes || '').trim();
    if (trimmed) b.notes.push({ id: shortId(), text: trimmed, ts, consumed: false });
    if (out.length || trimmed) this.#touch(b);
    return { replies: out, noteAdded: !!trimmed };
  }

  /** Return note entries not yet delivered to the agent; mark them delivered. */
  drainNotes(id) {
    const b = this.#require(id);
    const fresh = b.notes.filter((n) => !n.consumed);
    if (fresh.length) {
      fresh.forEach((n) => (n.consumed = true));
      this.#persist(b);
    }
    return fresh.map((n) => ({ text: n.text, ts: n.ts }));
  }

  allNotes(id) {
    const b = this.#require(id);
    return b.notes.map((n) => ({ text: n.text, ts: n.ts, consumed: n.consumed }));
  }

  // ---- import / export ----
  importThreads(id, { threads = [], summary, mode = 'append' } = {}) {
    const b = this.#require(id);
    if (mode === 'replace') b.threads = [];
    const ids = new Set(b.threads.map((t) => t.id));
    let added = 0;
    for (const raw of Array.isArray(threads) ? threads : []) {
      const t = makeThread(raw);
      if (ids.has(t.id)) t.id = shortId();
      ids.add(t.id);
      b.threads.push(t);
      added += 1;
    }
    if (typeof summary === 'string' && summary) b.summary = summary;
    this.#touch(b);
    return { added, total: b.threads.length };
  }

  exportBoard(id) {
    const b = this.#require(id);
    return { id: b.id, key: b.key, label: b.label, summary: b.summary, threads: b.threads };
  }
}

export class BoardNotFound extends Error {
  constructor(id) {
    super(`no such board: ${id}`);
    this.code = 'BOARD_NOT_FOUND';
  }
}
export class ThreadNotFound extends Error {
  constructor(id) {
    super(`no such thread: ${id}`);
    this.code = 'THREAD_NOT_FOUND';
  }
}
