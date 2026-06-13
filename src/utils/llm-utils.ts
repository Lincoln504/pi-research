/**
 * LLM Utilities
 * 
 * Shared logic for safe and robust LLM interactions.
 */

import { type Model, type AssistantMessage, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { extractText } from './text-utils.ts';
import { logger } from '../logger.ts';

/**
 * Standardize LLM request options for maximum compatibility and robustness.
 * 
 * - Ensures maxTokens is always set (satisfies GLM/BigModel and O1 requirements).
 * - Defaults to 'minimal' reasoning if supported by the model.
 * - Caps maxTokens to a safe default if not explicitly provided.
 * 
 * @param model - The model being called
 * @param options - User-provided options
 * @param defaultCap - Default maxTokens cap (default 4096)
 * @returns Fully populated SimpleStreamOptions
 */
export function buildSafeOptions(
  model: Model<any>,
  options: SimpleStreamOptions,
  defaultCap: number = 4096
): SimpleStreamOptions {
  return {
    ...options,
    // Ensure maxTokens is never null/None to avoid provider-side crashes
    maxTokens: options.maxTokens ?? Math.min(defaultCap, model.maxTokens || defaultCap),
    // Default to 'minimal' reasoning for better planning/logic if supported,
    // but allow the caller to explicitly override it.
    reasoning: options.reasoning ?? ('minimal' as any),
  };
}

/**
 * Validate an LLM response and extract its text content.
 * 
 * - Checks for explicit provider errors (Rate Limits, etc.).
 * - Maps known error codes (like 1310) to readable messages.
 * - Extracts text using robust multi-block support.
 * 
 * @param response - The AssistantMessage from completeSimple
 * @param label - Label for error reporting (e.g. 'Coordinator')
 * @returns Extracted text content
 * @throws Error if the response indicates a failure or has no text
 */
export function validateAndExtractText(response: AssistantMessage, label: string): string {
  // NOTE: never use console.log here — this runs inside the TUI render loop and
  // any direct stdout write corrupts the rendered panel. Use the logger (file) instead.
  // 1. Check for explicit provider errors or empty response
  if (response.stopReason === 'error' || response.errorMessage) {
    const errorMsg = response.errorMessage || 'Unknown provider error';
    logger.error(`[${label}] LLM call failed: ${errorMsg}`);
    
    // Map specific provider codes
    // 1310 is a common rate limit code for DeepSeek/Zhipu-based providers
    if (errorMsg.toLowerCase().includes('limit exhausted') || errorMsg.includes('1310')) {
      throw new Error(`${label} failed: API Rate Limit Exhausted. Please check your provider account or try a different model.`);
    }
    
    // Handle 500 [object Object] cases by ensuring we show something readable
    const cleanMsg = typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg);
    throw new Error(`${label} failed: ${cleanMsg}`);
  }

  // 2. Extract text content
  const text = extractText(response);
  if (!text || !text.trim()) {
    throw new Error(`${label} returned no text content from LLM. Raw response: ${JSON.stringify(response, null, 2)}`);
  }

  return text;
}
