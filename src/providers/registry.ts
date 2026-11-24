import { z } from 'zod';
import { AnthropicProvider } from './anthropic.ts';
import { GeminiProvider } from './gemini.ts';
import { MockProvider } from './mock.ts';
import { OpenAIProvider } from './openai.ts';
import type { ChatProvider } from './types.ts';

export const PROVIDER_KINDS = [
  'anthropic',
  'openai',
  'google',
  'openai-compatible',
  'mock',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** A configured provider. The API key is stored encrypted and only decrypted to build a client. */
export const ProviderConfigSchema = z.object({
  /** What models are filed under: "anthropic", "openai", "google", "ollama", ... */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  kind: z.enum(PROVIDER_KINDS),
  label: z.string().min(1),
  baseURL: z.url().optional(),
  enabled: z.boolean(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const PROVIDER_DEFAULTS: Record<
  ProviderKind,
  { id: string; label: string; baseURL?: string }
> = {
  anthropic: { id: 'anthropic', label: 'Anthropic' },
  openai: { id: 'openai', label: 'OpenAI' },
  google: { id: 'google', label: 'Google Gemini' },
  'openai-compatible': {
    id: 'ollama',
    label: 'Ollama (local)',
    baseURL: 'http://127.0.0.1:11434/v1',
  },
  mock: { id: 'mock', label: 'Mock (offline demo)' },
};

export function createProvider(
  config: ProviderConfig,
  apiKey: string,
  mockDelayMs?: number,
): ChatProvider {
  switch (config.kind) {
    case 'anthropic':
      return new AnthropicProvider({
        apiKey,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      });
    case 'openai':
      return new OpenAIProvider({ apiKey, ...(config.baseURL ? { baseURL: config.baseURL } : {}) });
    case 'openai-compatible':
      return new OpenAIProvider({
        id: config.id,
        apiKey,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      });
    case 'google':
      return new GeminiProvider({ apiKey });
    case 'mock':
      return new MockProvider(mockDelayMs === undefined ? {} : { delayMs: mockDelayMs });
  }
}
