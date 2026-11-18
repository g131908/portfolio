// Exposes the transit tools over the Model Context Protocol, so any MCP client
// (Cursor, VS Code, desktop AI assistants, …) can use live Berlin transit data.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { invokeTool, type Tool } from '../agent/tools.js';

export const SERVER_INFO = { name: 'berlin-transit', version: '1.0.0' } as const;

export function createMcpServer(tools: readonly Tool[]): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: 'Live public transport data for Berlin and Brandenburg (VBB/BVG) plus weather. '
      + 'Stops can be given by name ("Alexanderplatz") or 9-digit VBB id. Times are Europe/Berlin.',
  });

  for (const t of tools) {
    server.registerTool(t.name, {
      title: t.title,
      description: t.description,
      inputSchema: t.input.shape,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    }, async (args: unknown) => {
      const result = await invokeTool(tools, t.name, args);
      if (!result.ok) {
        return { isError: true, content: [{ type: 'text' as const, text: result.error + (result.retryable ? ' (temporary, try again later)' : '') }] };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
        structuredContent: result.data as Record<string, unknown>,
      };
    });
  }
  return server;
}
