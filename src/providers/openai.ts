import OpenAI from 'openai';
import {
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type Part,
  ProviderError,
  type ProviderModel,
  type StopReason,
} from './types.ts';

/**
 * OpenAI, and any server that speaks the OpenAI Chat Completions API (Ollama, LM Studio, vLLM,
 * OpenRouter, Groq, ...). `id` is what the models are filed under, so several compatible servers
 * can be configured side by side.
 */
export class OpenAIProvider implements ChatProvider {
  readonly id: string;
  readonly #client: OpenAI;
  readonly #compatible: boolean;

  constructor(options: { id?: string; apiKey: string; baseURL?: string }) {
    this.id = options.id ?? 'openai';
    this.#compatible = this.id !== 'openai';
    this.#client = new OpenAI({
      apiKey: options.apiKey || 'not-needed',
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      maxRetries: 2,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: request.system },
      ...request.messages.flatMap(toOpenAI),
    ];
    let completion: OpenAI.Chat.ChatCompletion;
    try {
      completion = await this.#client.chat.completions.create(
        {
          model: request.model,
          messages,
          ...(request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  type: 'function' as const,
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
              }
            : {}),
          // Compatible servers often only know the older parameter name.
          ...(this.#compatible
            ? { max_tokens: request.maxTokens }
            : { max_completion_tokens: request.maxTokens }),
          ...(request.effort && !this.#compatible ? { reasoning_effort: request.effort } : {}),
        },
        { signal: request.signal },
      );
    } catch (error) {
      throw this.#error(error);
    }

    const choice = completion.choices[0];
    const parts: Part[] = [];
    if (choice?.message.content) parts.push({ type: 'text', text: choice.message.content });
    for (const call of choice?.message.tool_calls ?? []) {
      if (call.type !== 'function') continue;
      parts.push({
        type: 'tool_call',
        id: call.id,
        name: call.function.name,
        input: parseArguments(call.function.arguments),
      });
    }
    return {
      message: { role: 'assistant', parts },
      stop: stopReason(choice?.finish_reason, parts),
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      },
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    try {
      const models: ProviderModel[] = [];
      for await (const model of this.#client.models.list()) {
        models.push({ id: model.id, label: model.id });
      }
      return models.sort((a, b) => a.id.localeCompare(b.id));
    } catch (error) {
      throw this.#error(error);
    }
  }

  #error(error: unknown): ProviderError {
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof OpenAI.AuthenticationError ||
      error instanceof OpenAI.PermissionDeniedError
    ) {
      return new ProviderError(this.id, 'auth', `${this.id} rejected the API key.`, error);
    }
    if (error instanceof OpenAI.RateLimitError) {
      return new ProviderError(this.id, 'rate_limit', `${this.id} rate limit reached.`, error);
    }
    if (error instanceof OpenAI.BadRequestError || error instanceof OpenAI.NotFoundError) {
      return new ProviderError(this.id, 'bad_request', message, error);
    }
    if (error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.InternalServerError) {
      return new ProviderError(this.id, 'unavailable', message, error);
    }
    return new ProviderError(this.id, 'other', message, error);
  }
}

export function toOpenAI(message: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (message.role === 'assistant') {
    const text = message.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n');
    const calls = message.parts.flatMap((p) =>
      p.type === 'tool_call'
        ? [
            {
              id: p.id,
              type: 'function' as const,
              function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
            },
          ]
        : [],
    );
    return [
      { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) },
    ];
  }
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  // Tool results must directly follow the assistant turn that called them.
  for (const part of message.parts) {
    if (part.type === 'tool_result') {
      out.push({
        role: 'tool',
        tool_call_id: part.callId,
        content: part.isError ? `ERROR: ${part.content}` : part.content,
      });
    }
  }
  const text = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n');
  if (text) out.push({ role: 'user', content: text });
  return out;
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    // Handed to the runtime, which reports it back to the model as an invalid call.
    return { __invalid_json__: raw };
  }
}

function stopReason(reason: string | null | undefined, parts: Part[]): StopReason {
  if (parts.some((p) => p.type === 'tool_call')) return 'tool_calls';
  switch (reason) {
    case 'stop':
      return 'end';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}
