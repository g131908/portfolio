// Adapter for any OpenAI-compatible chat completions API with tool calling:
// OpenAI, Groq, OpenRouter, Mistral, or a local Ollama / LM Studio server.

import { z } from 'zod';
import type { ChatMessage, ChatModel, ModelReply, ToolSpec } from '../../agent/chat-model.js';

export interface ModelConfig {
  /** e.g. https://api.openai.com/v1 or http://localhost:11434/v1 */
  readonly baseUrl: string;
  readonly model: string;
  /** Not needed for local servers. Never logged. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly temperature?: number;
}

const replySchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullish(),
      tool_calls: z.array(z.object({
        id: z.string(),
        function: z.object({ name: z.string(), arguments: z.string().nullish() }),
      })).nullish(),
    }),
  })).min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).nullish(),
});

export class ModelError extends Error {
  override readonly name = 'ModelError';
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

function toWire(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length ? {
          tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        } : {}),
      };
    default:
      return { role: m.role, content: m.content };
  }
}

export class OpenAiCompatibleModel implements ChatModel {
  constructor(private readonly cfg: ModelConfig, private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)) {
    if (!/^https?:\/\//.test(cfg.baseUrl)) throw new Error('baseUrl must start with http:// or https://');
  }

  async complete(req: { messages: readonly ChatMessage[]; tools: readonly ToolSpec[]; signal?: AbortSignal }): Promise<ModelReply> {
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs ?? 60_000);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.cfg.model,
          temperature: this.cfg.temperature ?? 0.2,
          messages: req.messages.map(toWire),
          tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
          tool_choice: 'auto',
        }),
      });
    } catch (err) {
      if (timeout.aborted) throw new ModelError('The language model did not answer in time', null);
      throw new ModelError(`Cannot reach the language model: ${(err as Error).message}`, null);
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      const hint = res.status === 401 ? ' (check the API key)' : res.status === 404 ? ' (check base URL and model name)' : '';
      throw new ModelError(`Model API answered HTTP ${res.status}${hint}: ${detail}`, res.status);
    }
    const parsed = replySchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new ModelError('The model API returned an unexpected response format', res.status);

    const msg = parsed.data.choices[0]!.message;
    return {
      content: msg.content ?? null,
      toolCalls: (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments ?? '' })),
      usage: parsed.data.usage ? { promptTokens: parsed.data.usage.prompt_tokens, completionTokens: parsed.data.usage.completion_tokens } : null,
    };
  }
}
