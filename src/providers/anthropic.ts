import Anthropic from '@anthropic-ai/sdk';
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

/** Models that accept output_config.effort and the server-side refusal fallback. */
const CURRENT_GENERATION = /^claude-(fable|mythos|opus|sonnet|haiku)-5/;
const SERVER_FALLBACK = /^claude-(fable-5-[12]|mythos-5-[12]|opus-5-5|opus-5$|sonnet-5-5)/;

export class AnthropicProvider implements ChatProvider {
  readonly id = 'anthropic';
  readonly #client: Anthropic;

  constructor(options: { apiKey: string; baseURL?: string }) {
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      maxRetries: 2,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const fallback = SERVER_FALLBACK.test(request.model);
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages.map(toAnthropic),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters as Anthropic.Beta.BetaTool.InputSchema,
            })),
          }
        : {}),
      ...(request.effort && CURRENT_GENERATION.test(request.model)
        ? { output_config: { effort: request.effort } }
        : {}),
      // A declined request is retried server-side on a model chosen by refusal category.
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    };

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.#client.beta.messages
        .stream(params, { signal: request.signal })
        .finalMessage();
    } catch (error) {
      throw toProviderError(error);
    }

    const parts: Part[] = [];
    for (const block of message.content) {
      if (block.type === 'text') parts.push({ type: 'text', text: block.text });
      else if (block.type === 'tool_use') {
        parts.push({ type: 'tool_call', id: block.id, name: block.name, input: block.input });
      }
    }
    return {
      message: {
        role: 'assistant',
        parts,
        native: { provider: this.id, content: message.content },
      },
      stop: stopReason(message.stop_reason),
      usage: {
        inputTokens:
          message.usage.input_tokens +
          (message.usage.cache_read_input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0),
        outputTokens: message.usage.output_tokens,
      },
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    try {
      const models: ProviderModel[] = [];
      for await (const model of this.#client.models.list()) {
        models.push({ id: model.id, label: model.display_name });
      }
      return models;
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

export function toAnthropic(message: ChatMessage): Anthropic.Beta.BetaMessageParam {
  if (message.role === 'assistant') {
    if (message.native?.provider === 'anthropic') {
      // Replayed unchanged: thinking and fallback blocks must come back exactly as returned.
      return {
        role: 'assistant',
        content: message.native.content as Anthropic.Beta.BetaContentBlockParam[],
      };
    }
    return {
      role: 'assistant',
      content: message.parts.flatMap((part): Anthropic.Beta.BetaContentBlockParam[] => {
        if (part.type === 'text') return part.text ? [{ type: 'text', text: part.text }] : [];
        if (part.type === 'tool_call') {
          return [{ type: 'tool_use', id: part.id, name: part.name, input: part.input ?? {} }];
        }
        return [];
      }),
    };
  }
  return {
    role: 'user',
    content: message.parts.flatMap((part): Anthropic.Beta.BetaContentBlockParam[] => {
      if (part.type === 'text') return [{ type: 'text', text: part.text }];
      if (part.type === 'tool_result') {
        return [
          {
            type: 'tool_result',
            tool_use_id: part.callId,
            content: part.content,
            ...(part.isError ? { is_error: true } : {}),
          },
        ];
      }
      return [];
    }),
  };
}

function stopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function toProviderError(error: unknown): ProviderError {
  const message = error instanceof Error ? error.message : String(error);
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return new ProviderError('anthropic', 'auth', 'Anthropic rejected the API key.', error);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderError('anthropic', 'rate_limit', 'Anthropic rate limit reached.', error);
  }
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
    return new ProviderError('anthropic', 'bad_request', message, error);
  }
  if (
    error instanceof Anthropic.APIConnectionError ||
    error instanceof Anthropic.InternalServerError
  ) {
    return new ProviderError('anthropic', 'unavailable', message, error);
  }
  return new ProviderError('anthropic', 'other', message, error);
}
