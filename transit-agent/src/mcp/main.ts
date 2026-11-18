// Entry point: `npx tsx src/mcp/main.ts` or the bundled `dist/mcp-server.js`.
// Speaks MCP over stdio; logs go to stderr because stdout belongs to the protocol.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTools } from '../agent/tools.js';
import { createServices } from '../composition.js';
import { createMcpServer } from './server.js';

const services = createServices({
  ...(process.env['VBB_BASE_URL'] ? { vbbBaseUrl: process.env['VBB_BASE_URL'] } : {}),
});
const server = createMcpServer(createTools(services));

await server.connect(new StdioServerTransport());
console.error('berlin-transit MCP server ready on stdio');

const shutdown = async () => {
  await server.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
