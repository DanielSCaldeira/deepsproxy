import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createDeepSeekStream } from '../services/deepseek.ts';
import { OpenAIRequest } from '../utils/types.ts';
import { getModelTelemetry, recordSuccess, recordFailure } from '../services/telemetry.ts';
import { compressMessages } from '../utils/compression.ts';
import { createLogger } from '../utils/logger.ts';
import { serializeOpenAIMessages, appendToolInstructions } from './serialization.ts';
import {
  parseDeepSeekStreamToOpenAI,
  peekStream,
  makeChunk,
  ParsedCompletion,
} from './stream.ts';

const log = createLogger('chat');

const MAX_ATTEMPTS = Number(process.env.DEEPSPROXY_MAX_ATTEMPTS || '3');
const RETRY_DELAY_MS = Number(process.env.DEEPSPROXY_RETRY_DELAY_MS || '1000');

interface PreparedPrompt {
  finalPrompt: string;
  promptSize: number;
  promptTokens: number;
}

function buildPrompt(body: OpenAIRequest): PreparedPrompt {
  const telemetry = getModelTelemetry(body.model);
  const compressed = compressMessages(body.messages || [], telemetry.detectedLimit, serializeOpenAIMessages);
  const serialized = serializeOpenAIMessages(compressed);
  const systemPrompt = appendToolInstructions(serialized.systemPrompt, body);
  const finalPrompt = systemPrompt ? `${systemPrompt}\n${serialized.prompt}` : serialized.prompt;
  const promptSize = finalPrompt.length;
  return { finalPrompt, promptSize, promptTokens: Math.ceil(promptSize / 3.5) };
}

function mapErrorToStatus(errMessage: string): { status: number; code: string } {
  if (/account is suspended/i.test(errMessage)) return { status: 403, code: 'deepseek_account_suspended' };
  if (/login is required/i.test(errMessage)) return { status: 401, code: 'deepseek_login_required' };
  if (/chat input unavailable|Timeout waiting for chat input/i.test(errMessage)) {
    return { status: 409, code: 'deepseek_chat_unavailable' };
  }
  return { status: 500, code: 'upstream_error' };
}

async function tryNonStream(
  body: OpenAIRequest,
  completionId: string,
  isThinkingModel: boolean,
  isProModel: boolean
): Promise<{ parsed: ParsedCompletion; uiSessionId: string }> {
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { finalPrompt, promptSize, promptTokens } = buildPrompt(body);
    try {
      log.info('Chat attempt (non-stream)', { attempt, maxAttempts: MAX_ATTEMPTS, promptChars: promptSize });
      const result = await createDeepSeekStream(finalPrompt, isThinkingModel, isProModel, null);
      const parsed = await parseDeepSeekStreamToOpenAI(
        result.stream,
        completionId,
        body.model,
        promptTokens,
        result.uiSessionId,
        (body as any).tools || []
      );

      if (parsed.content === '' && parsed.toolCalls.length === 0) {
        log.warn('Empty response from DeepSeek', { attempt });
        recordFailure(body.model, promptSize);
        continue;
      }

      recordSuccess(body.model, promptSize);
      return { parsed, uiSessionId: result.uiSessionId };
    } catch (err: any) {
      log.error('Chat attempt failed (non-stream)', { attempt, error: err?.message || String(err) });
      lastError = err;
      recordFailure(body.model, promptSize);
      if (attempt >= MAX_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  throw lastError || new Error('Failed to get a non-empty response from DeepSeek after multiple attempts.');
}

async function tryStream(
  body: OpenAIRequest,
  isThinkingModel: boolean,
  isProModel: boolean
): Promise<{ stream: ReadableStream; uiSessionId: string; promptTokens: number }> {
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { finalPrompt, promptSize, promptTokens } = buildPrompt(body);
    try {
      log.info('Chat attempt (stream)', { attempt, maxAttempts: MAX_ATTEMPTS, promptChars: promptSize });
      const result = await createDeepSeekStream(finalPrompt, isThinkingModel, isProModel, null);
      const { isEmpty, peekedStream } = await peekStream(result.stream);
      if (isEmpty) {
        log.warn('Empty stream from DeepSeek', { attempt });
        recordFailure(body.model, promptSize);
        continue;
      }

      recordSuccess(body.model, promptSize);
      return { stream: peekedStream, uiSessionId: result.uiSessionId, promptTokens };
    } catch (err: any) {
      log.error('Chat attempt failed (stream)', { attempt, error: err?.message || String(err) });
      lastError = err;
      recordFailure(body.model, promptSize);
      if (attempt >= MAX_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  throw lastError || new Error('Failed to get a valid stream from DeepSeek after multiple attempts.');
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    const isThinkingModel = body.model.includes('thinking');
    const isProModel = body.model.includes('pro');
    const completionId = 'chatcmpl-' + uuidv4();

    if (!isStream) {
      const { parsed } = await tryNonStream(body, completionId, isThinkingModel, isProModel);

      const message: any = {
        role: 'assistant',
        content: parsed.toolCalls.length > 0 ? null : parsed.content,
      };
      if (parsed.reasoningContent) message.reasoning_content = parsed.reasoningContent;
      if (parsed.toolCalls.length > 0) message.tool_calls = parsed.toolCalls;

      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message, logprobs: null, finish_reason: parsed.finishReason }],
        usage: parsed.usage,
      });
    }

    const { stream: deepSeekStream, uiSessionId, promptTokens } = await tryStream(body, isThinkingModel, isProModel);

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return honoStream(c, async (streamWriter: any) => {
      const writeEvent = async (data: any) => {
        await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      await writeEvent(makeChunk(completionId, body.model, { role: 'assistant', content: '' }));

      const parsed = await parseDeepSeekStreamToOpenAI(
        deepSeekStream,
        completionId,
        body.model,
        promptTokens,
        uiSessionId,
        (body as any).tools || [],
        writeEvent
      );

      await writeEvent(makeChunk(completionId, body.model, {}, parsed.finishReason, parsed.usage));
      await streamWriter.write('data: [DONE]\n\n');
    });
  } catch (err: any) {
    log.error('Error in chatCompletions', { error: err?.message || String(err) });
    const errMessage = err?.message || String(err);
    const { status, code } = mapErrorToStatus(errMessage);
    return c.json({ error: { message: errMessage, type: code, code } }, status as any);
  }
}
