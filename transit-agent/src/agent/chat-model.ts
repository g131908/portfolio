// Port for any LLM that supports tool calling. The agent loop depends on this, not on a vendor SDK.

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON string as produced by the model; may be invalid. */
  readonly arguments: string;
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ModelReply {
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: { promptTokens: number; completionTokens: number } | null;
}

export interface ChatModel {
  complete(req: { messages: readonly ChatMessage[]; tools: readonly ToolSpec[]; signal?: AbortSignal }): Promise<ModelReply>;
}
