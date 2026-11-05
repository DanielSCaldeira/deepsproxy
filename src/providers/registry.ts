import { DeepSeekProvider } from './deepseek.ts';
import { QwenProvider } from './qwen.ts';
import { providerId } from './catalog.ts';
import type { ProviderAdapter, ProviderId } from './types.ts';
const providers = new Map<ProviderId, ProviderAdapter>();
export function getProvider(): ProviderAdapter {
  const id = providerId();
  let provider = providers.get(id);
  if (provider) return provider;
  const created: ProviderAdapter = id === 'deepseek' ? new DeepSeekProvider() : new QwenProvider();
  providers.set(id, created);
  return created;
}
