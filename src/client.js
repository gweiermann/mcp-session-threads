// Client used by the MCP process to talk to the shared daemon. Owns daemon
// lifecycle (auto-start) and this session's board identity, and makes every
// call RESILIENT: on a vanished board it re-resolves by key; on a dead daemon
// it restarts and retries — so writes never silently fail on a stale board.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, 'daemon.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient(config, log = () => {}) {
  let boardId = null;
  let boardUrl = '';

  const health = async () => {
    try {
      const r = await fetch(`${config.baseUrl}/health`);
      return r.ok;
    } catch {
      return false;
    }
  };

  async function ensureDaemon() {
    if (await health()) return;
    log('starting daemon…');
    spawn(process.execPath, [DAEMON], { detached: true, stdio: 'ignore', env: process.env }).unref();
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      if (await health()) return;
    }
    throw new Error('session-threads daemon did not become ready');
  }

  async function resolveBoard() {
    const key = config.boardKey;
    const label = config.boardLabel || key.split(/[/\\]/).pop() || 'review';
    const r = await fetch(`${config.baseUrl}/api/boards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, label }),
    });
    const j = await r.json();
    boardId = j.id;
    boardUrl = j.url;
    return j;
  }

  /** Board-scoped call with self-healing (re-resolve on 404, restart on down). */
  async function call(path, { method = 'GET', body } = {}, _retry = false) {
    let r;
    try {
      r = await fetch(`${config.baseUrl}/api/b/${boardId}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (_retry) throw new Error(`session-threads daemon unreachable: ${e.message}`);
      await ensureDaemon();
      await resolveBoard();
      return call(path, { method, body }, true);
    }
    if (r.status === 404 && !_retry) {
      await resolveBoard(); // our board vanished — snap back to the keyed board
      return call(path, { method, body }, true);
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`session-threads API ${method} ${path} failed (${r.status}): ${JSON.stringify(j)}`);
    return j;
  }

  /** Un-scoped call to the daemon (e.g. board list, another board). */
  async function root(path, { method = 'GET', body } = {}) {
    const r = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`session-threads API ${method} ${path} failed (${r.status}): ${JSON.stringify(j)}`);
    return j;
  }

  return {
    ensureDaemon,
    resolveBoard,
    call,
    root,
    getBoardId: () => boardId,
    getBoardUrl: () => boardUrl,
    setBoard: (id) => {
      boardId = id;
      boardUrl = `${config.baseUrl}/b/${id}`;
    },
  };
}
