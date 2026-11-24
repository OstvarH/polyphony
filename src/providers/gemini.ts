import { ApiError, type Content, type Part as GeminiPart, GoogleGenAI } from '@google/genai';
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

export class GeminiProvider implements ChatProvider {
  readonly id = 'google';
  readonly #ai: GoogleGenAI;

  constructor(options: { apiKey: string }) {
    this.#ai = new GoogleGenAI({ apiKey: options.apiKey });
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    let response: Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>;
    try {
      response = await this.#ai.models.generateContent({
        model: request.model,
        contents: request.messages.map(toGemini),
        config: {
          systemInstruction: request.system,
          maxOutputTokens: request.maxTokens,
          ...(request.signal ? { abortSignal: request.signal } : {}),
          ...(request.tools.length > 0
            ? {
                tools: [
                  {
                    functionDeclarations: request.tools.map((tool) => ({
                      name: tool.name,
                      description: tool.description,
                      parametersJsonSchema: tool.parameters,
                    })),
                  },
                ],
              }
            : {}),
        },
      });
    } catch (error) {
      throw toProviderError(error);
    }

    const candidate = response.candidates?.[0];
    const content: Content = candidate?.content ?? { role: 'model', parts: [] };
    const parts: Part[] = [];
    let n = 0;
    for (const part of content.parts ?? []) {
      if (part.thought) continue;
      if (part.text) parts.push({ type: 'text', text: part.text });
      if (part.functionCall) {
        n += 1;
        parts.push({
          type: 'tool_call',
          id: part.functionCall.id ?? `call_${n}`,
          name: part.functionCall.name ?? '',
          input: part.functionCall.args ?? {},
        });
      }
    }
    const usage = response.usageMetadata;
    return {
      message: { role: 'assistant', parts, native: { provider: this.id, content } },
      stop: stopReason(candidate?.finishReason, parts),
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      },
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    try {
      const models: ProviderModel[] = [];
      const pager = await this.#ai.models.list();
      for await (const model of pager) {
        if (!model.name || !(model.supportedActions ?? []).includes('generateContent')) continue;
        const id = model.name.replace(/^models\//, '');
        models.push({ id, label: model.displayName ?? id });
      }
      return models;
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

export function toGemini(message: ChatMessage): Content {
  if (message.role === 'assistant') {
    // Replayed unchanged so thought signatures survive.
    if (message.native?.provider === 'google') return message.native.content as Content;
    return {
      role: 'model',
      parts: message.parts.flatMap((part): GeminiPart[] => {
        if (part.type === 'text') return [{ text: part.text }];
        if (part.type === 'tool_call') {
          return [
            {
              functionCall: {
                id: part.id,
                name: part.name,
                args: (part.input ?? {}) as Record<string, unknown>,
              },
            },
          ];
        }
        return [];
      }),
    };
  }
  return {
    role: 'user',
    parts: message.parts.flatMap((part): GeminiPart[] => {
      if (part.type === 'text') return [{ text: part.text }];
      if (part.type === 'tool_result') {
        return [
          {
            functionResponse: {
              id: part.callId,
              name: part.name,
              response: part.isError ? { error: part.content } : { output: part.content },
            },
          },
        ];
      }
      return [];
    }),
  };
}

function stopReason(reason: string | undefined, parts: Part[]): StopReason {
  if (parts.some((p) => p.type === 'tool_call')) return 'tool_calls';
  switch (reason) {
    case 'STOP':
      return 'end';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'refusal';
    default:
      return 'other';
  }
}

function toProviderError(error: unknown): ProviderError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return new ProviderError('google', 'auth', 'Google rejected the API key.', error);
    }
    if (error.status === 429) {
      return new ProviderError('google', 'rate_limit', 'Google rate limit reached.', error);
    }
    if (error.status >= 500) return new ProviderError('google', 'unavailable', message, error);
    return new ProviderError('google', 'bad_request', message, error);
  }
  return new ProviderError('google', 'unavailable', message, error);
}
