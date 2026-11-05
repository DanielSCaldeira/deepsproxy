import { v4 as uuidv4 } from 'uuid';
import { decodeDeepSeekStream } from '../providers/deepseek.ts';
import type { ProviderEvent } from '../providers/types.ts';
import { ToolCall, Usage, ToolChoice } from '../utils/types.ts';
import { createLogger } from '../utils/logger.ts';
import {
  TOOL_START,
  toolEndTag,
  isDSMLTag,
  parseDSMLToolCalls,
  ToolCallError,
  findToolOpen,
  findPartialToolOpenIndex,
  parseRecoverableToolCallBlock,
} from './tool-parser.ts';

const log = createLogger('stream');

export type EmitChunk = (data: any) => Promise<void>;

export interface ParsedCompletion {
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: Usage;
}

function makeChoice(delta: any, finishReason: string | null = null) {
  return {
    index: 0,
    delta,
    logprobs: null,
    finish_reason: finishReason,
  };
}

export function makeChunk(
  completionId: string,
  model: string,
  delta: any,
  finishReason: string | null = null,
  usage?: Usage
) {
  const chunk: any = {
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [makeChoice(delta, finishReason)],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

export async function peekStream(
  stream: ReadableStream
): Promise<{ isEmpty: boolean; peekedStream: ReadableStream }> {
  const reader = stream.getReader();
  try {
    const { done, value } = await reader.read();
    if (done) {
      reader.releaseLock();
      return {
        isEmpty: true,
        peekedStream: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      };
    }

    const peekedStream = new ReadableStream({
      start(controller) { controller.enqueue(value); },
      async pull(controller) {
        try {
            const { done: nextDone, value: nextValue } = await reader.read();
            if (nextDone) {
              reader.releaseLock();
              controller.close();
              return;
            }
            controller.enqueue(nextValue);
        } catch (err) {
          reader.releaseLock();
          controller.error(err);
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); } finally { reader.releaseLock(); }
      },
    }, { highWaterMark: 0 });

    return { isEmpty: false, peekedStream };
  } catch (err) {
    reader.releaseLock();
    throw err;
  }
}

export async function parseProviderStreamToOpenAI(
  events: AsyncIterable<ProviderEvent>,
  completionId: string,
  model: string,
  promptTokens: number,
  tools: any[] = [],
  emit?: EmitChunk,
  toolChoice?: ToolChoice
): Promise<ParsedCompletion> {
  let reasoningContent = '';
  let content = '';
  let contentEmitBuffer = '';
  let insideTool = false;
  let currentToolOpenTag = TOOL_START;
  let emittedToolCallCount = 0;
  let completionTokens = 0;
  const toolCalls: ToolCall[] = [];
  let pendingToolLeadIn = '';
  let invalidToolCall = false;
  let emissionFailure: { error: unknown } | undefined;
  const emitSafe: EmitChunk = async data => {
    try { await emit?.(data); }
    catch (error) { emissionFailure = { error }; throw error; }
  };

  const emitContent = async (text: string) => {
    if (!text || emittedToolCallCount > 0) return;
    content += text;
    if (emit) await emitSafe(makeChunk(completionId, model, { content: text }));
  };

  const emitStructuredToolCall = async (toolCallObj: any) => {
    const toolName = toolCallObj.name || '';

    if (toolChoice === 'none' || (typeof toolChoice === 'object' && toolName !== toolChoice.function.name)) {
      invalidToolCall = true;
      throw new ToolCallError();
    }

    let toolArgs: Record<string, unknown> = {};
    if (toolCallObj.arguments && typeof toolCallObj.arguments === 'object') {
      toolArgs = toolCallObj.arguments;
    } else {
      const keys = Object.keys(toolCallObj).filter((k) => k !== 'name');
      for (const k of keys) toolArgs[k] = toolCallObj[k];
    }

    if (!toolName) throw new Error('Tool call missing name');

    const toolId = 'call_' + uuidv4();
    const toolCall: ToolCall = {
      index: emittedToolCallCount,
      id: toolId,
      type: 'function',
      function: { name: toolName, arguments: JSON.stringify(toolArgs) },
    };
    toolCalls.push(toolCall);
    if (emit) await emitSafe(makeChunk(completionId, model, { tool_calls: [toolCall] }));
    emittedToolCallCount++;
  };

  const emitToolCallFromBlock = async (toolBlock: string, openTag: string) => {
    if (isDSMLTag(openTag)) {
      const parsed = parseDSMLToolCalls(toolBlock, openTag, tools);
      invalidToolCall ||= parsed.invalid;
      for (const call of parsed.calls) {
        try { await emitStructuredToolCall(call); }
        catch (error) { if (emissionFailure?.error === error && emissionFailure) throw error; invalidToolCall = true; }
      }
    } else {
      await emitStructuredToolCall(parseRecoverableToolCallBlock(toolBlock, openTag, tools));
    }
  };

  for await (const event of events) {
    if (event.type === 'usage') { completionTokens = event.completionTokens; continue; }
    if (event.type === 'finish') continue;
    if (event.type === 'reasoning') {
      reasoningContent += event.text;
      if (emit) await emitSafe(makeChunk(completionId, model, { reasoning_content: event.text }));
      continue;
    }
    const vStr = event.text;
    contentEmitBuffer += vStr;

    while (contentEmitBuffer.length > 0) {
      if (!insideTool) {
        const toolOpen = findToolOpen(contentEmitBuffer);
        if (toolOpen) {
          pendingToolLeadIn += contentEmitBuffer.substring(0, toolOpen.startIdx);
          insideTool = true;
          currentToolOpenTag = toolOpen.openTag;
          contentEmitBuffer = contentEmitBuffer.substring(toolOpen.endIdx);
          continue;
        }

        const partialStartIdx = findPartialToolOpenIndex(contentEmitBuffer);
        const flushIndex = partialStartIdx === -1 ? contentEmitBuffer.length : partialStartIdx;

        const textToEmit = contentEmitBuffer.substring(0, flushIndex);
        await emitContent(textToEmit);
        contentEmitBuffer = contentEmitBuffer.substring(flushIndex);
        break;
      }

      const lowerBuffer = contentEmitBuffer.toLowerCase();
      const endTag = toolEndTag(currentToolOpenTag);
      const endIdx = lowerBuffer.indexOf(endTag.toLowerCase());
      if (endIdx === -1) break;

      const toolBlock = contentEmitBuffer.substring(0, endIdx).trim();
      try {
        await emitToolCallFromBlock(toolBlock, currentToolOpenTag);
        pendingToolLeadIn = '';
      } catch (e: any) {
        if (emissionFailure && emissionFailure.error === e) throw e;
        if (isDSMLTag(currentToolOpenTag) || e instanceof ToolCallError) invalidToolCall = true;
        log.warn('Dropping malformed tool call block', { error: e?.message || String(e) });
        if (emittedToolCallCount === 0 && pendingToolLeadIn.trim().length > 0) {
          await emitContent(pendingToolLeadIn);
        }
        pendingToolLeadIn = '';
      }

      insideTool = false;
      currentToolOpenTag = TOOL_START;
      contentEmitBuffer = contentEmitBuffer.substring(endIdx + endTag.length);
    }
  }

  if (insideTool && isDSMLTag(currentToolOpenTag)) {
    invalidToolCall = true;
  } else if (insideTool && contentEmitBuffer.trim().length > 0) {
    try {
      await emitToolCallFromBlock(contentEmitBuffer.trim(), currentToolOpenTag);
      pendingToolLeadIn = '';
    } catch (e: any) {
      if (emissionFailure && emissionFailure.error === e) throw e;
      log.warn('Dropping unclosed malformed tool call at end of stream', { error: e?.message || String(e) });
      if (emittedToolCallCount === 0 && pendingToolLeadIn.trim().length > 0) {
        await emitContent(pendingToolLeadIn);
      }
      pendingToolLeadIn = '';
    }
  }

  if (!insideTool && contentEmitBuffer.trimStart().startsWith('<｜')) {
    invalidToolCall = true;
  } else if (!insideTool && contentEmitBuffer.length > 0 && emittedToolCallCount === 0) {
    await emitContent(contentEmitBuffer);
  }

  if (emittedToolCallCount === 0 && (invalidToolCall || toolChoice === 'required' || typeof toolChoice === 'object')) {
    throw new ToolCallError();
  }

  const usage: Usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0 },
  };

  return {
    content,
    reasoningContent,
    toolCalls,
    finishReason: emittedToolCallCount > 0 ? 'tool_calls' : 'stop',
    usage,
  };
}

/** Compatibility entry point for existing DeepSeek consumers. */
export function parseDeepSeekStreamToOpenAI(
  stream: ReadableStream, completionId: string, model: string, promptTokens: number,
  uiSessionId: string, tools: any[] = [], emit?: EmitChunk, toolChoice?: ToolChoice
): Promise<ParsedCompletion> {
  return parseProviderStreamToOpenAI(decodeDeepSeekStream(stream, uiSessionId), completionId, model, promptTokens, tools, emit, toolChoice);
}
