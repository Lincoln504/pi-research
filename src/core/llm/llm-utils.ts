/**
 * LLM Utilities
 * 
 * Shared logic for safe and robust LLM interactions.
 */

import { type Model, type AssistantMessage, type SimpleStreamOptions, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import { extractText } from '../../utils/text-utils.ts';
import { logger } from '../../logger.ts';

/**
 * Standardize LLM request options for maximum compatibility and robustness.
 *
 * - Ensures maxTokens is always set (satisfies providers that reject a null cap),
 *   clamped to the model's own ceiling so a large requested cap is never invalid.
 * - Sets the chain-of-thought "thinking" level, defaulting to 'off'. This is passed
 *   straight to pi-ai, which clamps it to whatever the specific model/provider
 *   supports (disabling thinking where an off state exists, omitting the parameter
 *   where it does not). The fix is therefore model-agnostic — pi-ai owns the
 *   per-provider translation; this code never hardcodes a provider-specific payload.
 *   'off' is deliberate: these engine calls emit structured JSON / cited reports, so a
 *   thinking block only consumes the output-token budget (often truncating before the
 *   text block is emitted) for at most a marginal quality gain that does not justify the cost.
 *
 * @param model - The model being called
 * @param options - Caller-provided options (an explicit `reasoning` here wins)
 * @param defaultCap - Default maxTokens cap (clamped to model.maxTokens)
 * @param thinkingLevel - Thinking level to request when the caller did not set one (default 'off')
 * @returns Fully populated SimpleStreamOptions
 */
export function buildSafeOptions(
  model: Model<any>,
  options: SimpleStreamOptions,
  defaultCap: number = 4096,
  thinkingLevel: ModelThinkingLevel = 'off'
): SimpleStreamOptions {
  const effective: ModelThinkingLevel = (options.reasoning as ModelThinkingLevel | undefined) ?? thinkingLevel;
  return {
    ...options,
    // Ensure maxTokens is never null/None to avoid provider-side crashes
    maxTokens: options.maxTokens ?? Math.min(defaultCap, model.maxTokens || defaultCap),
    // 'off' is a valid ModelThinkingLevel that pi-ai accepts at runtime even though the
    // public SimpleStreamOptions.reasoning type narrows to the non-off ThinkingLevel.
    reasoning: effective as unknown as SimpleStreamOptions['reasoning'],
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
