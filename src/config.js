// Central configuration, all overridable via environment variables.
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Stable per-project key for the board. Uses the git repository root so that
 * git worktrees and subdirectories of the same repo all resolve to ONE board
 * (the working directory alone is not stable — Claude Code runs agents in
 * `.claude/worktrees/…` and subdirs, which would otherwise each spawn a new
 * board and make the agent hop between boards mid-session). Falls back to the
 * given directory when it is not a git repo (or git is unavailable).
 */
export function projectRoot(cwd) {
  try {
    // --git-common-dir points at the MAIN worktree's .git even from a linked
    // worktree, so every worktree + subdir of a repo maps to the same root.
    const common = execSync('git rev-parse --git-common-dir', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (common) return dirname(resolve(cwd, common));
  } catch {
    /* not a git repo, or git not on PATH */
  }
  return cwd;
}

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
    // Stable board identity for a session. Defaults to the git repo root so each
    // project gets ONE persistent board across restarts, worktrees, and subdirs.
    boardKey: env.SESSION_THREADS_BOARD_KEY || projectRoot(process.cwd()),
    boardLabel: env.SESSION_THREADS_LABEL || '',
  };
}
