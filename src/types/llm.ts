/**
 * LLM-Related Type Definitions
 *
 * Shared type definitions for LLM responses, usage, and message content.
 * These types complement the types from @mariozechner/pi-ai and provide
 * more specific typing for our use cases.
 */

/**
 * Token usage information from LLM responses
 */
export interface TokenUsage {
  /** Input tokens consumed */
  input?: number;
  /** Output tokens generated */
  output?: number;
  /** Cache read tokens (for prompt caching) */
  cacheRead?: number;
  /** Cache write tokens (for prompt caching) */
  cacheWrite?: number;
  /** Total tokens (may be provided by some providers) */
  totalTokens?: number;
}

/**
 * Text content block in a message
 */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

/**
 * Message content (can be a string or array of blocks)
 */
export type MessageContent = string | TextContentBlock[];

/**
 * Filter for text content blocks from a message content array
 */
export function isTextContentBlock(block: unknown): block is TextContentBlock {
  return (
    block !== null &&
    typeof block === 'object' &&
    (block as Record<string, unknown>)['type'] === 'text' &&
    typeof (block as Record<string, unknown>)['text'] === 'string'
  );
}

/**
 * Extract text from a message content block or string
 */
export function extractTextFromContent(content: MessageContent): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(isTextContentBlock)
      .map(block => block.text)
      .join('\n');
  }
  return '';
}

/**
 * Parse token usage from an unknown object
 * Returns a partial usage object with any fields that were present
 */
export function parseTokenUsage(usage: unknown): Partial<TokenUsage> {
  if (!usage || typeof usage !== 'object') {
    return {};
  }

  const obj = usage as Record<string, unknown>;
  const result: Partial<TokenUsage> = {};

  if (typeof obj['input'] === 'number') {
    result.input = obj['input'];
  }
  if (typeof obj['output'] === 'number') {
    result.output = obj['output'];
  }
  if (typeof obj['cacheRead'] === 'number') {
    result.cacheRead = obj['cacheRead'];
  }
  if (typeof obj['cacheWrite'] === 'number') {
    result.cacheWrite = obj['cacheWrite'];
  }
  if (typeof obj['totalTokens'] === 'number') {
    result.totalTokens = obj['totalTokens'];
  }

  return result;
}

/**
 * Calculate total tokens from usage object
 * Falls back to sum of individual components if totalTokens not provided
 */
export function calculateTotalTokens(usage: Partial<TokenUsage>): number {
  if (usage.totalTokens !== undefined) {
    return usage.totalTokens;
  }
  return (
    (usage.input ?? 0) +
    (usage.output ?? 0) +
    (usage.cacheRead ?? 0) +
    (usage.cacheWrite ?? 0)
  );
}
