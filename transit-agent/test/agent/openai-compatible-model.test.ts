import { describe, expect, it } from 'vitest';
import { OpenAiCompatibleModel } from '../../src/infrastructure/llm/openai-compatible-model.js';
import { json } from '../helpers.js';

describe('OpenAiCompatibleModel', () => {
  it('speaks the chat completions wire format both ways', async () => {
    let sent: { url: string; body: any; headers: any } | null = null;
    const fetchFn: typeof fetch = async (url, init) => {
      sent = { url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers };
      return json({
        choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'find_stops', arguments: '{"query":"Alex"}' } }] } }],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      });
    };
    const model = new OpenAiCompatibleModel({ baseUrl: 'http://localhost:11434/v1/', model: 'llama3.1', apiKey: 'k' }, fetchFn);
    const r = await model.complete({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c0', name: 'x', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'c0', content: '{}' },
      ],
      tools: [{ name: 'find_stops', description: 'd', parameters: { type: 'object' } }],
    });
    expect(sent!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(sent!.headers.authorization).toBe('Bearer k');
    expect(sent!.body.messages[1].tool_calls[0]).toEqual({ id: 'c0', type: 'function', function: { name: 'x', arguments: '{}' } });
    expect(sent!.body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c0', content: '{}' });
    expect(r).toEqual({ content: null, toolCalls: [{ id: 'call_1', name: 'find_stops', arguments: '{"query":"Alex"}' }], usage: { promptTokens: 50, completionTokens: 10 } });
  });

  it('gives actionable errors', async () => {
    const model = new OpenAiCompatibleModel({ baseUrl: 'https://api.example/v1', model: 'm' }, async () => json({ error: 'bad key' }, 401));
    await expect(model.complete({ messages: [], tools: [] })).rejects.toThrow(/401 \(check the API key\)/);
  });
});
