import { DeepSeekProvider } from './deepseek.ts';
import { ChatGPTProvider } from './chatgpt.ts';
import { QwenProvider } from './qwen.ts';
import { GeminiProvider } from './gemini.ts';
import { providerId } from './catalog.ts';
import type { ProviderAdapter, ProviderId } from './types.ts';
const providers = new Map<ProviderId, ProviderAdapter>();
export function getProvider(): ProviderAdapter {
  const id = providerId();
  let provider = providers.get(id);
  if (provider) return provider;
  if (id === 'gemini') { const gemini = new GeminiProvider(); providers.set(id, gemini); return gemini; }
  const created: ProviderAdapter = id === 'deepseek' ? new DeepSeekProvider() : id === 'qwen' ? new QwenProvider() : new ChatGPTProvider();
  providers.set(id, created);
  return created;
}
