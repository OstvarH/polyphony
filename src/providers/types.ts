/**
 * The provider-neutral conversation format. The runtime speaks only this; each provider adapter
 * translates to and from its own API.
 */

export type Part =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; name: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: 'user' | 'assistant';
  parts: Part[];
  /**
   * The provider's own representation of an assistant turn. Adapters replay it unchanged to the
   * same provider, which keeps provider-specific state (reasoning blocks, signatures) intact.
   */
  native?: { provider: string; content: unknown };
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export type Effort = 'low' | 'medium' | 'high';

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  /** A hint for how hard the model should think, used by providers that support it. */
  effort?: Effort;
  signal?: AbortSignal;
}

export type StopReason = 'end' | 'tool_calls' | 'max_tokens' | 'refusal' | 'other';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  message: ChatMessage;
  stop: StopReason;
  usage: Usage;
}

export interface ProviderModel {
  id: string;
  label: string;
}

export interface ChatProvider {
  /** The id models are filed under, e.g. "anthropic" or "ollama". */
  readonly id: string;
  chat(request: ChatRequest): Promise<ChatResult>;
  listModels(): Promise<ProviderModel[]>;
}

export type ProviderErrorKind = 'auth' | 'rate_limit' | 'bad_request' | 'unavailable' | 'other';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;

  constructor(provider: string, kind: ProviderErrorKind, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
  }

  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'unavailable';
  }
}

export function textOf(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

export function toolCallsOf(message: ChatMessage): Extract<Part, { type: 'tool_call' }>[] {
  return message.parts.filter(
    (p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call',
  );
}
