import { robustParseJSON } from '../utils/json.ts';
import { validateAgainstSchema } from '../tools/schema.ts';

export class ToolCallError extends Error {
  constructor() {
    super('The provider returned an invalid or incomplete tool call, or did not follow tool_choice.');
    this.name = 'ToolCallError';
  }
}

const DSML_PREFIX = '<｜｜DSML｜｜';
export function isDSMLTag(tag: string): boolean {
  return tag.toLowerCase().startsWith(DSML_PREFIX.toLowerCase());
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return match ? decodeXmlEntities(match[1]) : undefined;
}

/** Parse only complete DSML invokes; never repair a truncated command. */
export function parseDSMLToolCalls(block: string, openTag: string, tools: any[]): { calls: any[]; invalid: boolean } {
  const calls: any[] = [];
  let invalid = false;
  const parseInvoke = (tag: string, content: string) => {
    const name = attribute(tag, 'name');
    const tool = tools.find(t => t.function?.name === name);
    if (!name || !tool) throw new ToolCallError();
    const args: Record<string, unknown> = Object.create(null);
    const parameterRe = /(<｜｜DSML｜｜\s+parameter\b[^>]*>)([\s\S]*?)<\/｜｜DSML｜｜\s+parameter\s*>/gi;
    let end = 0;
    for (const match of content.matchAll(parameterRe)) {
      if (content.slice(end, match.index).trim()) throw new ToolCallError();
      const key = attribute(match[1], 'name');
      const stringFlag = attribute(match[1], 'string');
      if (!key || Object.hasOwn(args, key) || (stringFlag !== 'true' && stringFlag !== 'false')) throw new ToolCallError();
      if (/<\/?｜｜DSML｜｜\s+(?:parameter|invoke|calls)\b/i.test(match[2])) throw new ToolCallError();
      const raw = decodeXmlEntities(match[2]);
      args[key] = stringFlag === 'true' ? raw : JSON.parse(raw);
      end = match.index! + match[0].length;
    }
    if (content.slice(end).trim()) throw new ToolCallError();
    if (tool.function.parameters) validateAgainstSchema(args, tool.function.parameters);
    return { name, arguments: args };
  };
  if (/\s+invoke\b/i.test(openTag)) {
    return { calls: [parseInvoke(openTag, block)], invalid: false };
  }
  const invokeRe = /(<｜｜DSML｜｜\s+invoke\b[^>]*>)([\s\S]*?)<\/｜｜DSML｜｜\s+invoke\s*>/gi;
  let end = 0;
  for (const match of block.matchAll(invokeRe)) {
    if (block.slice(end, match.index).trim()) invalid = true;
    try { calls.push(parseInvoke(match[1], match[2])); } catch { invalid = true; }
    end = match.index! + match[0].length;
  }
  if (!end || block.slice(end).trim()) invalid = true;
  return { calls, invalid };
}

export const TOOL_START = '<tool_call>';
export const TOOL_END = '</tool_call>';
export const TOOL_OPEN_RE = /<tool_call\b[^>]*>|<｜｜DSML｜｜\s+(?:calls|invoke)\b[^>]*>/i;

export function toolEndTag(openTag: string): string {
  if (!isDSMLTag(openTag)) return TOOL_END;
  return /\s+calls\b/i.test(openTag) ? '</｜｜DSML｜｜ calls>' : '</｜｜DSML｜｜ invoke>';
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
  let hold = buffer.length;
  for (const prefix of ['<tool_call', DSML_PREFIX.toLowerCase()]) {
    const idx = lower.lastIndexOf(prefix);
    if (idx !== -1 && lower.indexOf('>', idx) === -1) hold = Math.min(hold, idx);
    for (let i = 1; i <= prefix.length; i++) {
      if (lower.endsWith(prefix.substring(0, i))) hold = Math.min(hold, buffer.length - i);
    }
  }
  return hold === buffer.length ? -1 : hold;
}
