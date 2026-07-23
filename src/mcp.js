#!/usr/bin/env node
// Entry point (the `mcp-session-threads` bin): an MCP stdio server. It ensures
// the shared daemon is running, resolves this project's board, and exposes the
// review-board tools. Spawned per Claude Code / MCP session.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createClient } from './client.js';
import { registerTools, INSTRUCTIONS } from './tools.js';

const log = (...a) => console.error('[session-threads]', ...a);

const config = loadConfig();
const client = createClient(config, log);
await client.ensureDaemon();
await client.resolveBoard();
log(`board ready (key=${config.boardKey}) at ${client.getBoardUrl()}`);

const mcp = new McpServer({ name: 'session-threads', version: '1.0.0' }, { instructions: INSTRUCTIONS });
registerTools(mcp, client);

const transport = new StdioServerTransport();
transport.onclose = () => process.exit(0); // exit with the session; the daemon (and boards) persist
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
await mcp.connect(transport);
log('MCP server ready on stdio');
