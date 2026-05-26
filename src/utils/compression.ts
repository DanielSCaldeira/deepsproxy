import { Message } from './types.ts';
import { createLogger } from './logger.ts';

const log = createLogger('compression');

/**
 * Compresses the messages list to ensure the resulting serialized prompt length 
 * is strictly under targetLimit characters.
 */
export function compressMessages(
  messages: Message[],
  targetLimit: number,
  serializeFn: (msgs: Message[]) => { prompt: string; systemPrompt: string }
): Message[] {
  let serialized = serializeFn(messages);
  let totalLength = (serialized.systemPrompt ? serialized.systemPrompt.length + 1 : 0) + serialized.prompt.length;
  
  const compressionThreshold = Math.floor(targetLimit * 0.85);
  if (totalLength <= compressionThreshold) {
    return messages;
  }

  log.info('Compressing prompt', { totalLength, targetLimit });

  // Copy messages to avoid mutation
  let compressed = messages.map(msg => ({ ...msg }));

  // Strategy 1: Progressively remove older conversational history (excluding system prompt and the latest message)
  while (compressed.length > 2) {
    let indexToRemove = -1;
    for (let i = 0; i < compressed.length - 1; i++) {
      if (compressed[i].role !== 'system') {
        indexToRemove = i;
        break;
      }
    }

    if (indexToRemove === -1) {
      break; // Only system or last message left
    }

    compressed.splice(indexToRemove, 1);
    serialized = serializeFn(compressed);
    totalLength = (serialized.systemPrompt ? serialized.systemPrompt.length + 1 : 0) + serialized.prompt.length;

    if (totalLength <= targetLimit) {
      log.info('Compression succeeded by dropping older history', { newLength: totalLength });
      return compressed;
    }
  }

  // Strategy 2: Truncate individual message contents if still over limit
  for (let i = 0; i < compressed.length; i++) {
    const msg = compressed[i];
    if (msg.role !== 'system' && typeof msg.content === 'string' && msg.content.length > 500) {
      const excess = totalLength - targetLimit;
      const amountToKeep = Math.max(500, msg.content.length - excess - 100);
      if (amountToKeep < msg.content.length) {
        const truncatedContent = `[...TRUNCATED ${msg.content.length - amountToKeep} CHARACTERS TO FIT CONTEXT WINDOW...]\n` + msg.content.substring(msg.content.length - amountToKeep);
        compressed[i] = { ...msg, content: truncatedContent };
        
        serialized = serializeFn(compressed);
        totalLength = (serialized.systemPrompt ? serialized.systemPrompt.length + 1 : 0) + serialized.prompt.length;
        if (totalLength <= targetLimit) {
          log.info('Compression succeeded by truncating long message', { newLength: totalLength });
          return compressed;
        }
      }
    }
  }

  // Strategy 3: Extreme fallback - hard truncate of remaining long messages from beginning/end
  for (let i = 0; i < compressed.length; i++) {
    const msg = compressed[i];
    if (typeof msg.content === 'string' && msg.content.length > 100) {
      const excess = totalLength - targetLimit;
      const amountToKeep = Math.max(100, msg.content.length - excess - 50);
      if (amountToKeep < msg.content.length) {
        compressed[i] = { ...msg, content: msg.content.substring(0, amountToKeep) + '\n[...TRUNCATED...]' };
        serialized = serializeFn(compressed);
        totalLength = (serialized.systemPrompt ? serialized.systemPrompt.length + 1 : 0) + serialized.prompt.length;
        if (totalLength <= targetLimit) {
          break;
        }
      }
    }
  }

  log.info('Compression finished', { finalLength: totalLength });
  return compressed;
}
