#!/usr/bin/env node
// The shared daemon: ONE long-lived HTTP server on a fixed port hosting many
// boards (one per project). Auto-started by the MCP process; survives
// individual sessions so a board's URL never moves.

import { loadConfig } from './config.js';
import { BoardStore } from './board-store.js';
import { FeedbackHub } from './feedback.js';
import { createServer } from './http-server.js';

const log = (...a) => console.error('[session-threads-daemon]', ...a);

const config = loadConfig();
const store = new BoardStore(config.dataDir);
const hub = new FeedbackHub();
const server = createServer(store, hub, config);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`port ${config.port} already in use — another daemon is running; exiting`);
    process.exit(0);
  }
  log('server error:', e.message);
  process.exit(1);
});

server.listen(config.port, config.host, () => log(`daemon on ${config.baseUrl}/ (data: ${config.dataDir})`));
