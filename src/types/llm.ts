/**
 * LLM-Related Type Definitions
 *
 * Shared type definitions for LLM responses, usage, and message content.
 * These types complement the types from @earendil-works/pi-ai and provide
 * more specific typing for our use cases.
 */

import { calculateCost, type Model } from '@earendil-works/pi-ai';

/**
 * Token usage and cost information from LLM responses
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
  /** Cost details */
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/**
 * Text content block
 */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

/**
 * Thinking/Reasoning content block
 */
export interface ThinkingContentBlock {
  type: 'thinking';
  content: string;
}

/**
 * Tool call block
 */
export interface ToolCallBlock {
  type: 'tool_call';
  id?: string;
  name: string;
  arguments: any;
}

/**
 * Message content block
 */
export type MessageBlock = TextContentBlock | ThinkingContentBlock | ToolCallBlock;

/**
 * Message content (can be a string or array of blocks)
 */
export type MessageContent = string | MessageBlock[];


/**
 * Parse token usage from an unknown object
 * Returns a partial usage object with any fields that were present
 */
function parseTokenUsage(usage: unknown): Partial<TokenUsage> {
  if (!usage || typeof usage !== 'object') {
    return {};
  }

  const obj = usage as Record<string, any>;
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
  if (obj['cost'] && typeof obj['cost'] === 'object') {
    result.cost = obj['cost'];
  }

  return result;
}

/**
 * Calculate total tokens from usage object
 * Falls back to sum of individual components if totalTokens not provided
 */
function calculateTotalTokens(usage: Partial<TokenUsage>): number {
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

/**
 * Extract usage (tokens and cost) from a raw LLM usage object.
 * Handles both provided cost and estimated cost via calculateCost.
 * 
 * @param model - The model used for the call (for cost estimation)
 * @param rawUsage - The raw usage object from the LLM response
 */
export function extractUsage(model: Model<any>, rawUsage: any): { tokens: number; cost: number; parsed: Partial<TokenUsage> } {
  if (!rawUsage) {
    return { tokens: 0, cost: 0, parsed: {} };
  }

  const parsed = parseTokenUsage(rawUsage);
  const tokens = calculateTotalTokens(parsed);

  // Ultra-accurate cost calculation
  let cost = parsed.cost?.total ?? rawUsage.cost?.total ?? 0;
  if (cost === 0 && tokens > 0) {
    try {
      const calculatedCost = calculateCost(model, rawUsage);
      cost = calculatedCost.total;
    } catch {
      // Best-effort cost calculation; if calculateCost fails (e.g. model not in registry), keep 0.
    }
  }

  return { tokens, cost, parsed };
}

