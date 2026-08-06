// thread-logic.js — the "situation → how it renders" decision layer.
//
// Every predicate that decides a thread's state (whose turn is it, is it unread,
// which status chip to show, how the header/progress reads) lives HERE as a pure
// function of (thread, context). Nothing in this file touches the DOM.
//
// It is the SAME code the live board (index.html) runs AND the storybook
// (stories.js) runs — so a situation you build in the storybook classifies
// exactly the way it would on the real board. `bind(ctx)` closes the
// ctx-dependent predicates over a context object so callers can keep writing
// `isUnread(t)` instead of threading ctx through every call.
//
// ctx shape: { agent, threads, drafts, readMarks }
//   agent     — board.agent ({ status, consumedAt, finishedAt, ... })
//   threads   — the full thread array (for grouping/counts)
//   drafts    — id -> { action, text, resolve, saved }  (staged, un-submitted replies)
//   readMarks — id -> updatedAt you acknowledged (client-side "mark read")

export const DEFAULT_ACTIONS = ['Fix', 'Approve'];

// ---- ctx-independent helpers (pure of any board state) ----
export const actionsFor = (t) => (Array.isArray(t.actions) ? t.actions : DEFAULT_ACTIONS);
export const tagsFor = (t) => (Array.isArray(t.tags) ? t.tags : []);
export const ts = (t) => t.updatedAt || t.createdAt || '';
export const byFreshest = (a, b) => (ts(a) < ts(b) ? 1 : ts(a) > ts(b) ? -1 : 0);
// agent-set priority wins (higher first); freshness breaks ties.
export const byPriority = (a, b) => ((b.priority || 0) - (a.priority || 0)) || byFreshest(a, b);
export const hasContent = (d) => !!(d && (d.action || (d.text && d.text.trim()) || d.resolve));
export const lastMsg = (t) => (t.messages && t.messages.length ? t.messages[t.messages.length - 1] : null);
export const lastAuthor = (t) => { const m = lastMsg(t); return m ? m.author : null; };

/**
 * Close every ctx-dependent predicate over `ctx` and return them as a bundle.
 * The returned names match the ones the live UI has always used, so call sites
 * stay `isUnread(t)` / `openThreads()` with no ctx argument.
 */
export function bind(ctx) {
  // ---- whose turn is it? ----
  // A reply you staged locally but have NOT submitted yet.
  const isStaged = (t) => { const d = ctx.drafts[t.id]; return !!(d && d.saved && hasContent(d)); };
  // The agent's last message is a "status" update -> it is still working.
  const agentWorkingLast = (t) => { const m = lastMsg(t); return !!(m && m.author === 'agent' && m.intent === 'status'); };
  // Agent set a per-thread progress marker (no message): seen / working keep the
  // thread on the agent's side; the last agent message asks for input.
  const agentActive = (t) => t.work === 'seen' || t.work === 'working';
  const needsInput = (t) => { const m = lastMsg(t); return !!(m && m.author === 'agent' && (m.intent === 'question' || m.intent === 'proposal' || m.intent === 'discussion')); };
  // Agent parked it: shown in the Deferred lane, ignored by the review flow until resumed.
  const isDeferred = (t) => t.deferred === true && t.status !== 'resolved';
  const userRepliedLast = (t) => lastAuthor(t) === 'user';
  const agentTs = (f) => (ctx.agent && ctx.agent[f]) || '';
  // Your reply hasn't been picked up by the agent yet (it hasn't consumed the batch).
  const notPickedUp = (t) => userRepliedLast(t) && agentTs('consumedAt') < lastMsg(t).ts;
  // The agent picked your reply up AND then finished a round without answering
  // it. The finish must come AFTER the pickup (finishedAt >= consumedAt) —
  // otherwise a reply sent while the agent was mid-round, then picked up on its
  // next wait, would be wrongly flagged (the finish predates that pickup).
  const ignoredByAgent = (t) => {
    if (t.status === 'resolved' || isDeferred(t) || !userRepliedLast(t)) return false;
    const r = lastMsg(t).ts;
    const consumed = agentTs('consumedAt');
    return consumed >= r && agentTs('finishedAt') >= consumed;
  };
  // Ball in the AGENT's court: you replied last (and it hasn't finished without
  // answering), OR the agent posted a status update (still working).
  const awaitingAgent = (t) => t.status !== 'resolved' && !ignoredByAgent(t) && (userRepliedLast(t) || agentWorkingLast(t) || agentActive(t));
  // You've handled it (staged OR already submitted) -> not on your plate.
  const isAnswered = (t) => t.status !== 'resolved' && (awaitingAgent(t) || isStaged(t));
  // Truly needs you: open, not deferred, agent spoke last (or fresh), no staged reply.
  const needsAttention = (t) => t.status !== 'resolved' && !isDeferred(t) && !isAnswered(t);
  // You manually marked it read (acknowledged, no reply needed — e.g. the
  // agent is still working on it). Stored per board in the browser; a later
  // agent update (updatedAt bumps past the mark) makes it unread again.
  const isRead = (t) => t.status !== 'resolved' && ctx.readMarks[t.id] && ctx.readMarks[t.id] >= (t.updatedAt || t.createdAt || '');
  // "Unread" = still needs YOUR response and you have NOT acknowledged it.
  const isUnread = (t) => needsAttention(t) && !isRead(t);

  // Open, non-deferred threads grouped so keyboard order == visual order:
  // things still needing YOU (unread) first, then everything handled/waiting.
  const openThreads = () => {
    const open = ctx.threads.filter((t) => t.status !== 'resolved' && !isDeferred(t));
    const attn = open.filter(isUnread).sort(byPriority);
    const waiting = open.filter((t) => !isUnread(t)).sort(byPriority);
    return attn.concat(waiting);
  };

  // The single status chip for a thread — the lifecycle the user reads at a
  // glance. Returns { text, cls } or null when nothing needs a chip (a plain
  // fresh finding just shows the unread dot). Precedence: closed states, then
  // the agent's per-thread markers, then reply state, then "needs your input".
  const statusChipDescriptor = (t) => {
    if (t.status === 'resolved') return { text: 'resolved', cls: 'resolved' };
    if (isDeferred(t)) return { text: '⏸ deferred', cls: 'deferred' };
    if (isStaged(t)) return { text: '✓ ' + ((ctx.drafts[t.id] && ctx.drafts[t.id].action) || 'pending'), cls: 'replied' };
    if (t.work === 'done') return { text: '✓ done', cls: 'agentdone' };
    if (ignoredByAgent(t)) return { text: '⚠ ignored by agent', cls: 'ignored' };
    if (t.work === 'working') return { text: '⚙ working', cls: 'working' };
    if (t.work === 'seen') return { text: '👀 seen', cls: 'seen' };
    if (awaitingAgent(t)) {
      if (agentWorkingLast(t)) return { text: '⚙ working', cls: 'working' };
      if (notPickedUp(t)) return { text: '✓ replied', cls: 'replied' };
      return { text: '⏳ waiting on agent', cls: 'waiting-agent' };
    }
    if (isRead(t)) return { text: '✓ read', cls: 'read-chip' }; // you acknowledged it, no reply
    if (needsInput(t)) return { text: '🙋 needs your input', cls: 'needs-input' };
    return null; // fresh finding on your plate: the unread dot is enough
  };

  // Header counts + progress bar + document title, as a pure model. The DOM
  // writing (widths, title) lives in the caller; the arithmetic — which is the
  // fiddly "whose turn / how far along" logic — lives here so the storybook can
  // exercise every permutation.
  const headerModel = () => {
    const open = openThreads();
    // Your reply progress spans ONLY threads on your plate: ones needing a
    // reply + ones you've staged. Threads already submitted (awaitingAgent)
    // are the agent's court and are NOT counted here — they show separately.
    const mine = open.filter((t) => needsAttention(t) || isStaged(t));
    const mineTotal = mine.length;
    const mineReplied = mine.filter((t) => isStaged(t) || isRead(t)).length; // staged OR acknowledged
    const withAgent = open.filter(awaitingAgent).length;
    const agentDone = open.filter((t) => t.work === 'done').length;
    const resolved = ctx.threads.filter((t) => t.status === 'resolved').length;
    const deferred = ctx.threads.filter(isDeferred).length;
    const status = (ctx.agent && ctx.agent.status) || 'idle';
    const working = status === 'working';

    const parts = [];
    const progress = { mode: working ? 'agent' : 'you', donePct: 0, repliedPct: 0 };
    if (working) {
      parts.push(`⚙ agent ${agentDone}/${open.length} done`);
      if (mineTotal) parts.push(`you ${mineReplied}/${mineTotal}`);
      progress.donePct = open.length ? (agentDone / open.length) * 100 : 0;
    } else {
      if (mineTotal) parts.push(`${mineReplied}/${mineTotal} to reply`);
      progress.repliedPct = mineTotal ? (mineReplied / mineTotal) * 100 : 0;
    }
    if (withAgent) parts.push(`${withAgent} with agent`);
    if (resolved) parts.push(`${resolved} resolved`);
    if (deferred) parts.push(`${deferred} deferred`);
    const countsText = parts.join(' · ') || 'no threads';
    const activityText = working ? '⚙ ' + ((ctx.agent && ctx.agent.activity) || 'Working…') : (status === 'waiting' ? '🔔 waiting for your feedback' : '');

    const allMine = mineTotal > 0 && mineReplied === mineTotal;
    let docTitle;
    if (working) docTitle = `⚙ ${agentDone}/${open.length} agent — Session Threads`;
    else if (status === 'waiting' && mineTotal && !allMine) docTitle = `🔔 your turn ${mineReplied}/${mineTotal} — Session Threads`;
    else if (allMine) docTitle = `✅ ${mineReplied}/${mineTotal} — Session Threads`;
    else docTitle = mineTotal ? `(${mineReplied}/${mineTotal}) Session Threads` : 'Session Threads';

    return { open: open.length, mineTotal, mineReplied, withAgent, agentDone, resolved, deferred, status, working, allMine, countsText, activityText, progress, docTitle };
  };

  return {
    isStaged, agentWorkingLast, agentActive, needsInput, isDeferred, userRepliedLast,
    agentTs, notPickedUp, ignoredByAgent, awaitingAgent, isAnswered, needsAttention,
    isRead, isUnread, openThreads, statusChipDescriptor, headerModel,
    // ctx-independent helpers, re-exported for convenience so callers can pull
    // everything from one bound bundle.
    actionsFor, tagsFor, ts, byFreshest, byPriority, hasContent, lastMsg, lastAuthor,
  };
}
