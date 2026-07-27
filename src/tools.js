// MCP tool definitions. Thin wiring over the resilient client; all product
// wording lives here and is intentionally generic.
import { z } from 'zod';

export const INSTRUCTIONS = [
  'A shared review board with a human-facing web UI. Each project gets its OWN persistent board (never reuse another). USE IT for review- or discussion-heavy turns — code reviews, design decisions, planning — anytime you would otherwise cram 2+ findings/questions/decisions into one terminal message.',
  'ALWAYS give the user the board URL up front (get_board_url, also returned by create_thread). It is STABLE for this project and does not change across restarts.',
  'PROACTIVELY open the board in the user\'s browser/preview pane so they can watch it live — do this once, right after you create the first thread. In Claude Code: call preview_start with the daemon ORIGIN (e.g. http://127.0.0.1:<port>), then navigate to the full board URL from get_board_url (opening the localhost path directly is blocked, so the origin-then-navigate order matters).',
  'THE BOARD IS THE ONLY THING THE USER SEES for this exchange — not your terminal. Make each thread self-contained, and when you reply in a thread START with a one-line summary of what the user asked so they know what you are responding to.',
  'Keep set_summary VERY SHORT — a couple of lines of big-picture orientation, NOT a recap. Do not restate what threads already say. Assume the summary may go UNREAD: anything the user must act on belongs in a THREAD, never only in the summary. Good uses: the one-line overall status/goal, something not captured in any thread, or shifting attention (e.g. "you probably haven\'t seen my reply in thread abc123 — please look").',
  'Typical flow: create_thread per finding/question (freestyle `tags` like ["finding","high"] and a few tailored `actions` like ["Fix","Approve"]), set_summary, then call wait_for_feedback ONCE — it blocks a long time and returns the moment the user submits; only call again if it returns a "no feedback yet" notice.',
  'wait_for_feedback also returns a checklist of every thread awaiting YOUR response (the user replied, ball in your court). Address EACH one before waiting again: reply with add_message, or if no reply is warranted mark_thread_done / resolve_thread / defer_thread. A thread stays on that checklist until you do one of those — do not leave any unaddressed unless it is deferred or done.',
  'When you acknowledge a request but are NOT done yet (e.g. "on it — here is the plan"), post that with add_message intent:"status" so the board keeps the thread as "waiting on agent" and does not falsely prompt the user to reply. Post a normal message (or intent:"done") once the work is actually finished.',
  'The board tracks WHOSE TURN it is so the UI can show the right progress bar and ping the user. Share progress as you act: start_working when you begin, work_on_thread(id) before a specific thread (it is highlighted), mark_thread_done(id) when finished, finish_working at the end. wait_for_feedback automatically flips the board to "your turn" (plays the user a sound) while it blocks, then back when they submit — you do not manage that state yourself.',
  'Do NOT auto-resolve threads for heavy/uncertain changes — leave them open for the user to confirm; only resolve small, clear-cut items.',
  'Order the review for the user: pass the most important threads first to prioritize_threads (or set `priority` on create_thread) so the highest-impact items sit at the top of "Needs your attention" and get answered first.',
  'For real work that is not a good time to tackle yet (blocked, out of scope for this pass), defer_thread parks it in a Deferred lane the user can ignore — you MUST give a one-sentence `pickup_hint` saying when to resume. Every wait_for_feedback echoes your parked threads with their hints, so they stay your open work; when a hint\'s condition is met, resume_thread un-parks it AND posts a why-now message. If the user replies on a deferred thread it un-parks itself and returns to your checklist — always pick it up then.',
  'Cross-reference threads with a `thread:<id>` markdown link — e.g. "duplicate of [R6](thread:abc123)" — which renders as a clickable chip that jumps straight to that thread. Never make the user hunt for a thread you mention by name. Link files the same way with a repo-relative path (`[config.ts:42](src/config.ts:42)`); those open in the editor.',
  'Thread titles are the user\'s handle on a thread: keep them SHORT (~60 chars; the UI truncates) and STABLE. Do not reword a title each round — that destroys recognition. Only retitle_thread when the topic genuinely moved on (e.g. an open question became a concrete proposal/implementation), and keep the recognizable core wording of the original so it still reads as the same thread.',
  'One project = one board by default (same repo/branch shares it). If the user wants to review a SEPARATE area of the same repo on its own board, use_board({name:"…"}) opens a named board for it (persists across restarts; "main" returns to the default). If threads end up on the wrong board you can also self-serve: list_boards, use_board({board_id}), import_threads, export_board, backup_board. Tool calls throw loudly on failure — never assume a write landed if the call errored.',
].join(' ');

const ok = (text) => ({ content: [{ type: 'text', text }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatFeedback(p, outstanding = [], deferred = []) {
  if (p.status === 'timeout') {
    return 'No feedback submitted within the wait window. If you still expect input, call wait_for_feedback again (it blocks a long time per call; the user can stop you anytime to talk in chat).';
  }
  const notes = Array.isArray(p.notes) ? p.notes : [];
  const lines = [`Feedback received: ${p.replies.length} repl${p.replies.length === 1 ? 'y' : 'ies'}${notes.length ? `, plus ${notes.length} free-form note submission(s)` : ''}.`];
  for (const r of p.replies) {
    lines.push('', `• Thread ${r.thread_id} — "${r.title}"${r.resolved ? '  [user marked RESOLVED]' : ''}`);
    if (r.action) lines.push(`    action: ${r.action}`);
    if (r.text) lines.push(`    note: ${r.text}`);
  }
  if (notes.length) {
    lines.push('', `Free-form notes (${notes.length} separate submission(s) — split each into threads with create_thread as needed):`);
    notes.forEach((n, i) => lines.push('', `— note ${i + 1}:`, '"""', typeof n === 'string' ? n : n.text, '"""'));
  }
  if (outstanding.length) {
    lines.push('', `⚠ ${outstanding.length} thread(s) are awaiting YOUR response (the ball is in your court — this includes the replies above plus any carried over from before). Address EVERY one this cycle: reply with add_message, or if no reply is warranted, mark_thread_done / resolve_thread / defer_thread. A thread only drops off this list once you reply, mark it done, resolve it, or defer it:`);
    for (const t of outstanding) lines.push(`  • ${t.id} — "${t.title}"`);
  }
  if (deferred.length) {
    lines.push('', `⏸ ${deferred.length} deferred thread(s) parked by you — not on the user's plate, but still YOUR open work. Check each pickup condition; when one is met, resume_thread it (with a why-now message). They are also un-parked automatically the moment the user replies to them:`);
    for (const t of deferred) lines.push(`  • ${t.id} — "${t.title}" → pick up when: ${t.pickupHint || '(no hint recorded)'}`);
  }
  lines.push('', 'When you reply in a thread, start with a one-line summary of what the user asked. Address all threads listed above, then call wait_for_feedback again if you still expect input.');
  return lines.join('\n');
}

/**
 * Split the board into what the agent still owes:
 *  - outstanding: ball in the agent's court (user replied last, or its own last
 *    message was a "status" = still working), excluding parked/finished threads.
 *  - deferred: threads it parked, with their pickup conditions (still its work).
 */
async function gatherAgentWork(client) {
  try {
    const { threads } = await client.call('/threads');
    const open = threads.filter((t) => t.status === 'open');
    return {
      outstanding: open.filter((t) => !t.deferred && t.work !== 'done' && (t.lastAuthor === 'user' || t.lastIntent === 'status')),
      deferred: open.filter((t) => t.deferred),
    };
  } catch {
    return { outstanding: [], deferred: [] };
  }
}

/** @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} mcp */
export function registerTools(mcp, client) {
  const S = z.string();
  const A = z.array(z.string()).optional();

  mcp.tool(
    'create_thread',
    'Open a thread on this project\'s board (one per finding/question/note). `body` supports Markdown (incl. tables). `tags` are freestyle marker badges. `actions` are tailored quick-reply buttons (default ["Fix","Approve"]). `priority` (higher = more important, default 0) sorts it toward the top of the review list. `insert_after` (a thread id) places this new thread immediately after that thread in the list — use it for flow, e.g. when you split one thread into several so the pieces appear right below the original (chain: insert each after the previous one).',
    { title: S, body: S.optional(), tags: A, actions: A, priority: z.number().optional(), insert_after: S.optional() },
    async (a) => {
      const j = await client.call('/thread', { method: 'POST', body: a });
      const first = (await client.call('/threads')).threads.length === 1;
      return ok(`Created thread ${j.id}${j.tags.length ? ` [${j.tags.join(', ')}]` : ''} "${a.title}".` + (first ? `\n\nBoard is live at ${client.getBoardUrl()} — share this link with the user.` : ''));
    }
  );

  mcp.tool(
    'add_message',
    'Append an agent message to a thread (Markdown). Start with a one-line summary of what the user asked. Adding a message to a resolved thread reopens it. Optionally set `intent` to hint the UI: "status" = a progress update / plan while you KEEP WORKING — the thread stays "waiting on agent" and does NOT prompt the user to reply (use it for "on it, here is the plan…"); "proposal"/"question"/"discussion" = you want the user\'s input; "done" = you finished. Only "status" changes turn behavior; the others are rendering hints. Optionally refresh `actions`/`tags`.',
    { thread_id: S, text: S, intent: z.enum(['status', 'proposal', 'question', 'discussion', 'done']).optional(), actions: A, tags: A },
    async (a) => {
      await client.call('/message', { method: 'POST', body: a });
      return ok(`Added message to ${a.thread_id}${a.intent ? ` [${a.intent}]` : ''}.`);
    }
  );

  mcp.tool('resolve_thread', 'Mark a thread resolved (only small/clear-cut items — leave heavy/uncertain changes open for the user).', { thread_id: S }, async ({ thread_id }) => {
    await client.call('/resolve', { method: 'POST', body: { thread_id } });
    return ok(`Resolved ${thread_id}.`);
  });

  mcp.tool('reopen_thread', 'Reopen a resolved thread to continue it.', { thread_id: S }, async ({ thread_id }) => {
    await client.call('/reopen', { method: 'POST', body: { thread_id } });
    return ok(`Reopened ${thread_id}.`);
  });

  mcp.tool(
    'defer_thread',
    'Park a thread as "deferred": it drops into a Deferred lane below Waiting-on-agent and is excluded from the review counts and the "needs your attention" set, so the user can ignore it for now. Use for real work that is not a good time to tackle yet (blocked, out of scope for this pass, better done after X). `pickup_hint` is REQUIRED: one sentence stating WHEN to pick it back up (e.g. "resume once the stack is rebased") — it is echoed to you on every wait_for_feedback so parked work is never forgotten. Optionally pass `reason` (posted as a note on the thread). NOTE: if the user replies on a deferred thread it is un-parked automatically and lands back on your checklist.',
    { thread_id: S, pickup_hint: S, reason: S.optional() },
    async ({ thread_id, pickup_hint, reason }) => {
      await client.call('/defer', { method: 'POST', body: { thread_id, deferred: true, hint: pickup_hint, text: reason ? `⏸ Deferred: ${reason}` : '' } });
      return ok(`Deferred ${thread_id} — pick up when: ${pickup_hint}`);
    }
  );

  mcp.tool(
    'retitle_thread',
    'Rename a thread when its TOPIC has genuinely moved on (e.g. it began as a question and is now a concrete proposal/implementation) so the title reflects the current subject, not the original question. Do NOT retitle every round — the user tracks threads by title, so churn is costly. Keep the recognizable core wording of the original title and stay SHORT (~60 chars max; long titles are truncated in the UI). Never renames just to reword.',
    { thread_id: S, title: S },
    async ({ thread_id, title }) => {
      await client.call('/title', { method: 'POST', body: { thread_id, title } });
      return ok(`Retitled ${thread_id} -> "${title}".`);
    }
  );

  mcp.tool(
    'resume_thread',
    'Un-defer a parked thread AND post a message recommending the user pick it up now — `message` must explain WHY now is a good time (e.g. the blocker is cleared, the prerequisite landed). This brings the thread back to the top of "Needs your attention" as unread.',
    { thread_id: S, message: S },
    async ({ thread_id, message }) => {
      await client.call('/defer', { method: 'POST', body: { thread_id, deferred: false, text: message } });
      return ok(`Resumed ${thread_id} — user notified why now.`);
    }
  );

  mcp.tool('list_threads', 'List threads on this board (id, title, tags, status, work-state, message count).', { include_resolved: z.boolean().optional() }, async ({ include_resolved }) => {
    const j = await client.call('/threads');
    const threads = j.threads.filter((t) => (include_resolved ? true : t.status !== 'resolved'));
    return ok(JSON.stringify({ url: client.getBoardUrl(), count: threads.length, threads }, null, 2));
  });

  mcp.tool('set_summary', 'Pin a VERY SHORT big-picture note at the top of the board (Markdown; empty string clears). A couple of lines max — NOT a recap and NOT a restatement of thread contents. Assume it may go unread: never put anything the user must act on only here (that goes in a thread). Best uses: the one-line overall status/goal, something not captured in any thread, or redirecting attention (e.g. "you probably haven\'t seen my reply in thread abc123 — please look").', { text: S }, async ({ text }) => {
    await client.call('/summary', { method: 'POST', body: { text } });
    return ok(text ? 'Summary updated.' : 'Summary cleared.');
  });

  mcp.tool(
    'prioritize_threads',
    'Reorder the review list so the user answers the most important threads first. Pass `thread_ids` MOST-IMPORTANT FIRST — they float to the top of "Needs your attention" in that exact order; unlisted threads stay below (newest-first). Pass the full desired order in one call; call again to change it.',
    { thread_ids: z.array(z.string()) },
    async ({ thread_ids }) => {
      const j = await client.call('/prioritize', { method: 'POST', body: { thread_ids } });
      return ok(`Prioritized ${j.set}/${j.total} thread(s) — first listed is now top of the list.`);
    }
  );

  mcp.tool('get_board_url', "Return this project's stable board URL. Share it with the user.", {}, async () => ok(client.getBoardUrl() || '(board not ready)'));

  mcp.tool(
    'wait_for_feedback',
    'Block until the user submits their batched replies/notes on the board, then return them. ONE long call (default ~55 min) — do not poll in a loop; it returns instantly on submit and sends progress so it will not time out. Automatically flips the board to "your turn" (title + sound) while blocking and back to idle on return. Survives a daemon restart mid-wait (reconnects and keeps waiting); only if reconnection keeps failing does it return with a hint to call it once more. Create the threads BEFORE calling this.',
    { timeout_seconds: z.number().int().min(5).max(3600).optional() },
    async ({ timeout_seconds }, extra) => {
      const deadline = Date.now() + (timeout_seconds ?? 3300) * 1000;
      let n = 0;
      const beat = (message) => {
        try {
          extra?.sendNotification?.({ method: 'notifications/progress', params: { progressToken: extra?._meta?.progressToken ?? 'wait', progress: ++n, message: message || 'waiting for your feedback on the board…' } });
        } catch {
          /* ignore */
        }
      };
      const hb = setInterval(() => beat(), 60000);
      // Tell the board it is now the user's turn: the UI switches to the reply
      // progress bar and pings them (sound/toast). Cleared on return below.
      const markWaiting = () => client.call('/agent', { method: 'POST', body: { status: 'waiting', activity: 'Waiting for your feedback', currentThreadId: null } }).catch(() => {});
      await markWaiting();
      let fails = 0; // consecutive reconnect failures
      let received = false; // got a real batch (vs timed out) -> stay "working" on return
      try {
        while (Date.now() < deadline) {
          const secs = Math.min(25, Math.max(5, Math.ceil((deadline - Date.now()) / 1000)));
          let p;
          try {
            p = await client.call(`/wait?timeout=${secs}`);
            fails = 0;
          } catch (e) {
            // The daemon most likely bounced (e.g. a code change restarted it).
            // Reconnect and keep waiting instead of dying, so an in-flight wait
            // survives the restart. The board (threads + any submitted feedback)
            // persists to disk, so nothing is lost across the bounce.
            fails += 1;
            if (fails >= 6) {
              return ok(`The board connection kept dropping and could not be re-established (last error: ${e.message}). Your threads and any feedback you submitted are safe on the board — call wait_for_feedback once more to resume waiting.`);
            }
            beat('board connection dropped — reconnecting…');
            await client.ensureDaemon().catch(() => {});
            await client.resolveBoard().catch(() => {});
            await markWaiting();
            await sleep(Math.min(1000 * fails, 3000));
            continue;
          }
          if (p.status !== 'timeout') {
            received = true;
            const w = await gatherAgentWork(client);
            // The agent has now PICKED UP the batch and is working on it: stamp
            // consumedAt (drives the "agent started working" sound + flips the
            // user's replies from "replied" to "waiting on agent").
            await client.call('/agent', { method: 'POST', body: { status: 'working', activity: 'Working on your feedback', currentThreadId: null, consumed: true } }).catch(() => {});
            return ok(formatFeedback(p, w.outstanding, w.deferred));
          }
        }
        return ok(formatFeedback({ status: 'timeout' }));
      } finally {
        clearInterval(hb);
        // only clear the "your turn" state on a timeout/abort — on a real pickup
        // we intentionally left the board in "working" above.
        if (!received) await client.call('/agent', { method: 'POST', body: { status: 'idle', activity: '' } }).catch(() => {});
      }
    }
  );

  mcp.tool('get_notes', 'Return ALL free-form "other notes" the user submitted on this board (durable; each submission a separate entry).', {}, async () => {
    const j = await client.call('/notes');
    return ok(JSON.stringify(j.notes, null, 2));
  });

  // ---- progress sharing ----
  mcp.tool('start_working', 'Tell the UI you started acting on the feedback (shows a working indicator).', { activity: S.optional() }, async ({ activity }) => {
    await client.call('/agent', { method: 'POST', body: { status: 'working', activity: activity || 'Working…' } });
    return ok('Marked as working.');
  });
  mcp.tool('finish_working', 'Tell the UI the whole batch is done (title highlights, optional sound).', { activity: S.optional() }, async ({ activity }) => {
    await client.call('/agent', { method: 'POST', body: { status: 'done', activity: activity || 'Done', currentThreadId: null } });
    return ok('Marked as done.');
  });
  mcp.tool('work_on_thread', 'Tell the UI you are now working on a specific thread (highlighted as in-progress).', { thread_id: S }, async ({ thread_id }) => {
    await client.call('/agent', { method: 'POST', body: { status: 'working', currentThreadId: thread_id, thread_id, work: 'working' } });
    return ok(`Working on ${thread_id}.`);
  });
  mcp.tool('mark_thread_done', 'Mark that you finished working on a specific thread (counts toward the progress bar).', { thread_id: S }, async ({ thread_id }) => {
    await client.call('/agent', { method: 'POST', body: { thread_id, work: 'done' } });
    return ok(`Thread ${thread_id} done.`);
  });

  // ---- board management ----
  mcp.tool('list_boards', 'List all boards on the daemon (id, label, key, thread counts, URL).', {}, async () => {
    const j = await client.root('/api/boards');
    return ok(JSON.stringify(j.boards, null, 2));
  });
  mcp.tool(
    'use_board',
    'Switch to a DIFFERENT board for the SAME project — use this to keep a separate review stream for another area of the repo (same repo/branch otherwise shares ONE board). `name` opens a named board for this project, creating it if needed (e.g. "storefront-refactor"); pass "main" (or omit) to return to the project\'s default board. Alternatively pass `board_id` to jump to a specific existing board (e.g. recovering stranded threads). The choice PERSISTS across restarts for this project until you switch again. Use list_boards to see what exists.',
    { name: S.optional(), board_id: S.optional() },
    async ({ name, board_id }) => {
      if (board_id) {
        const r = await client.useBoardId(board_id);
        return r ? ok(`Now on board ${board_id}. Threads go here until you switch back (persists across restarts). URL: ${client.getBoardUrl()}`) : ok(`No board ${board_id}.`);
      }
      const r = await client.useNamedBoard(name);
      const count = await client.call('/threads').then((j) => j.threads.length).catch(() => 0);
      return ok(`Now on the "${r.name}" board (${count} thread${count === 1 ? '' : 's'}) — ${client.getBoardUrl()}. New threads go here until you switch back (persists across restarts). Share this URL with the user.`);
    }
  );
  mcp.tool('import_threads', 'Copy threads (with full message history) from another board into THIS board. mode "append" (default) or "replace".', { from_board_id: S, mode: z.enum(['append', 'replace']).optional() }, async ({ from_board_id, mode }) => {
    const src = await client.root(`/api/b/${from_board_id}/export`);
    const j = await client.call('/import', { method: 'POST', body: { threads: src.threads, summary: src.summary, mode: mode || 'append' } });
    return ok(`Imported ${j.added} thread(s) from ${from_board_id}. This board now has ${j.total}.`);
  });
  mcp.tool('export_board', 'Export the full JSON of THIS board (all threads + messages + summary).', {}, async () => {
    const j = await client.call('/export');
    return ok(JSON.stringify(j, null, 2));
  });
  mcp.tool('backup_board', "Write a timestamped backup file of THIS board to the daemon's backups/ folder. Returns the path.", {}, async () => {
    const j = await client.call('/backup', { method: 'POST', body: {} });
    return ok(`Backed up ${j.threads} threads to ${j.file}`);
  });
}
