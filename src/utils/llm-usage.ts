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
import { extractUsage, type TokenUsage } from '../types/llm.ts';
import { logger } from '../logger.ts';
import { metrics } from './metrics.ts';

/** Models already warned about, so the notice fires at most once per model per process. */
const unpricedModelsWarned = new Set<string>();

/**
 * Warn once when a model bills tokens but carries an all-zero price table.
 *
 * Cost is never read off the wire — pi computes it as tokens × the model's local
 * price table — so an unpriced table yields $0.00 silently and indefinitely. That
 * is legitimate for flat-rate plans and local servers, but it is also exactly what
 * a misconfiguration looks like: a hand-written `models[]` entry in models.json
 * REPLACES pi's catalog entry for the same id, discarding its pricing. This
 * happened in practice and went unnoticed for weeks because every display site
 * suppressed a zero cost. The message deliberately does not assert a fault — it
 * states the condition and names the usual cause.
 */
function warnIfUnpriced(model: Model<any>, tokens: number, cost: number): void {
  if (tokens <= 0 || cost > 0) return;
  const m = model as unknown as { provider?: string; id?: string; cost?: Record<string, number> };
  const key = `${m.provider ?? 'unknown'}/${m.id ?? 'unknown'}`;
  if (unpricedModelsWarned.has(key)) return;

  const table = m.cost;
  const allZero =
    !table || Object.values(table).every((v) => typeof v !== 'number' || v === 0);
  if (!allZero) return;

  unpricedModelsWarned.add(key);
  logger.warn(
    `[LlmUsage] Model "${key}" consumed ${tokens} tokens but reports $0.00 — its price table is all zeros. ` +
      `Expected for flat-rate plans and local servers. Otherwise the price data is missing: a hand-written ` +
      `"models" entry in ~/.pi/agent/models.json replaces pi's catalog entry (and its pricing) for the same ` +
      `model id — remove it and let pi's catalog supply the model, or use "modelOverrides", which merges.`
  );
}

/**
 * Record the prompt-cache split alongside the plain token counter.
 *
 * `llm_tokens_total` folds cached and uncached input into one number, so a run whose
 * prefix cache never hits is indistinguishable from one that hits on every call — the
 * cost line moves, but nothing says why. These two counters are the only signal that
 * prompt caching is working at all, and they are what a caching regression shows up in:
 * a prompt edit that pushes volatile text ahead of stable text drives `cache_read` to
 * zero while `cache_write` keeps climbing.
 *
 * Zero-valued counters are still emitted (when the provider reported the field at all)
 * so "cache is off" and "provider does not report caching" stay distinguishable: the
 * first shows the counter at 0, the second omits it. Caveat: the caller gates on
 * `tokens > 0 || cost > 0`, so a response whose usage is all-zero across the board
 * emits nothing — harmless in practice because cache fields are summed into `tokens`,
 * so a reported cache split implies a nonzero total.
 *
 * Accuracy note: for the openai-completions API family (which includes OpenRouter),
 * pi-ai's usage normalization ALWAYS sets cacheRead/cacheWrite, defaulting missing
 * upstream fields to 0 — so on those providers a route without prompt caching shows the
 * counter at 0 rather than omitting it. The 0-vs-absent distinction only holds for APIs
 * that omit the fields outright. A run showing llm_cache_read_tokens_total stuck at 0
 * with nonzero input tokens is therefore most simply read as "this route reports no
 * cached tokens", not "our prompts defeat the cache".
 */
function recordCacheTokens(parsed: Partial<TokenUsage>, labels: Record<string, string>): void {
  if (typeof parsed.cacheRead === 'number') {
    metrics.increment('llm_cache_read_tokens_total', parsed.cacheRead, labels);
  }
  if (typeof parsed.cacheWrite === 'number') {
    metrics.increment('llm_cache_write_tokens_total', parsed.cacheWrite, labels);
  }
}

/** Structural subset of the run observer — just the token sinks. Kept structural (rather
 *  than importing ResearchObserver from core/) so this foundation-layer helper does not
 *  depend on an upper layer; the full ResearchObserver satisfies it. */
export interface TokenSink {
  onTokensConsumed?: (tokens: number, cost: number) => void;
  /** Phase-scoped sinks, fed from the `component` label ('coordinator', 'router'/'synthesizer');
   *  they drive the TUI coord/eval cost rows and the SDK planning_tokens /
   *  evaluation_tokens events. */
  onPlanningTokens?: (tokens: number, cost: number) => void;
  onEvaluationTokens?: (tokens: number, cost: number) => void;
}

export interface RecordUsageOptions {
  /** Metrics `component` label (e.g. 'coordinator', 'router', 'synthesizer', 'researcher'). */
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
  const { tokens, cost, parsed } = extractUsage(model, rawUsage);
  warnIfUnpriced(model, tokens, cost);
  if (tokens > 0 || cost > 0) {
    const labels: Record<string, string> = { component: opts.component };
    if (opts.complexity !== undefined) labels['complexity'] = String(opts.complexity);
    metrics.increment('llm_tokens_total', tokens, labels);
    metrics.increment('llm_cost_total', cost, labels);
    recordCacheTokens(parsed, labels);
    opts.observer?.onTokensConsumed?.(tokens, cost);
    // Phase-scoped events: coordinator/evaluator call sites label their usage
    // 'coordinator'/'router'/'synthesizer' (see planning-service.ts); route those to the
    // dedicated observer hooks so the TUI coord/eval cost rows and the SDK
    // planning_tokens/evaluation_tokens events fire. Before this mapping the hooks
    // had zero emit sites (regression in c90d7f37) — coordinator/evaluator usage
    // reached only onTokensConsumed, which the TUI observer does not implement.
    if (opts.component === 'coordinator') {
      opts.observer?.onPlanningTokens?.(tokens, cost);
    } else if (opts.component === 'router' || opts.component === 'synthesizer') {
      // Both halves of the research lead feed the one evaluation row. They used to be a
      // single 'evaluator' component; splitting the roles must not split the cost the
      // user sees, so they are summed here rather than given separate sinks.
      opts.observer?.onEvaluationTokens?.(tokens, cost);
    }
  }
  return { tokens, cost };
}
