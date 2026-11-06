import type { ProviderId } from './types.ts';
export const DEEPSEEK_MODEL_IDS = ['deepseek-v4-flash', 'deepseek-v4-flash-thinking', 'deepseek-v4-pro', 'deepseek-v4-pro-thinking'] as const;
export function isProviderId(value: unknown): value is ProviderId { return value === 'deepseek' || value === 'qwen' || value === 'chatgpt'; }
export function providerId(value: string | undefined = process.env.PROVIDER): ProviderId {
  if (value === undefined || value === '') return 'deepseek';
  if (!isProviderId(value)) throw new Error(`Unsupported provider: ${value}`);
  return value;
}
export function providerIdForModel(model: string): ProviderId | null {
  if ((DEEPSEEK_MODEL_IDS as readonly string[]).includes(model)) return 'deepseek';
  return /^qwen\//.test(model) ? 'qwen' : /^chatgpt\//.test(model) ? 'chatgpt' : null;
}
