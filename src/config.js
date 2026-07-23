// Central configuration, all overridable via environment variables.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Package root (contains src/, public/). */
export const ROOT = join(HERE, '..');

/** Directory holding this package's static web assets. */
export const PUBLIC_DIR = join(ROOT, 'public');

/**
 * Build the effective config from the environment. Read lazily so tests can
 * tweak `process.env` before constructing a server.
 */
export function loadConfig(env = process.env) {
  const host = env.SESSION_THREADS_HOST || '127.0.0.1';
  const port = Number(env.SESSION_THREADS_PORT || 4517);
  return {
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    // Boards persist here across restarts; in a user-writable location by default.
    dataDir: env.SESSION_THREADS_DATA_DIR || join(homedir(), '.session-threads', 'boards'),
    // Stable board identity for a session. Defaults to the working directory so
    // each project gets its own persistent board that survives MCP restarts.
    boardKey: env.SESSION_THREADS_BOARD_KEY || process.cwd(),
    boardLabel: env.SESSION_THREADS_LABEL || '',
  };
}
