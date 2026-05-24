/**
 * Planning LLM Helper
 *
 * Handles LLM interactions for planning service.
 */

import { complete, type TextContent } from '@mariozechner/pi-ai';
import { extractJson } from '../utils/json-utils.ts';
import { injectCurrentDate } from '../utils/inject-date.ts';
import { loadPrompt } from '../utils/prompts.ts';
import type { LLMResponseMetadata } from '../types/index.ts';
import { parseTokenUsage, calculateTotalTokens } from '../types/llm.ts';
import type { ResearchPlan, GeneratePlanOptions, GenerateQueriesOptions, UpdatePlanOptions } from './service-interfaces.ts';

/**
 * LLM response with metadata
 */
export interface LLMResponse {
  content: string;
  metadata: LLMResponseMetadata;
}

/**
 * Generate a plan using LLM
 */
export async function generatePlanWithLLM(options: GeneratePlanOptions, _ctx?: any): Promise<{ plan: ResearchPlan; metadata: LLMResponseMetadata }> {
  const coordinatorPrompt = await loadPrompt('coordinator');
  const injectedPrompt = injectCurrentDate(coordinatorPrompt, 'coordinator');

  const response = await complete(options.model, {
    systemPrompt: injectedPrompt,
    messages: [
      { role: 'user', content: [{ type: 'text', text: options.query }] as TextContent[], timestamp: Date.now() },
    ],
  }, { signal: options.signal });

  const metadata = response as unknown as LLMResponseMetadata;

  return {
    plan: response.content.find(c => c.type === 'text')?.type === 'text' ? (response.content.find(c => c.type === 'text') as any).text : response.content as any,
    metadata,
  };
}

/**
 * Generate queries using LLM
 */
export async function generateQueriesWithLLM(options: GenerateQueriesOptions, _ctx?: any): Promise<{ queries: string[]; metadata: LLMResponseMetadata }> {
  const researcherPrompt = await loadPrompt('researcher');
  const injectedPrompt = injectCurrentDate(researcherPrompt, 'researcher');

  const response = await complete(options.model, {
    systemPrompt: injectedPrompt,
    messages: [
      { role: 'user', content: [{ type: 'text', text: options.query }] as TextContent[], timestamp: Date.now() },
    ],
  }, { signal: options.signal });

  const metadata = response as unknown as LLMResponseMetadata;

  return {
    queries: (response.content as any).filter((c: any) => c.type === 'text').map((c: any) => c.text),
    metadata,
  };
}

/**
 * Update plan for next round using LLM
 */
export async function updatePlanWithLLM(options: UpdatePlanOptions, _ctx?: any): Promise<{ plan: ResearchPlan; metadata: LLMResponseMetadata }> {
  const evaluatorPrompt = await loadPrompt('evaluator');
  const injectedPrompt = injectCurrentDate(evaluatorPrompt, 'evaluator');

  const response = await complete(options.model, {
    systemPrompt: injectedPrompt,
    messages: [
      { role: 'user', content: [{ type: 'text', text: options.query }] as TextContent[], timestamp: Date.now() },
    ],
  }, { signal: options.signal });

  const metadata = response as unknown as LLMResponseMetadata;

  return {
    plan: response.content as any,
    metadata,
  };
}

/**
 * Parse JSON from LLM response with error handling
 */
export function parseLLMJsonResponse<T>(text: string, fallbackBuilder?: (rawText: string, query: string) => T): T {
  try {
    const parsed = extractJson(text) as T;
    return parsed;
  } catch (parseError) {
    if (fallbackBuilder) {
      const queryMatch = text.match(/query["\s:]+([^,\n]+)/i);
      const query = queryMatch?.[1] || '';
      return fallbackBuilder(text, query);
    }
    throw new Error(`Failed to parse LLM response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`, { cause: parseError });
  }
}

/**
 * Record LLM token usage
 */
export function recordLLMTokenUsage(metadata: LLMResponseMetadata): void {
  const tokenUsage = parseTokenUsage(metadata);
  const totalTokens = calculateTotalTokens(tokenUsage);

  if (totalTokens > 0) {
    // Record metrics if metrics system is available
  }
}