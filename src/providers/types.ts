import type { Page } from 'playwright';

export type ProviderId = 'deepseek' | 'qwen' | 'chatgpt';
export type ProviderEvent =
  | { type: 'content' | 'reasoning'; text: string }
  | { type: 'usage'; completionTokens: number }
  | { type: 'finish' };
export interface ProviderModel {
  id: string;
  contextLength: number;
  maxOutputTokens?: number;
}
/** Each process owns one account/profile. Production runs an isolated worker per account. */
export interface ProviderAdapter {
  readonly id: ProviderId;
  models(): Promise<ProviderModel[]>;
  initialize(headless?: boolean): Promise<void>;
  connect(interactive?: boolean): Promise<void>;
  finishLogin?(): Promise<void>;
  isReady?(): boolean;
  confirmLogin(interactive?: boolean): Promise<void>;
  status(): Promise<ProviderStatus>;
  close(): Promise<void>;
  getActivePage(): Page | null;
  generate(prompt: string, model: string, thinking: boolean, signal?: AbortSignal): Promise<AsyncIterable<ProviderEvent>>;
}
export interface ProviderStatus {
  state: 'not_initialized' | 'authenticated' | 'login_required' | 'suspended' | 'rate_limited' | 'unavailable';
  sessionSaved: boolean;
  authenticated?: boolean;
  checkedAt: string | null;
  [key: string]: unknown;
}
