/**
 * LLM Utilities
 * 
 * Shared logic for safe and robust LLM interactions.
 */

import { type Model, type AssistantMessage, type SimpleStreamOptions, type ModelThinkingLevel, type Tool, type TSchema, type Context, type ToolCall } from '@earendil-works/pi-ai';
import { extractText } from '../../utils/text-utils.ts';
import { logger } from '../../logger.ts';
import { completeSimple } from './pi-ai-completion.ts';

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
 * Callers should also pass the research `sessionId` in `options`. pi-ai forwards it as the
 * provider's prompt-cache / session-affinity key — OpenAI's `prompt_cache_key`, OpenRouter's
 * `x-session-id` — which keeps a run's calls on the replica that warmed their cache. Without
 * it OpenRouter falls back to hashing the first system and user messages, which every round
 * of a research run mutates, so it re-routes and re-warms. Providers that do not implement
 * session affinity ignore the field, so passing it is unconditionally safe.
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
  assertNoLlmError(response, label);

  // 2. Extract text content
  const text = extractText(response);
  if (!text || !text.trim()) {
    throw new Error(`${label} returned no text content from LLM. Raw response: ${JSON.stringify(response, null, 2)}`);
  }

  return text;
}

/**
 * Throw a readable error when a response carries a provider/transport failure.
 *
 * Factored out of validateAndExtractText so the structured-completion path below
 * shares the exact same error mapping without requiring text content.
 */
function assertNoLlmError(response: AssistantMessage, label: string): void {
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
}

/**
 * Build a submit tool whose arguments pi-ai can schema-constrain where the
 * provider supports it (OpenAI/Anthropic/Bedrock/Mistral/Gemini 3 strict
 * json_schema; grammar tools on GPT-5+ endpoints) and that degrades to a plain
 * tool call everywhere else — never worse than an unconstrained call.
 *
 * `strict: 'prefer'` is deliberate over 'require': a custom OpenAI-compatible
 * endpoint (vLLM, llama.cpp, gateways) must keep working — it simply gets a
 * normal function tool whose arguments our own validation still checks.
 */
export function buildConstrainedSubmitTool(name: string, description: string, parameters: TSchema): Tool {
  return {
    name,
    description,
    parameters,
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
  };
}

/**
 * Result of a structured completion: the model either called the submit tool
 * (args already parsed by pi-ai) or answered in text (fallback path).
 */
export type StructuredCompletion =
  | { kind: 'toolCall'; toolName: string; args: Record<string, any>; response: AssistantMessage }
  | { kind: 'text'; text: string; response: AssistantMessage };

/**
 * completeSimple, but with a submit tool offered for structured output.
 *
 * toolChoice stays 'auto' (pi-ai's ToolChoice has no forced-tool mode): the
 * model is INSTRUCTED to call the tool by the prompt; a text answer is
 * returned as { kind: 'text' } and flows into the caller's existing
 * parse/repair pipeline unchanged. Constrained sampling (see
 * buildConstrainedSubmitTool) makes the tool-call path schema-exact where the
 * provider supports it — the fallback is exactly today's behavior.
 *
 * Errors map identically to validateAndExtractText (shared assertNoLlmError).
 */
export async function completeSimpleStructured(
  model: Model<any>,
  context: Pick<Context, 'systemPrompt' | 'messages'>,
  tool: Tool,
  options: SimpleStreamOptions,
  label: string,
): Promise<StructuredCompletion> {
  const response = await completeSimple(
    model,
    { ...context, tools: [tool] },
    { ...options, toolChoice: 'auto' },
  );

  assertNoLlmError(response, label);

  // Tool calls arrive as content blocks on the AssistantMessage, not a
  // dedicated field — match the submit tool by name so an off-spec model call
  // to some other (nonexistent) tool is not mistaken for structured output.
  const call = response.content.find(
    (block): block is ToolCall => (block as ToolCall).type === 'toolCall' && (block as ToolCall).name === tool.name,
  );
  if (call) {
    return { kind: 'toolCall', toolName: call.name, args: call.arguments ?? {}, response };
  }

  const text = extractText(response);
  if (!text || !text.trim()) {
    throw new Error(
      `${label} returned neither a ${tool.name} tool call nor text content. Raw response: ${JSON.stringify(response, null, 2)}`,
    );
  }
  return { kind: 'text', text, response };
}
