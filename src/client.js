// Client used by the MCP process to talk to the shared daemon. Owns daemon
// lifecycle (auto-start) and this session's board identity, and makes every
// call RESILIENT: on a vanished board it re-resolves by key; on a dead daemon
// it restarts and retries — so writes never silently fail on a stale board.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, 'daemon.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_NAMES = new Set(['', 'main', 'default']);
const labelFor = (key) => (key.includes('#') ? key.split('#').slice(1).join('#') : key.split(/[/\\]/).pop() || 'review');

export function createClient(config, log = () => {}) {
  let boardId = null;
  let boardUrl = '';

  // Per-project "active board" pointer, persisted so a restart keeps whatever
  // named board you switched to (see use_board). Lives beside the board files
  // but is NOT a .json, so BoardStore never mistakes it for a board.
  const baseKey = config.boardKey;
  const activeFile = join(config.dataDir, 'active-boards.state');
  const readActive = () => { try { return JSON.parse(readFileSync(activeFile, 'utf8')); } catch { return {}; } };
  const activeKey = () => readActive()[baseKey] || baseKey;
  const saveActive = (key) => {
    try {
      const m = readActive();
      if (key && key !== baseKey) m[baseKey] = key;
      else delete m[baseKey];
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(activeFile, JSON.stringify(m, null, 2));
    } catch {
      /* best-effort: a lost pointer just falls back to the default board */
    }
  };

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

  // Resolve the board this session should use. Defaults to the persisted active
  // board for this project (the base repo board unless use_board switched it).
  async function resolveBoard(keyArg) {
    const key = keyArg || activeKey();
    const label = keyArg ? labelFor(key) : config.boardLabel || labelFor(key);
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

  // Switch to a NAMED board within this project (create-or-open) and remember it.
  // name 'main'/'default'/'' returns to the project's base board.
  async function useNamedBoard(name) {
    const clean = String(name || '').trim();
    const key = DEFAULT_NAMES.has(clean.toLowerCase()) ? baseKey : `${baseKey}#${clean}`;
    const j = await resolveBoard(key);
    saveActive(key);
    return { ...j, name: DEFAULT_NAMES.has(clean.toLowerCase()) ? 'main' : clean };
  }

  // Switch to a specific existing board by id (recovery) and remember it.
  async function useBoardId(id) {
    const state = await root(`/api/b/${id}/state`).catch(() => null);
    if (!state) return null;
    boardId = id;
    boardUrl = `${config.baseUrl}/b/${id}`;
    saveActive(state.key || baseKey); // persist by key so a restart re-resolves the same board
    return { id, url: boardUrl, key: state.key };
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
    useNamedBoard,
    useBoardId,
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
