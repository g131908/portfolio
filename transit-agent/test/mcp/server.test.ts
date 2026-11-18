import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createTools } from '../../src/agent/tools.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { recordedUpstream, servicesWith } from '../helpers.js';

async function connect() {
  const server = createMcpServer(createTools(servicesWith(recordedUpstream())));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe('MCP server', () => {
  it('lists the tools with input schemas and read-only annotations', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['find_stops', 'departure_board', 'plan_trip', 'weather_at_stop']);
    const board = tools.find((t) => t.name === 'departure_board')!;
    expect(board.inputSchema.required).toEqual(['stop']);
    expect(board.annotations?.readOnlyHint).toBe(true);
  });

  it('answers a tool call with text and structured content', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'plan_trip', arguments: { from: 'Alexanderplatz', to: '900003201' } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ from: 'S+U Alexanderplatz Bhf (Berlin)', to: 'S+U Berlin Hauptbahnhof' });
  });

  it('reports domain errors as tool errors, not protocol failures', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'departure_board', arguments: { stop: '900999999' } });
    expect(res.isError).toBe(true);
  });
});
