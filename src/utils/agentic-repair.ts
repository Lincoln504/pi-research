/**
 * Agentic JSON Repair Utility
 *
 * Provides mechanisms to salvage information from malformed JSON responses
 * using an LLM-based correction pass.
 */

import { logger } from '../logger.ts';
import { extractJson } from './json-utils.ts';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';

/**
 * Options for JSON repair
 */
export interface JsonRepairOptions {
  /** The model to use for the repair pass */
  model: any;
  /** Original user prompt or context for the repair */
  context?: string;
  /** Optional schema for validation after repair */
  schema?: TSchema;
  /** Service name for logging */
  serviceName?: string;
  /** Abort signal */
  signal?: AbortSignal;
}

/**
 * LLM completion function signature matching pi-ai's completeSimple
 */
export type LlmCompleter = (
  model: any,
  context: { systemPrompt?: string; messages: any[] },
  options: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<any>;

/**
 * Repair malformed JSON using an LLM-based correction pass
 *
 * @param text - The malformed text containing JSON
 * @param completer - Function to call the LLM
 * @param auth - Auth credentials
 * @param options - Repair options
 * @returns Salaged object or null if repair fails
 */
export async function repairJsonWithLlm<T = any>(
  text: string,
  completer: LlmCompleter,
  auth: { apiKey: string; headers?: Record<string, string> },
  options: JsonRepairOptions
): Promise<T | null> {
  const { model, context, schema, serviceName = 'RepairService', signal } = options;
  
  logger.warn(`[${serviceName}] JSON parse failed; attempting agentic salvage`);

  // Build a highly specific repair prompt that leverages schema if available
  let repairPrompt = `I attempted to parse a JSON response but it contains formation errors, syntax issues, or is incomplete (truncated).
Your task is to repair the JSON so it is perfectly valid while preserving all the intended data.

`;
  
  if (context) {
    repairPrompt += `CONTEXT (what was requested):\n${context}\n\n`;
  }
  
  repairPrompt += `MALFORMED RESPONSE:\n---\n${text}\n---\n\n`;
  
  if (schema) {
    repairPrompt += `The result MUST strictly follow this JSON Schema:\n${JSON.stringify(schema, null, 2)}\n\n`;
    repairPrompt += `Ensure all required fields are present. If data for a field is missing, use a sensible default (empty string, empty array, or null).\n\n`;
  }
  
  repairPrompt += `TASK: Fix any JSON formation errors (missing braces, trailing commas, malformed quotes, truncation, etc.) in the response above.
If the response was truncated, do your best to salvage as much data as possible into a valid structure.
Return ONLY the valid JSON object. No prose before or after.`;

  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        logger.debug(`[${serviceName}] Salvage attempt ${attempt}/${maxAttempts}...`);
      }

      const response = await completer(model, {
        messages: [{ role: 'user', content: [{ type: 'text', text: repairPrompt }], timestamp: Date.now() }]
      }, { ...auth, signal });

      const responseText = response.content.find((c: any) => c.type === 'text')?.text;
      if (!responseText) {
        logger.warn(`[${serviceName}] Salvage attempt ${attempt} failed: empty LLM response`);
        continue;
      }

      const extracted = extractJson<T>(responseText, 'any');
      if (!extracted.success || !extracted.value) {
        logger.warn(`[${serviceName}] Salvage attempt ${attempt} failed: output still invalid JSON: ${extracted.error}`);
        continue;
      }

      const salvaged = extracted.value;

      // Optional validation
      if (schema) {
        const coerced = Value.Convert(schema, salvaged);
        if (!Value.Check(schema, coerced)) {
          const errors = [...Value.Errors(schema, coerced)];
          const errorDetail = errors.map((e: any) => `${e.path}: ${e.message}`).join(', ');
          logger.warn(`[${serviceName}] Salvage attempt ${attempt} succeeded but validation failed: ${errorDetail}`);
          
          if (attempt < maxAttempts) {
            // Modify prompt for retry to include the errors
            repairPrompt += `\n\nYour previous attempt failed validation with these errors: ${errorDetail}. Please fix them.`;
            continue;
          }
          
          // On last attempt, we still return null if it's invalid according to schema
          logger.error(`[${serviceName}] Salvage failed: final attempt still invalid according to schema`);
          return null;
        }
        return coerced as T;
      }

      return salvaged;
    } catch (err) {
      logger.error(`[${serviceName}] Salvage attempt ${attempt} unexpected error:`, err);
      if (attempt >= maxAttempts) break;
    }
  }

  return null;
}
