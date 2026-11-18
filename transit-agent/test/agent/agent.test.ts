import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatModel, ModelReply, ToolSpec } from '../../src/agent/chat-model.js';
import { createTools, invokeTool } from '../../src/agent/tools.js';
import { TransitAgent, type AgentEvent } from '../../src/agent/transit-agent.js';
import { FIXTURE_NOW, recordedUpstream, servicesWith } from '../helpers.js';

/** Scripted model: returns the given replies in order and records what it was sent. */
class ScriptedModel implements ChatModel {
  readonly seen: Array<{ messages: readonly ChatMessage[]; tools: readonly ToolSpec[] }> = [];
  constructor(private readonly replies: ModelReply[]) {}
  async complete(req: { messages: readonly ChatMessage[]; tools: readonly ToolSpec[] }): Promise<ModelReply> {
    this.seen.push({ messages: [...req.messages], tools: req.tools });
    const r = this.replies.shift();
    if (!r) throw new Error('script exhausted');
    return r;
  }
}
const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: JSON.stringify(args) });
const reply = (over: Partial<ModelReply>): ModelReply => ({ content: null, toolCalls: [], usage: { promptTokens: 100, completionTokens: 20 }, ...over });

const tools = () => createTools(servicesWith(recordedUpstream()));

describe('tools', () => {
  it('expose JSON-schema parameters to the model', () => {
    const model = new ScriptedModel([reply({ content: 'hi' })]);
    return new TransitAgent(model, tools(), () => FIXTURE_NOW).ask('hi').then(() => {
      const specs = model.seen[0]!.tools;
      expect(specs.map((t) => t.name)).toEqual(['find_stops', 'departure_board', 'plan_trip', 'weather_at_stop']);
      expect(specs[1]!.parameters).toMatchObject({ type: 'object', required: ['stop'] });
    });
  });

  it('turn bad input and unknown stops into model-readable errors', async () => {
    const t = tools();
    expect(await invokeTool(t, 'departure_board', { stop: 'x' })).toMatchObject({ ok: false, retryable: false });
    expect(await invokeTool(t, 'departure_board', { stop: '900999999' })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
    expect(await invokeTool(t, 'nope', {})).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown tool/) });
  });
});

describe('TransitAgent', () => {
  it('calls tools, feeds results back and returns the final answer', async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call('c1', 'departure_board', { stop: 'Alexanderplatz', line: 'U5' })] }),
      reply({ content: 'The U5 to Hauptbahnhof leaves in 2 minutes from platform 1, running 2 minutes late.' }),
    ]);
    const events: AgentEvent[] = [];
    const answer = await new TransitAgent(model, tools(), () => FIXTURE_NOW).ask('When is the next U5 at Alex?', { onEvent: (e) => events.push(e) });

    expect(answer.text).toMatch(/U5/);
    expect(answer).toMatchObject({ steps: 2, toolCalls: 1, tokens: { prompt: 200, completion: 40 } });
    const toolMsg = model.seen[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg && JSON.parse(toolMsg.content)).toMatchObject({ ok: true, data: { stop: 'S+U Alexanderplatz Bhf (Berlin)' } });
    expect(events.map((e) => e.type)).toEqual(['thinking', 'tool-call', 'tool-result', 'thinking', 'answer']);
  });

  it('puts the current Berlin time into the system prompt', async () => {
    const model = new ScriptedModel([reply({ content: 'ok' })]);
    await new TransitAgent(model, tools(), () => FIXTURE_NOW).ask('hi');
    expect(model.seen[0]!.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('17:58') });
  });

  it('runs parallel tool calls of one step and answers every call id', async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [call('a', 'weather_at_stop', { stop: 'Alexanderplatz' }), call('b', 'find_stops', { query: 'Alex' })] }),
      reply({ content: 'done' }),
    ]);
    await new TransitAgent(model, tools(), () => FIXTURE_NOW).ask('weather?');
    const ids = model.seen[1]!.messages.filter((m) => m.role === 'tool').map((m) => (m as { toolCallId: string }).toolCallId);
    expect(ids).toEqual(['a', 'b']);
  });

  it('survives malformed tool arguments from the model', async () => {
    const model = new ScriptedModel([
      reply({ toolCalls: [{ id: 'x', name: 'find_stops', arguments: '{not json' }] }),
      reply({ content: 'sorry' }),
    ]);
    const a = await new TransitAgent(model, tools(), () => FIXTURE_NOW).ask('?');
    expect(a.text).toBe('sorry');
    expect(model.seen[1]!.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('not valid JSON') });
  });

  it('stops at the step limit instead of looping forever', async () => {
    const loop = Array.from({ length: 10 }, (_, i) => reply({ toolCalls: [call(`c${i}`, 'find_stops', { query: 'Alex' })] }));
    const a = await new TransitAgent(new ScriptedModel(loop), tools(), () => FIXTURE_NOW, { maxSteps: 3 }).ask('?');
    expect(a.steps).toBe(3);
    expect(a.text).toMatch(/Stopped after 3 steps/);
  });

  it('keeps conversation history for follow-up questions', async () => {
    const model = new ScriptedModel([reply({ content: 'first' }), reply({ content: 'second' })]);
    const agent = new TransitAgent(model, tools(), () => FIXTURE_NOW);
    const first = await agent.ask('from Alex to Hbf?');
    await agent.ask('and by bike?', { history: first.transcript });
    expect(model.seen[1]!.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });
});
