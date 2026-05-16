/*
 * File: chat.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 *
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createDeepSeekStream, updateSessionParent } from '../services/deepseek.ts';
import { OpenAIRequest, ChoiceDelta, Message, ToolCall, Usage } from '../utils/types.ts';
import { robustParseJSON } from '../utils/json.ts';

const TOOL_START = '<tool_call>';
const TOOL_END = '</tool_call>';
const TOOL_OPEN_RE = /<tool_call\b[^>]*>/i;

type EmitChunk = (data: any) => Promise<void>;

interface ParsedCompletion {
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: Usage;
}

function messageContentToString(content: any): string {
  if (Array.isArray(content)) {
    return content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
  }
  if (typeof content === 'object' && content !== null) {
    return JSON.stringify(content);
  }
  return content || '';
}

function serializeOpenAIMessages(messages: Message[]) {
  let prompt = '';
  let systemPrompt = '';

  for (const msg of messages) {
    const contentStr = messageContentToString(msg.content);

    if (msg.role === 'system') {
      systemPrompt += contentStr + '\n\n';
      continue;
    }

    if (msg.role === 'user') {
      prompt += `User: ${contentStr}\n\n`;
      continue;
    }

    if (msg.role === 'assistant') {
      let assistantContent = contentStr;
      if ((msg as any).reasoning_content) {
        assistantContent = `<think>\n${(msg as any).reasoning_content}\n</think>\n${assistantContent}`;
      }
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let args = tc.function?.arguments || '{}';
          if (typeof args !== 'string') args = JSON.stringify(args);
          assistantContent += `\n<tool_call>{"name": "${tc.function?.name}", "arguments": ${args}}</tool_call>`;
        }
      }
      prompt += `Assistant: ${assistantContent.trim()}\n\n`;
      continue;
    }

    if (msg.role === 'tool' || msg.role === 'function') {
      prompt += `Tool Response (${msg.name || msg.tool_call_id || 'tool'}): ${contentStr}\n\n`;
      continue;
    }

    prompt += `${msg.role}: ${contentStr}\n\n`;
  }

  return { prompt, systemPrompt };
}

function appendToolInstructions(systemPrompt: string, body: OpenAIRequest): string {
  const bodyAny = body as any;
  if (!bodyAny.tools || !Array.isArray(bodyAny.tools) || bodyAny.tools.length === 0) {
    return systemPrompt;
  }

  const formattedTools = bodyAny.tools.map((t: any) => {
    if (t.type === 'function') {
      return {
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters
      };
    }
    return t;
  });
  const toolsJson = JSON.stringify(formattedTools, null, 2);

  systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nRULES:\n1. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n2. Do NOT output any other text after your <tool_call> blocks. Wait for the user to provide the tool response.\n3. The JSON must be valid and accurately follow the tool's parameters.\n\n`;

  if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
    const forcedTool = bodyAny.tool_choice.function.name;
    systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
  }

  return systemPrompt;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function coerceParameterValue(rawValue: string): unknown {
  const value = decodeXmlEntities(rawValue.trim());
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try { return JSON.parse(value); } catch {}
  }
  return value;
}

function extractToolName(openTag: string, block: string): string {
  const combined = `${openTag}\n${block}`;
  const attrMatch = combined.match(/<tool_call\b[^>]*\bname\s*=\s*["']([^"']+)["']/i);
  if (attrMatch) return attrMatch[1];

  const nameTagMatch = block.match(/<name>([\s\S]*?)<\/name>/i);
  if (nameTagMatch) return decodeXmlEntities(nameTagMatch[1].trim());

  return '';
}

function inferToolNameFromParameters(args: Record<string, unknown>, tools: any[]): string {
  const argKeys = Object.keys(args);
  if (argKeys.length === 0 || !Array.isArray(tools)) return '';

  const matches = tools.filter((tool: any) => {
    const fn = tool?.type === 'function' ? tool.function : tool?.function;
    const properties = fn?.parameters?.properties || {};
    return argKeys.every(k => Object.prototype.hasOwnProperty.call(properties, k));
  });

  if (matches.length === 1) {
    const fn = matches[0]?.type === 'function' ? matches[0].function : matches[0]?.function;
    return fn?.name || '';
  }

  return '';
}

function parseXmlParameterToolCall(block: string, openTag: string, tools: any[]): any | null {
  const args: Record<string, unknown> = {};
  const parameterRe = /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  while ((match = parameterRe.exec(block)) !== null) {
    args[match[1]] = coerceParameterValue(match[2]);
  }

  if (Object.keys(args).length === 0) return null;

  const toolName = extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
  if (!toolName) return null;

  return { name: toolName, arguments: args };
}

function parseToolCallBlock(block: string, openTag: string, tools: any[]): any {
  const parsedXml = parseXmlParameterToolCall(block, openTag, tools);
  if (parsedXml) return parsedXml;

  const parsedJson = robustParseJSON(block);
  if (!parsedJson) throw new Error('Empty tool call');

  const attrToolName = extractToolName(openTag, block);
  if (attrToolName && !parsedJson.name) parsedJson.name = attrToolName;

  return parsedJson;
}

function findToolOpen(buffer: string): { startIdx: number; endIdx: number; openTag: string } | null {
  const match = buffer.match(TOOL_OPEN_RE);
  if (!match || match.index === undefined) return null;
  return {
    startIdx: match.index,
    endIdx: match.index + match[0].length,
    openTag: match[0]
  };
}

function findPartialToolOpenIndex(buffer: string): number {
  const lower = buffer.toLowerCase();
  const idx = lower.lastIndexOf('<tool_call');
  if (idx !== -1 && lower.indexOf('>', idx) === -1) return idx;

  for (let i = 1; i < TOOL_START.length; i++) {
    if (lower.endsWith(TOOL_START.substring(0, i))) return buffer.length - i;
  }
  return -1;
}

function makeChoice(delta: any, finishReason: string | null = null) {
  return {
    index: 0,
    delta,
    logprobs: null,
    finish_reason: finishReason
  };
}

function makeChunk(completionId: string, model: string, delta: any, finishReason: string | null = null, usage?: Usage) {
  const chunk: any = {
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [makeChoice(delta, finishReason)]
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

async function parseDeepSeekStreamToOpenAI(
  deepSeekStream: ReadableStream,
  completionId: string,
  model: string,
  promptTokens: number,
  uiSessionId: string,
  tools: any[] = [],
  emit?: EmitChunk
): Promise<ParsedCompletion> {
  const reader = deepSeekStream.getReader();
  const decoder = new TextDecoder();

  let currentAppendPath = '';
  let currentFragmentType = '';
  let reasoningContent = '';
  let content = '';
  let contentEmitBuffer = '';
  let insideTool = false;
  let currentToolOpenTag = TOOL_START;
  let emittedToolCallCount = 0;
  let completionTokens = 0;
  const toolCalls: ToolCall[] = [];
  let buffer = '';
  let pendingToolLeadIn = '';

  const emitContent = async (text: string) => {
    if (!text || emittedToolCallCount > 0) return;
    content += text;
    if (emit) await emit(makeChunk(completionId, model, { content: text }));
  };

  const parseRecoverableToolCallBlock = (block: string, openTag: string): any => {
    try {
      return parseToolCallBlock(block, openTag, tools);
    } catch {}

    const args: Record<string, unknown> = {};
    const closedParameterRe = /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
    let match: RegExpExecArray | null;
    let lastClosedEnd = 0;
    while ((match = closedParameterRe.exec(block)) !== null) {
      args[match[1]] = coerceParameterValue(match[2]);
      lastClosedEnd = closedParameterRe.lastIndex;
    }

    const tail = block.substring(lastClosedEnd);
    const unclosedParameterMatch = tail.match(/<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*)$/i);
    if (unclosedParameterMatch) {
      args[unclosedParameterMatch[1]] = coerceParameterValue(unclosedParameterMatch[2]);
    }

    if (Object.keys(args).length === 0) throw new Error('Unrecoverable tool call');
    const toolName = extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
    if (!toolName) throw new Error('Recoverable tool call missing name');
    return { name: toolName, arguments: args };
  };

  const emitToolCallFromBlock = async (toolBlock: string, openTag: string) => {
    const toolCallObj = parseRecoverableToolCallBlock(toolBlock, openTag);
    const toolName = toolCallObj.name || '';

    let toolArgs: Record<string, unknown> = {};
    if (toolCallObj.arguments && typeof toolCallObj.arguments === 'object') {
      toolArgs = toolCallObj.arguments;
    } else {
      const keys = Object.keys(toolCallObj).filter(k => k !== 'name');
      for (const k of keys) toolArgs[k] = toolCallObj[k];
    }

    if (!toolName) throw new Error('Tool call missing name');

    const toolId = 'call_' + uuidv4();
    const toolCall: ToolCall = {
      index: emittedToolCallCount,
      id: toolId,
      type: 'function',
      function: { name: toolName, arguments: JSON.stringify(toolArgs) }
    };
    toolCalls.push(toolCall);
    if (emit) await emit(makeChunk(completionId, model, { tool_calls: [toolCall] }));
    emittedToolCallCount++;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const dataStr = trimmed.slice(6);
      if (dataStr === '[DONE]') continue;

      try {
        const chunk = JSON.parse(dataStr);
        let dsMessageId: any = null;
        if (chunk.response_message_id) {
          dsMessageId = chunk.response_message_id;
        } else if (chunk.v && typeof chunk.v === 'object') {
          if (chunk.v.response && chunk.v.response.message_id) {
            dsMessageId = chunk.v.response.message_id;
          } else if (chunk.v.message_id) {
            dsMessageId = chunk.v.message_id;
          }
        } else if (chunk.message_id) {
          dsMessageId = chunk.message_id;
        }

        if (dsMessageId) updateSessionParent(uiSessionId, dsMessageId);

        let vStr = '';
        let foundStr = false;
        let isThinkingChunk = false;

        if (typeof chunk.p === 'string') {
          currentAppendPath = chunk.p;
          if (chunk.p === 'response/accumulated_token_usage' && typeof chunk.v === 'number') {
            completionTokens = chunk.v;
          }
        }

        if (typeof chunk.v === 'string') {
          vStr = chunk.v;
          foundStr = true;
        } else if (chunk.v && typeof chunk.v === 'object') {
          if (chunk.v.response && chunk.v.response.fragments && chunk.v.response.fragments.length > 0) {
            const frag = chunk.v.response.fragments[0];
            if (typeof frag.content === 'string') {
              vStr = frag.content;
              foundStr = true;
              currentAppendPath = frag.type === 'THINK' ? 'response/thinking_content' : 'response/content';
              currentFragmentType = frag.type || '';
            }
          } else if (Array.isArray(chunk.v) && chunk.v.length > 0) {
            const firstObj = chunk.v[0];
            if (typeof firstObj.content === 'string') {
              vStr = firstObj.content;
              foundStr = true;
              currentAppendPath = firstObj.type === 'THINK' ? 'response/thinking_content' : 'response/content';
              currentFragmentType = firstObj.type || '';
            }
          }
        }

        if (chunk.p === 'response/fragments' && Array.isArray(chunk.v)) {
          const lastFrag = chunk.v[chunk.v.length - 1];
          if (lastFrag && lastFrag.type) currentFragmentType = lastFrag.type;
        }

        if (currentAppendPath.includes('thinking_content') ||
            currentAppendPath.includes('THINK') ||
            (currentAppendPath.includes('fragments/-1/content') && currentFragmentType === 'THINK')) {
          isThinkingChunk = true;
        }

        if (!foundStr || vStr === '' || vStr === 'FINISHED') continue;

        if (isThinkingChunk) {
          reasoningContent += vStr;
          const delta: ChoiceDelta = { reasoning_content: vStr };
          if (emit) await emit(makeChunk(completionId, model, delta));
          continue;
        }

        contentEmitBuffer += vStr;

        while (contentEmitBuffer.length > 0) {
          if (!insideTool) {
            const toolOpen = findToolOpen(contentEmitBuffer);
            if (toolOpen) {
              // Once a tool call appears, do not emit the lead-in text as
              // assistant content. OpenAI-compatible clients expect the whole
              // assistant turn to be a structured tool_calls message.
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
          const endIdx = lowerBuffer.indexOf(TOOL_END);
          if (endIdx === -1) break;

          const toolBlock = contentEmitBuffer.substring(0, endIdx).trim();
          try {
            await emitToolCallFromBlock(toolBlock, currentToolOpenTag);
            pendingToolLeadIn = '';
          } catch (e) {
            // Never leak internal tool-call XML to the user-visible content.
            // If the call cannot be parsed, restore any normal text that came
            // before it so the OpenAI response is not silently empty.
            console.warn('[chat] Dropping malformed tool call block:', e);
            if (emittedToolCallCount === 0 && pendingToolLeadIn.trim().length > 0) {
              await emitContent(pendingToolLeadIn);
            }
            pendingToolLeadIn = '';
          }

          insideTool = false;
          currentToolOpenTag = TOOL_START;
          contentEmitBuffer = contentEmitBuffer.substring(endIdx + TOOL_END.length);
        }
      } catch (e) {
        // Ignore partial or malformed DeepSeek chunks.
      }
    }
  }

  if (insideTool && contentEmitBuffer.trim().length > 0) {
    try {
      await emitToolCallFromBlock(contentEmitBuffer.trim(), currentToolOpenTag);
      pendingToolLeadIn = '';
    } catch (e) {
      console.warn('[chat] Dropping unclosed malformed tool call at end of stream:', e);
      if (emittedToolCallCount === 0 && pendingToolLeadIn.trim().length > 0) {
        await emitContent(pendingToolLeadIn);
      }
      pendingToolLeadIn = '';
    }
  }

  if (!insideTool && contentEmitBuffer.length > 0 && emittedToolCallCount === 0) {
    await emitContent(contentEmitBuffer);
  }

  const usage: Usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0 }
  };

  return {
    content,
    reasoningContent,
    toolCalls,
    finishReason: emittedToolCallCount > 0 ? 'tool_calls' : 'stop',
    usage
  };
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    const messages = body.messages || [];

    const serialized = serializeOpenAIMessages(messages);
    const systemPrompt = appendToolInstructions(serialized.systemPrompt, body);
    const finalPrompt = systemPrompt ? `${systemPrompt}\n${serialized.prompt}` : serialized.prompt;

    const isThinkingModel = body.model.includes('thinking');
    const isProModel = body.model.includes('pro');
    const isNewSession = !messages.some(m => m.role === 'assistant');

    let deepSeekStream: ReadableStream;
    let uiSessionId = '';
    let retries = 3;
    while (retries > 0) {
      try {
        // OpenAI chat/completions requests are self-contained: the caller sends
        // the full message history every time. Always start a fresh DeepSeek
        // browser turn so DeepSeek's stateful parent_message_id cannot drift
        // from compressed/edited OpenAI histories and produce empty replies.
        const result = await createDeepSeekStream(finalPrompt, isThinkingModel, isProModel, null);
        deepSeekStream = result.stream;
        uiSessionId = result.uiSessionId;
        break;
      } catch (err: any) {
        retries--;
        if (retries === 0) throw err;
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    const completionId = 'chatcmpl-' + uuidv4();
    const promptTokens = Math.ceil(finalPrompt.length / 3.5);

    if (!isStream) {
      const parsed = await parseDeepSeekStreamToOpenAI(
        deepSeekStream!,
        completionId,
        body.model,
        promptTokens,
        uiSessionId,
        (body as any).tools || []
      );

      const message: any = {
        role: 'assistant',
        content: parsed.toolCalls.length > 0 ? null : parsed.content
      };
      if (parsed.reasoningContent) message.reasoning_content = parsed.reasoningContent;
      if (parsed.toolCalls.length > 0) message.tool_calls = parsed.toolCalls;

      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message,
          logprobs: null,
          finish_reason: parsed.finishReason
        }],
        usage: parsed.usage
      });
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return honoStream(c, async (streamWriter: any) => {
      const writeEvent = async (data: any) => {
        await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      await writeEvent(makeChunk(completionId, body.model, { role: 'assistant', content: '' }));

      const parsed = await parseDeepSeekStreamToOpenAI(
        deepSeekStream!,
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
    console.error('Error in chatCompletions:', err);
    return c.json({ error: { message: err.message } }, 500);
  }
}
