import { DeepSeekProvider } from './deepseek.ts';
import { ChatGPTProvider } from './chatgpt.ts';
import { ClaudeProvider } from './claude.ts';
import { QwenProvider } from './qwen.ts';
import { PerplexityProvider } from './perplexity.ts';
import { CohereProvider } from './cohere.ts';
import { ErnieProvider } from './ernie.ts';
import { GeminiProvider } from './gemini.ts';
import { providerId } from './catalog.ts';
import type { ProviderAdapter, ProviderId } from './types.ts';
const providers = new Map<ProviderId, ProviderAdapter>();
export function getProvider(): ProviderAdapter {
  const id = providerId();
  let provider = providers.get(id);
  if (provider) return provider;
  if (id === 'gemini') { const gemini = new GeminiProvider(); providers.set(id, gemini); return gemini; }
  const created: ProviderAdapter = id === 'deepseek' ? new DeepSeekProvider() : id === 'qwen' ? new QwenProvider() : id === 'claude' ? new ClaudeProvider() : id === 'perplexity' ? new PerplexityProvider() : id === 'cohere' ? new CohereProvider() : id === 'ernie' ? new ErnieProvider() : new ChatGPTProvider();
  providers.set(id, created);
  return created;
}
