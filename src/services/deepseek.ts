import { getDeepSeekHeaders, DeepSeekHeaders } from './playwright.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('deepseek');

const sessionStates: Record<string, number | null> = (globalThis as any)._sessionStates || {};
(globalThis as any)._sessionStates = sessionStates;

export function updateSessionParent(sessionId: string, parentId: number | null): void {
  if (sessionId) {
    sessionStates[sessionId] = parentId;
  }
}

export interface DeepSeekPayload {
  chat_session_id?: string;
  parent_message_id?: number | null;
  model_type: string | null;
  prompt: string;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  preempt: boolean;
}

export interface DeepSeekStreamResult {
  stream: ReadableStream;
  headers: DeepSeekHeaders;
  uiSessionId: string;
}

const DEEPSEEK_CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

function buildRequestHeaders(headers: DeepSeekHeaders): Record<string, string> {
  const appVersion = process.env.DEEPSEEK_APP_VERSION || '2.0.0';
  const clientVersion = process.env.DEEPSEEK_CLIENT_VERSION || appVersion;
  const clientLocale = process.env.DEEPSEEK_CLIENT_LOCALE || 'pt_BR';
  const acceptLanguage = process.env.DEEPSEEK_ACCEPT_LANGUAGE || 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7';

  return {
    accept: '*/*',
    'accept-language': acceptLanguage,
    authorization: headers.authorization,
    'content-type': 'application/json',
    origin: 'https://chat.deepseek.com',
    cookie: headers.cookie,
    'x-ds-pow-response': headers['x-ds-pow-response'],
    'x-hif-dliq': headers['x-hif-dliq'],
    'x-hif-leim': headers['x-hif-leim'],
    'x-app-version': appVersion,
    'x-client-locale': clientLocale,
    'x-client-platform': 'web',
    'x-client-version': clientVersion,
  };
}

export async function createDeepSeekStream(
  prompt: string,
  enableThinking: boolean,
  isProModel: boolean = false,
  forcedParentId?: number | null
): Promise<DeepSeekStreamResult> {
  const { headers, chatSessionId, parentMessageId } = await getDeepSeekHeaders(forcedParentId === null);

  let actualParentId: number | null = parentMessageId;
  if (forcedParentId !== undefined) {
    actualParentId = forcedParentId;
  } else if (chatSessionId && sessionStates[chatSessionId] !== undefined) {
    actualParentId = sessionStates[chatSessionId];
  }

  const payload: DeepSeekPayload = {
    chat_session_id: chatSessionId || undefined,
    parent_message_id: actualParentId,
    model_type: isProModel ? 'expert' : null,
    prompt,
    ref_file_ids: [],
    thinking_enabled: enableThinking,
    search_enabled: true,
    preempt: false,
  };

  log.debug('Dispatching DeepSeek request', {
    sessionId: chatSessionId || '(new)',
    parentId: actualParentId,
    promptChars: prompt.length,
    thinking: enableThinking,
    pro: isProModel,
  });

  const response = await fetch(DEEPSEEK_CHAT_URL, {
    method: 'POST',
    headers: buildRequestHeaders(headers),
    body: JSON.stringify(payload),
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Failed to fetch from DeepSeek: ${response.status} ${response.statusText} - ${errText}`);
  }

  return { stream: response.body, headers, uiSessionId: chatSessionId };
}
