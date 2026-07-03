/**
 * Unified LLM usage accounting.
 *
 * Every billed LLM call in a research run must record its token/cost the same way,
 * to the same run-scoped `metrics` counters (`llm_tokens_total` / `llm_cost_total`)
 * and — when a run observer is present — to the live `onTokensConsumed` event. Those
 * counters are the single source of truth the tool layer reports (see
 * research-tool-definition.ts → extractRunStats). Prior to this helper the same
 * extract→increment→emit block was hand-copied at each call site, and drift (a call
 * site that counted metrics but forgot the observer, or an agentic-repair pass that
 * counted nothing at all) silently under-reported cost. Route every call site here.
 */

import type { Model } from '@earendil-works/pi-ai';
import { extractUsage } from '../types/llm.ts';
import { metrics } from './metrics.ts';

/** Structural subset of the run observer — just the token sink. Kept structural (rather
 *  than importing ResearchObserver from core/) so this foundation-layer helper does not
 *  depend on an upper layer; the full ResearchObserver satisfies it. */
export interface TokenSink {
  onTokensConsumed?: (tokens: number, cost: number) => void;
}

export interface RecordUsageOptions {
  /** Metrics `component` label (e.g. 'coordinator', 'evaluator', 'researcher'). */
  component: string;
  /** Optional complexity label, stringified for the metric labels. */
  complexity?: number | string;
  /** Live run observer; receives onTokensConsumed for the interactive cost meter. */
  observer?: TokenSink | null;
}

/**
 * Extract usage from a raw LLM response usage object and record it to the active
 * run-scoped metrics registry (+ the observer, if any). Zero/absent usage is a no-op.
 * Returns the extracted { tokens, cost } for callers that also need the value.
 */
export function recordLlmUsage(
  model: Model<any>,
  rawUsage: unknown,
  opts: RecordUsageOptions
): { tokens: number; cost: number } {
  if (!rawUsage) return { tokens: 0, cost: 0 };
  const { tokens, cost } = extractUsage(model, rawUsage);
  if (tokens > 0 || cost > 0) {
    const labels: Record<string, string> = { component: opts.component };
    if (opts.complexity !== undefined) labels['complexity'] = String(opts.complexity);
    metrics.increment('llm_tokens_total', tokens, labels);
    metrics.increment('llm_cost_total', cost, labels);
    opts.observer?.onTokensConsumed?.(tokens, cost);
  }
  return { tokens, cost };
}
