// FeedbackHub — the long-poll bridge between the web UI (which POSTs replies)
// and the agent (which GETs /wait). Per-board: it wakes a waiting agent the
// instant a reply is submitted, or queues the reply until the next wait.
//
// Only carries reply *notifications*; durable data (messages, notes) lives in
// the BoardStore. Kept free of HTTP so it can be unit-tested with fake timers.

export class FeedbackHub {
  constructor() {
    /** @type {Map<string, Set<Function>>} boardId -> resolvers */
    this.waiters = new Map();
    /** @type {Map<string, {replies: object[]}>} boardId -> queued batch */
    this.pending = new Map();
  }

  #waitersFor(boardId) {
    let s = this.waiters.get(boardId);
    if (!s) this.waiters.set(boardId, (s = new Set()));
    return s;
  }

  /** Deliver reply notifications: wake any waiter, else queue for the next wait. */
  deliver(boardId, replies = []) {
    const existing = this.pending.get(boardId);
    if (existing) existing.replies.push(...replies);
    else this.pending.set(boardId, { replies: [...replies] });

    const waiters = this.#waitersFor(boardId);
    if (waiters.size) {
      const batch = this.pending.get(boardId);
      this.pending.delete(boardId);
      for (const resolve of waiters) resolve({ status: 'feedback', replies: batch.replies });
      waiters.clear();
    }
  }

  /**
   * Wait up to `timeoutMs` for feedback on a board.
   * Resolves immediately if a batch is already queued.
   * @returns {Promise<{status:'feedback'|'timeout', replies: object[]}>}
   */
  wait(boardId, timeoutMs) {
    const queued = this.pending.get(boardId);
    if (queued) {
      this.pending.delete(boardId);
      return Promise.resolve({ status: 'feedback', replies: queued.replies });
    }
    return new Promise((resolve) => {
      const waiters = this.#waitersFor(boardId);
      const settle = (value) => {
        clearTimeout(timer);
        waiters.delete(settle);
        resolve(value);
      };
      const timer = setTimeout(() => {
        waiters.delete(settle);
        resolve({ status: 'timeout', replies: [] });
      }, timeoutMs);
      waiters.add(settle);
    });
  }
}
