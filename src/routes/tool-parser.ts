import { robustParseJSON } from '../utils/json.ts';

export const TOOL_START = '<tool_call>';
export const TOOL_END = '</tool_call>';
export const TOOL_OPEN_RE = /<tool_call\b[^>]*>/i;

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
    try {
      return JSON.parse(value);
    } catch {
      // fall through to string
    }
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
    return argKeys.every((k) => Object.prototype.hasOwnProperty.call(properties, k));
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

export function parseToolCallBlock(block: string, openTag: string, tools: any[]): any {
  const parsedXml = parseXmlParameterToolCall(block, openTag, tools);
  if (parsedXml) return parsedXml;

  const parsedJson = robustParseJSON(block);
  if (!parsedJson) throw new Error('Empty tool call');

  const attrToolName = extractToolName(openTag, block);
  if (attrToolName && !parsedJson.name) parsedJson.name = attrToolName;

  return parsedJson;
}

export function parseRecoverableToolCallBlock(block: string, openTag: string, tools: any[]): any {
  try {
    return parseToolCallBlock(block, openTag, tools);
  } catch {
    // fall through to recovery path
  }

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
}

export function findToolOpen(buffer: string): { startIdx: number; endIdx: number; openTag: string } | null {
  const match = buffer.match(TOOL_OPEN_RE);
  if (!match || match.index === undefined) return null;
  return {
    startIdx: match.index,
    endIdx: match.index + match[0].length,
    openTag: match[0],
  };
}

export function findPartialToolOpenIndex(buffer: string): number {
  const lower = buffer.toLowerCase();
  const idx = lower.lastIndexOf('<tool_call');
  if (idx !== -1 && lower.indexOf('>', idx) === -1) return idx;

  for (let i = 1; i < TOOL_START.length; i++) {
    if (lower.endsWith(TOOL_START.substring(0, i))) return buffer.length - i;
  }
  return -1;
}
