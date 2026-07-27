import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, projectRoot, ROOT } from '../src/config.js';

test('projectRoot: repo root and any subdir map to the same git root', () => {
  assert.equal(projectRoot(ROOT), ROOT, 'the package root resolves to itself');
  assert.equal(projectRoot(join(ROOT, 'src')), ROOT, 'a subdir resolves to the repo root (stable across dirs)');
});

test('projectRoot: falls back to the directory when it is not a git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-notgit-'));
  const sub = join(dir, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  try {
    assert.equal(projectRoot(dir), dir, 'non-git dir falls back to itself');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SESSION_THREADS_BOARD_KEY overrides the derived key', () => {
  assert.equal(loadConfig({ SESSION_THREADS_BOARD_KEY: '/pinned/key' }).boardKey, '/pinned/key');
});
