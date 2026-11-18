// Agent loop: the model decides which tools to call, we execute them and feed results back
// until it produces an answer. Governors cap steps, tool calls and output size.

import { z } from 'zod';
import type { ChatMessage, ChatModel, ToolCall, ToolSpec } from './chat-model.js';
import { invokeTool, type Tool, type ToolResult } from './tools.js';

export type AgentEvent =
  | { type: 'thinking'; step: number }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; name: string; ok: boolean; ms: number; preview: string }
  | { type: 'answer'; text: string }
  | { type: 'limit'; reason: string };

export interface AgentAnswer {
  readonly text: string;
  readonly steps: number;
  readonly toolCalls: number;
  readonly tokens: { prompt: number; completion: number };
  /** Full transcript so a follow-up question keeps context. */
  readonly transcript: readonly ChatMessage[];
}

export interface AgentLimits {
  readonly maxSteps: number;
  readonly maxToolCallsPerStep: number;
  /** Tool output is truncated to protect the context window and cost. */
  readonly maxToolResultChars: number;
  readonly maxHistoryMessages: number;
}

const DEFAULT_LIMITS: AgentLimits = { maxSteps: 6, maxToolCallsPerStep: 4, maxToolResultChars: 6_000, maxHistoryMessages: 30 };

export function systemPrompt(now: Date): string {
  const berlin = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Berlin',
  }).format(now);
  return [
    'You are a Berlin public transport assistant with live data from the VBB/BVG network and live weather.',
    `Current time in Berlin: ${berlin}.`,
    'Rules:',
    '- Always use the tools for departures, connections and weather. Never invent times, lines or delays.',
    '- If a tool reports stale data or an outage, say so plainly.',
    '- If a stop name is ambiguous, pick the most likely one and mention which stop you used.',
    '- Answer in the language of the user, short and practical: what to take, when, from where, and why.',
    '- For "should I bike?" questions, use plan_trip and explain the recommendation with its reasons.',
  ].join('\n');
}

export function toToolSpecs(tools: readonly Tool[]): ToolSpec[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: z.toJSONSchema(t.input, { target: 'draft-7' }) as Record<string, unknown>,
  }));
}

function parseArgs(call: ToolCall): unknown {
  try {
    return call.arguments.trim() ? JSON.parse(call.arguments) : {};
  } catch {
    return Symbol.for('invalid-json');
  }
}

function serialize(result: ToolResult, maxChars: number): string {
  const s = JSON.stringify(result);
  return s.length <= maxChars ? s : `${s.slice(0, maxChars)}… [truncated]`;
}

export class TransitAgent {
  private readonly specs: ToolSpec[];
  private readonly limits: AgentLimits;

  constructor(
    private readonly model: ChatModel,
    private readonly tools: readonly Tool[],
    private readonly now: () => Date,
    limits: Partial<AgentLimits> = {},
  ) {
    this.specs = toToolSpecs(tools);
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async ask(
    question: string,
    opts: { history?: readonly ChatMessage[]; onEvent?: (e: AgentEvent) => void; signal?: AbortSignal } = {},
  ): Promise<AgentAnswer> {
    const emit = opts.onEvent ?? (() => {});
    const history = (opts.history ?? []).filter((m) => m.role !== 'system').slice(-this.limits.maxHistoryMessages);
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(this.now()) }, ...history, { role: 'user', content: question }];
    const tokens = { prompt: 0, completion: 0 };
    let toolCalls = 0;

    for (let step = 1; step <= this.limits.maxSteps; step++) {
      opts.signal?.throwIfAborted();
      emit({ type: 'thinking', step });
      const reply = await this.model.complete({ messages, tools: this.specs, ...(opts.signal ? { signal: opts.signal } : {}) });
      if (reply.usage) {
        tokens.prompt += reply.usage.promptTokens;
        tokens.completion += reply.usage.completionTokens;
      }

      if (reply.toolCalls.length === 0) {
        const text = reply.content?.trim() || 'Sorry, I could not produce an answer.';
        messages.push({ role: 'assistant', content: text });
        emit({ type: 'answer', text });
        return { text, steps: step, toolCalls, tokens, transcript: messages.slice(1) };
      }

      const calls = reply.toolCalls.slice(0, this.limits.maxToolCallsPerStep);
      messages.push({ role: 'assistant', content: reply.content, toolCalls: [...reply.toolCalls] });
      // Independent tool calls of one step run in parallel.
      const results = await Promise.all(calls.map(async (call) => {
        const input = parseArgs(call);
        emit({ type: 'tool-call', id: call.id, name: call.name, input });
        const started = Date.now();
        const result: ToolResult = typeof input === 'symbol'
          ? { ok: false, error: 'Arguments were not valid JSON', retryable: false }
          : await invokeTool(this.tools, call.name, input);
        const content = serialize(result, this.limits.maxToolResultChars);
        emit({ type: 'tool-result', id: call.id, name: call.name, ok: result.ok, ms: Date.now() - started, preview: content.slice(0, 300) });
        return { call, content };
      }));
      toolCalls += results.length;
      for (const { call, content } of results) messages.push({ role: 'tool', toolCallId: call.id, content });
      // the model must answer every tool call it made, even the ones we skipped
      for (const skipped of reply.toolCalls.slice(this.limits.maxToolCallsPerStep)) {
        messages.push({ role: 'tool', toolCallId: skipped.id, content: JSON.stringify({ ok: false, error: 'Too many tool calls in one step; skipped.' }) });
      }
    }

    const reason = `Stopped after ${this.limits.maxSteps} steps without a final answer.`;
    emit({ type: 'limit', reason });
    return { text: `${reason} Please ask a more specific question.`, steps: this.limits.maxSteps, toolCalls, tokens, transcript: messages.slice(1) };
  }
}
