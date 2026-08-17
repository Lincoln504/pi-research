/**
 * Planning Service
 *
 * Coordinates the research planning and evaluation phases.
 * Interacts with the LLM to generate research agendas and evaluate findings.
 */

import { ServiceLifecycle } from './service-registry.ts';
import { ServiceNames } from './service-interfaces.ts';
import type { 
  IPlanningService, 
  ResearchPlan, 
  UpdatePlanOptions, 
  GenerateQueriesOptions,
  ResearcherConfig,
  GeneratePlanOptions
} from './service-interfaces.ts';
import { logger } from '../logger.ts';
import { completeSimple } from './llm/pi-ai-completion.ts';
import { injectCurrentDate } from './llm/inject-date.ts';
import { loadPrompt } from './llm/prompts.ts';
import { recordLlmUsage } from '../utils/llm-usage.ts';
import { normalizeCitations } from '../utils/citation-utils.ts';
import { lastCitedLinksHeader } from '../utils/text-utils.ts';
import { repairJsonWithLlm } from './llm/agentic-repair.ts';
import { buildSafeOptions, validateAndExtractText } from './llm/llm-utils.ts';
import { safeGetApiKeyAndHeaders } from './llm/model-registry-factory.ts';
import { withTimeout } from './llm/llm-timeout.ts';
import { retryWithBackoff, isTransientError } from '../web-research/retry-utils.ts';
import { getConfig, type Config } from '../config.ts';
import type { Model } from '@earendil-works/pi-ai';
import { DEFAULT_MODEL_CONTEXT_WINDOW } from '../constants.ts';
import { deriveCoverageDigest, formatDigestsForRouter } from '../utils/coverage-digest.ts';
import {
  PlanningResponseSchemaAsTSchema,
  EvaluationResponseSchemaAsTSchema,
} from './planning-constants.ts';
import {
  getTeamSize as _getTeamSize,
  getQueryBudget as _getQueryBudget,
  getMaxRounds as _getMaxRounds,
  getComplexityGuidance as _getComplexityGuidance,
  getEvaluatorComplexityGuidance as _getEvaluatorComplexityGuidance,
  getRoundPhaseGuidance as _getRoundPhaseGuidance,
  parseJsonPlan as _parseJsonPlan,
  buildFallbackCoordinatorPlan as _buildFallbackCoordinatorPlan,
  capResearcherQueries as _capResearcherQueries,
  generateResearchers as _generateResearchers,
} from './planning-utils.ts';

// The coordinator and evaluator LLM calls are single points of failure for a research
// run, yet (unlike researcher sub-agents) they had no retry — so one transient transport
// failure (an undici "terminated" mid-stream abort, ECONNRESET, 429, 5xx) aborted the whole
// run. Retry them a bounded number of times. Kept low so that a genuine provider outage
// (repeated full LLM_TIMEOUT_MS) still degrades to the deterministic fallback plan within a
// sane wall-clock budget rather than multiplying a 5-minute timeout many times over.
const LLM_MAX_RETRIES = 2;
const LLM_RETRY_INITIAL_DELAY_MS = 1000;
const LLM_RETRY_MAX_DELAY_MS = 8000;

/**
 * Output ceiling for a ROUTING call.
 *
 * The router emits a decision, never a report — at worst a delegate plan of
 * `maxTeamSize` researchers each carrying `queryBudget` queries, which is a couple of
 * thousand tokens at Level 3. It used to share the synthesis budget because the same call
 * could return the final report; under the split protocol it cannot, so a ceiling this
 * far above the real ceiling is only there to leave room for a model that reasons before
 * answering. Still clamped to the model by buildSafeOptions.
 */
const ROUTER_MAX_TOKENS = 8192;

/** Rough bytes-per-token used to budget the synthesis corpus. Deliberately conservative. */
const CHARS_PER_TOKEN = 4;

/**
 * Tokens held back from the context window, on top of the configured output ceiling, to
 * cover everything in a synthesis request that is not the corpus: the system prompt, the
 * global source list, the run context, and the slack between a chars/4 estimate and a real
 * tokenizer on prose that is heavy with URLs and citation markers.
 */
const SYNTHESIS_OVERHEAD_TOKENS = 8000;

/**
 * Floor on the corpus budget. Below this, partitioning produces so many partial passes
 * that the reduce costs more than the overflow it avoids — better to send one oversized
 * request and let the provider's own error surface than to fan out indefinitely.
 */
const MIN_SYNTHESIS_CORPUS_CHARS = 40_000;

/**
 * How many reduce passes the synthesizer may run before it merges whatever it has.
 * A run whose corpus needs more than this has grown far past anything the round budget
 * can produce; the bound exists so a pathological input cannot spin.
 */
const MAX_SYNTHESIS_REDUCE_PASSES = 3;

/**
 * Floor on a partial pass's output ceiling. A wide fan-out divides the corpus budget many
 * ways; without a floor a 12-partition reduce would allot each partial too few tokens to
 * hold its slice of the findings, and "exhaustive synthesis" would quietly become
 * summarisation. When the floor binds, the partials may not fit in one pass — that is what
 * the remaining passes are for.
 */
const MIN_PARTIAL_SYNTHESIS_TOKENS = 4096;

/**
 * Characters of corpus a single synthesis request may carry for `model`.
 *
 * The final synthesis is the one call whose input grows without bound: it carries every
 * report the run collected. Nothing upstream caps it — there is no per-report budget and
 * no cap on report count — so on a deep, steering-extended run it can exceed the model's
 * context window, and the failure is expensive and late: the provider rejects the request
 * after the entire run has been paid for, and the orchestrator degrades to a mechanical
 * concatenation of the raw reports. Budgeting here converts that cliff into a bounded
 * two-pass reduce.
 */
export function synthesisCorpusBudgetChars(
  model: { contextWindow?: number },
  outputTokens: number,
): number {
  const window = model.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  const usable = window - outputTokens - SYNTHESIS_OVERHEAD_TOKENS;
  return Math.max(MIN_SYNTHESIS_CORPUS_CHARS, usable * CHARS_PER_TOKEN);
}

/**
 * Greedily group corpus entries into runs that each fit `budgetChars`, preserving order.
 *
 * Order is preserved because global citation ids are assigned by first appearance across
 * the reports in this same order; keeping partitions contiguous keeps each partial pass
 * looking at a coherent, mostly-self-consistent slice of the numbering rather than an
 * arbitrary scatter of it.
 *
 * A single entry larger than the whole budget gets a partition to itself and is truncated
 * by the caller — at that point there is no partitioning left to do.
 */
export function partitionCorpus<T>(
  entries: Array<[string, T]>,
  sizeOf: (entry: [string, T]) => number,
  budgetChars: number,
): Array<Array<[string, T]>> {
  const partitions: Array<Array<[string, T]>> = [];
  let current: Array<[string, T]> = [];
  let currentSize = 0;
  for (const entry of entries) {
    const size = sizeOf(entry);
    if (current.length > 0 && currentSize + size > budgetChars) {
      partitions.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(entry);
    currentSize += size;
  }
  if (current.length > 0) partitions.push(current);
  return partitions;
}

/**
 * Whether a failed coordinator/evaluator LLM call should be RETRIED. Retries only fast,
 * transient transport failures: an undici mid-stream abort ("terminated"), a dropped socket,
 * a 5xx / 429 / provider-overload, or an empty ("no text content") response.
 *
 * Deliberately does NOT retry an app-level LLM timeout ("...timed out after Nms"): the attempt
 * already ran the full LLM_TIMEOUT_MS, so an immediate re-run is unlikely to succeed, would
 * leave the prior (still-running) stream orphaned and billed, and would multiply a multi-minute
 * wait. A timeout instead degrades straight to the fallback plan (see the catch blocks, which
 * treat "timed out" as degradable). A deliberate cancellation is never retried — detected by
 * AbortSignal state / AbortError name, not by the message (withTimeout emits the same "cancelled
 * or timed out" wording for a user-abort and a real timeout, and abortableDelay is the backstop).
 *
 * Exported for direct unit testing of the abort/timeout guards.
 */
export function isRetriableLlmError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (error instanceof Error && error.name === 'AbortError') return false;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes('timed out')) return false; // app timeout → degrade, don't retry
  if (message.includes('no text content')) return true;
  return isTransientError(error);
}

/**
 * Whether an exhausted coordinator/evaluator failure should DEGRADE to the deterministic
 * fallback plan rather than abort the run. Broader than the retry set: it also covers the
 * app-level timeout (which is intentionally not retried). Only a genuinely non-transient error
 * (bad request, missing auth) stays fatal — a fallback plan can't run without a working model.
 */
function isDegradableLlmError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes('timed out')) return true;
  return isRetriableLlmError(error, signal);
}

/**
 * Salvage raw evaluator text as report content when JSON parse AND agentic repair
 * both fail. A truncated/garbled JSON envelope must NOT be shipped verbatim as the
 * final report (the user would see raw `{"action":"synthesize","content":"...` cut
 * off mid-string). Returning '' here lets the orchestrator's reports-based fallback
 * synthesis take over. Genuine prose (a model that answered in text instead of JSON)
 * is preserved — only JSON-envelope-looking blobs and too-short scraps are rejected.
 */
export function salvageReportText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 50) return '';
  // Looks like a (broken) JSON envelope rather than a report — suppress it.
  if (trimmed.startsWith('{') && /"(?:action|content|researchers)"\s*:/.test(trimmed)) {
    return '';
  }
  return raw;
}

/**
 * Planning Service Implementation
 */
export class PlanningService implements IPlanningService {
  readonly name = ServiceNames.PLANNING;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  // State per research session
  private currentPlans = new Map<string, ResearchPlan>();
  private totalResearchersPlanned = new Map<string, number>();
  private queryHistory = new Map<string, Set<string>>();

  async initialize(): Promise<void> {
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  async dispose(): Promise<void> {
    this.currentPlans.clear();
    this.totalResearchersPlanned.clear();
    this.queryHistory.clear();
    this.lifecycle = ServiceLifecycle.DISPOSED;
  }

  /**
   * Check if the service is ready
   */
  isReady(): boolean {
    return this.lifecycle === ServiceLifecycle.INITIALIZED;
  }

  /**
   * Clear planning state for a specific research ID
   */
  clearPlanningState(researchId?: string): void {
    if (researchId) {
      this.currentPlans.delete(researchId);
      this.totalResearchersPlanned.delete(researchId);
      this.queryHistory.delete(researchId);
    } else {
      this.currentPlans.clear();
      this.totalResearchersPlanned.clear();
      this.queryHistory.clear();
    }
  }

  /**
   * Get the current plan for a session
   */
  getCurrentPlan(researchId: string): ResearchPlan | null {
    return this.currentPlans.get(researchId) || null;
  }

  /**
   * Get total number of researchers planned across all rounds
   */
  getTotalResearchersPlanned(researchId: string): number {
    return this.totalResearchersPlanned.get(researchId) || 0;
  }

  /**
   * Increment total number of researchers planned
   */
  incrementTotalResearchersPlanned(researchId: string, count: number): void {
    const current = this.getTotalResearchersPlanned(researchId);
    this.totalResearchersPlanned.set(researchId, current + count);
  }

  /**
   * Get query history for a session
   */
  getQueryHistory(researchId: string): string[] {
    const history = this.queryHistory.get(researchId);
    return history ? Array.from(history) : [];
  }

  /**
   * Record search queries to history to prevent duplication in later rounds
   */
  addToQueryHistory(researchId: string, queries: string[]): void {
    if (!this.queryHistory.has(researchId)) {
      this.queryHistory.set(researchId, new Set());
    }
    const history = this.queryHistory.get(researchId)!;
    for (const q of queries) {
      if (q && q.trim()) {
        history.add(q.toLowerCase().trim());
      }
    }
  }

  /**
   * Interface pass-throughs for planning utilities
   */
  getTeamSize(complexity: 1 | 2 | 3): number {
    return _getTeamSize(complexity);
  }

  getQueryBudget(complexity: 1 | 2 | 3): number {
    return _getQueryBudget(complexity);
  }

  getComplexityGuidance(complexity: 1 | 2 | 3, maxTeamSize: number, queryBudget: number): string {
    return _getComplexityGuidance(complexity, maxTeamSize, queryBudget);
  }

  getEvaluatorComplexityGuidance(complexity: 1 | 2 | 3): string {
    return _getEvaluatorComplexityGuidance(complexity);
  }

  getRoundPhaseGuidance(currentRound: number, maxRounds: number, complexity: 1 | 2 | 3, maxTeamSize: number): string {
    return _getRoundPhaseGuidance(currentRound, maxRounds, complexity, maxTeamSize);
  }

  parseJsonPlan(text: string): ResearchPlan {
    return _parseJsonPlan(text);
  }

  buildFallbackCoordinatorPlan(rawText: string, query: string): ResearchPlan {
    return _buildFallbackCoordinatorPlan('PlanningService', rawText, query);
  }

  capResearcherQueries(plan: ResearchPlan, complexity: 1 | 2 | 3, serviceName: string): ResearchPlan {
    return _capResearcherQueries(plan, complexity, serviceName);
  }

  generateResearchers(plan: ResearchPlan, query: string, complexity: 1 | 2 | 3): ResearcherConfig[] {
    return _generateResearchers(plan, query, complexity);
  }

  /**
   * Helper to populate prompt templates with placeholders.
   */
  private populatePrompt(template: string, replacements: Record<string, string | number>): string {
    let result = template;
    for (const [key, value] of Object.entries(replacements)) {
      const placeholder = `{{${key}}}`;
      result = result.split(placeholder).join(String(value));
    }
    return result;
  }

  /**
   * Generate initial research plan
   */
  async generatePlan(options: GeneratePlanOptions): Promise<ResearchPlan> {
    const { sessionId, query, complexity, model, signal, observer, steeringMessages, modelRegistry } = options;
    
    logger.log(`[PlanningService] Generating initial plan for: "${query}" (Complexity: ${complexity})`);
    
    const config = options.config ?? getConfig(options.cwd);
    const promptTemplate = loadPrompt('system-coordinator');
    
    const maxTeamSize = this.getTeamSize(complexity);
    const queryBudget = this.getQueryBudget(complexity);
    const complexityGuidance = this.getComplexityGuidance(complexity, maxTeamSize, queryBudget);

    // Inject steering if present
    let steeringSection = '';
    if (steeringMessages && steeringMessages.length > 0) {
        steeringSection = '\n\n### ADDITIONAL USER GUIDANCE (Apply these rules and instructions to your plan and decisions)\n' +
            steeringMessages.map(m => `- ${m}`).join('\n');
    }

    const disabledToolsSection = options.excludeTools && options.excludeTools.length > 0
      ? `\n## DISABLED TOOLS\nThe following tools are DISABLED for this session: ${options.excludeTools.join(', ')}. Do NOT reference or attempt to use them.\n`
      : '';

    const systemPrompt = injectCurrentDate(promptTemplate, 'coordinator');
    const populatedPrompt = this.populatePrompt(systemPrompt, {
      root_query: query,
      additional_considerations: steeringSection,
      complexity_label: complexity === 1 ? 'Level 1 (Normal)' : complexity === 2 ? 'Level 2 (Deep)' : 'Level 3 (Ultra)',
      max_team_size: maxTeamSize,
      query_budget: queryBudget,
      complexity_guidance: complexityGuidance,
      disabled_tools_section: disabledToolsSection,
      youtube_query_every_n: config.YOUTUBE_QUERY_EVERY_N,
    });

    const userMessage = `Generate the initial research plan for: "${query}"`;

    try {
      const authResult = await safeGetApiKeyAndHeaders(modelRegistry, model);
      if (!authResult.ok) {
        throw new Error(`Failed to get API key for planning: ${authResult.error}`);
      }

      const llmTimeout = config.LLM_TIMEOUT_MS;

      // Retry the transport call + response validation on transient failures. A mid-stream
      // undici "terminated" abort surfaces as a stopReason:'error' response that only throws
      // inside validateAndExtractText, so validation MUST sit inside the retried region. The
      // agentic-repair / fallback path below stays OUTSIDE the retry — it handles present-but-
      // malformed JSON (a different failure) and would otherwise be re-paid on every attempt.
      const { response, responseText } = await retryWithBackoff(
        async () => {
          const response = await withTimeout(
            completeSimple(model, {
              systemPrompt: populatedPrompt,
              messages: [
                { role: 'user', content: [{ type: 'text', text: userMessage }], timestamp: Date.now() },
              ],
            }, buildSafeOptions(model, {
              apiKey: authResult.apiKey || '',
              headers: authResult.headers,
              signal,
              sessionId,
            }, config.PLANNING_MAX_TOKENS, config.LLM_THINKING_LEVEL)),
            llmTimeout, 'coordinator-generatePlan',
          );
          const responseText = validateAndExtractText(response, 'Coordinator');
          return { response, responseText };
        },
        {
          maxRetries: LLM_MAX_RETRIES,
          initialDelay: LLM_RETRY_INITIAL_DELAY_MS,
          maxDelay: LLM_RETRY_MAX_DELAY_MS,
          label: 'coordinator-generatePlan',
          signal,
          isTransientError: (err) => isRetriableLlmError(err, signal),
        },
      );

      // Track usage once, on the successful attempt (failed attempts throw before here).
      recordLlmUsage(model, (response as any).usage, { component: 'coordinator', complexity, observer });

      // Extract and validate JSON
      let plan: ResearchPlan | null = null;
      try {
        plan = this.parseJsonPlan(responseText);
      } catch {
        logger.warn('[PlanningService] Initial plan JSON malformed, attempting agentic repair');
        const repaired = await repairJsonWithLlm<ResearchPlan>(
            responseText,
            completeSimple,
            { apiKey: authResult.apiKey || '', headers: authResult.headers },
            {
                model,
                schema: PlanningResponseSchemaAsTSchema,
                context: `Research planning for: ${query}`,
                serviceName: 'PlanningService',
                signal,
                sessionId,
                maxTokens: config.PLANNING_MAX_TOKENS,
                thinkingLevel: config.LLM_THINKING_LEVEL,
                onUsage: (rawUsage) => recordLlmUsage(model, rawUsage, { component: 'coordinator', complexity, observer }),
            }
        );
        if (repaired) {
            // Validate repaired JSON
            try {
                plan = this.parseJsonPlan(JSON.stringify(repaired));
            } catch {
                plan = null;
            }
        }
      }

      if (!plan) {
        logger.warn('[PlanningService] Failed to generate valid plan, building fallback');
        plan = this.buildFallbackCoordinatorPlan(responseText, query);
      }

      // Final safety cap
      plan = this.capResearcherQueries(plan, complexity, this.name);
      // The coordinator (round 1) MUST yield runnable researchers. If the model emitted empty or
      // absent query arrays, capResearcherQueries drops them all and force-synthesizes — but at
      // round 1 there are zero reports, so that is a silent no-op run ("no summary generated",
      // no error). buildFallbackCoordinatorPlan only fires on a null plan, so a parseable-but-
      // empty plan slips through. Fall back to the single-researcher plan so the run investigates.
      if (!plan.researchers || plan.researchers.length === 0) {
          logger.warn('[PlanningService] Coordinator produced no runnable researchers (empty queries); using single-researcher fallback');
          plan = this.capResearcherQueries(this.buildFallbackCoordinatorPlan(responseText, query), complexity, this.name);
      }
      if (plan.action !== 'synthesize') {
          plan.action = 'delegate';
      }
      this.currentPlans.set(sessionId, plan);

      return plan;
    } catch (err) {
      // A genuine cancellation must propagate so the orchestrator can abort cleanly.
      // Log it at debug, not error — a quit-mid-run is a clean stop, and an ERROR
      // line here previously read like an infrastructure failure.
      if (signal?.aborted) {
        logger.debug('[PlanningService] Plan generation aborted (external signal)');
        throw err;
      }
      // A transient coordinator failure — the call timed out, or the model returned an
      // empty / thinking-only response — used to abort the entire run on the very first
      // call (this path runs BEFORE the in-band JSON-parse fallback above). Degrade like
      // updatePlanForRound: build the deterministic single-researcher plan so the run can
      // still proceed. Hard failures (missing auth, an explicit provider error / rate
      // limit) stay fatal — a fallback plan can't run without a working model anyway.
      // After retries are exhausted, a still-transient failure (timeout, empty response, or a
      // transport abort like "terminated") degrades to the deterministic fallback plan so the
      // run proceeds; only a genuinely non-transient error (missing auth, explicit provider
      // rejection) stays fatal — a fallback plan can't run without a working model anyway.
      const isTransient = isDegradableLlmError(err, signal);
      if (!isTransient) {
        logger.error('[PlanningService] Failed to generate plan:', err);
        throw err;
      }
      logger.warn('[PlanningService] Coordinator call failed transiently; building fallback plan so the run can proceed');
      let plan = this.buildFallbackCoordinatorPlan('', query);
      plan = this.capResearcherQueries(plan, complexity, this.name);
      if (plan.action !== 'synthesize') {
        plan.action = 'delegate';
      }
      this.currentPlans.set(sessionId, plan);
      return plan;
    }
  }

  /**
   * Update plan / evaluate progress after a round.
   *
   * This is TWO jobs behind one entry point, selected by `mustSynthesize`:
   *
   * - **Routing** (`mustSynthesize` falsy) — decide whether the run continues. Reads the
   *   researchers' COVERAGE DIGESTS, not their findings. It still grows with the number
   *   of researchers, but by one digest each rather than one report each — measured at
   *   two orders of magnitude less per researcher. It cannot produce the report.
   * - **Synthesis** (`mustSynthesize` true) — write the report. Reads every report in
   *   full, exactly once, at the end of the run, under a corpus budget.
   *
   * They were one call reading the full corpus every round. That conflation is what made
   * evaluator input grow with the square of the round count (round n re-sent rounds
   * 1..n), put the final call at risk of exceeding the model's context window, and made
   * the request shape uncacheable — a fresh single user message rebuilt each round, whose
   * cache breakpoint therefore never matched. Splitting the roles removes the repetition
   * rather than discounting it, so it needs no caching and behaves the same on every
   * provider.
   */
  async updatePlanForRound(options: UpdatePlanOptions): Promise<ResearchPlan> {
    const { sessionId, query, complexity, round, model, reports, mustSynthesize, signal, observer, steeringMessages, modelRegistry } = options;

    // The router runs on every round except the terminal one; synthesis runs once.
    const isRouter = !mustSynthesize;
    const role = isRouter ? 'router' : 'synthesizer';

    logger.log(`[PlanningService] ${isRouter ? 'Routing after' : 'Synthesizing at'} Round ${round} for: "${query}"`);

    const config = options.config ?? getConfig(options.cwd);
    const promptTemplate = loadPrompt(isRouter ? 'system-lead-router' : 'system-lead-synthesizer');

    const maxTeamSize = this.getTeamSize(complexity);
    const queryBudget = this.getQueryBudget(complexity);
    // Prefer the caller's live, steering-extended round budget (e.g. the
    // orchestrator's maxRounds, which grows past the base complexity-table
    // value once steering messages unlock extra rounds). Only fall back to
    // the base per-complexity value when the caller doesn't supply one, so
    // callers that don't pass it (other/test callers) keep prior behavior.
    const maxRounds = options.maxRounds ?? _getMaxRounds(complexity);
    const complexityGuidance = this.getEvaluatorComplexityGuidance(complexity);
    // The round budget counts ITERATIONS, and the last one only ever synthesizes — the
    // orchestrator leaves the loop before dispatching anyone. Phase guidance is about
    // how much RESEARCH is left, so it must be computed against the rounds that can
    // still research, not against the iteration count.
    //
    // Passing the raw budget told the router it had a round in hand that did not exist.
    // At round 2 of 3 that is the difference between MIDDLE ("prefer delegation... with
    // 1 round remaining") and LATE ("synthesize if the core question is answerable").
    //
    // To be precise about what was and was not wrong, because an earlier revision of
    // this comment overstated it: a delegation made at round 2 DOES run — its
    // researchers execute and their findings reach the synthesizer. What did not exist
    // was the round AFTER it. The router was being calibrated as though it had another
    // routing decision coming, when the one it was making was its last.
    //
    // Consequence worth naming: with the complexity table's 2/3/3 budgets, an unsteered
    // run reaches the router exactly once, at the final research round, so LATE is the
    // only phase it ever sees. That is correct — it IS the last decision — but it means
    // the EARLY/MIDDLE branches are reachable only once steering has extended the
    // budget. Anyone re-tuning this ladder should know the unsteered path no longer
    // exercises it.
    const researchRounds = Math.max(1, maxRounds - 1);
    const roundPhaseGuidance = this.getRoundPhaseGuidance(round, researchRounds, complexity, maxTeamSize);

    // Inject steering if present
    let steeringSection = '';
    if (steeringMessages && steeringMessages.length > 0) {
        steeringSection = '\n\n### ADDITIONAL USER GUIDANCE (Ensure findings follow these rules)\n' +
            steeringMessages.map(m => `- ${m}`).join('\n');
    }

    const disabledToolsSection = options.excludeTools && options.excludeTools.length > 0
      ? `\n## DISABLED TOOLS\nThe following tools are DISABLED for this session: ${options.excludeTools.join(', ')}. Do NOT reference or attempt to use them.\n`
      : '';

    const previousPlan = options.previousPlan;
    const initialAgendaSection = previousPlan && previousPlan.researchers && previousPlan.researchers.length > 0
      ? `\n## Initial Research Agenda\n${previousPlan.researchers.map(r => `- ${r.name}: ${r.goal}`).join('\n')}\n`
      : '';

    const previousQueries = this.getQueryHistory(sessionId);
    const previousQueriesSection = previousQueries.length > 0
      ? `\n## Previously Executed Queries\n${previousQueries.map(q => `- ${q}`).join('\n')}\n`
      : '';

    // Both lead prompts are deliberately ROUND-INVARIANT: they interpolate only values
    // that are fixed for the whole run (complexity, team size, query budget, the
    // disabled-tool list). Everything that changes between rounds — root query, round
    // number, agenda, executed queries, steering, round-phase guidance — is appended to
    // the END of the user message instead (see runContext below).
    //
    // The reason is prompt caching. Every provider caches on an exact prefix of the
    // serialized request, and the system prompt is the front of that prefix: a single
    // round-varying byte in it invalidates the entire request. Anthropic-style caching
    // makes this sharper still — pi-ai places one cache_control breakpoint at the end of
    // the system prompt (on `anthropic-messages`, and on `openai-completions` whenever
    // the provider's `compat.cacheControlFormat` is "anthropic"), so a system prompt that
    // changes each round means that breakpoint is written and never read, and because
    // invalidation is hierarchical (tools -> system -> messages) the message-level
    // breakpoint cannot hit either.
    //
    // Keeping it invariant means round 2+ re-reads one cache entry that is also shared by
    // every other run at the same complexity. Measured with llm_cache_read_tokens_total
    // (see utils/llm-usage.ts). Note this is a real but SMALL win: what dominated the
    // evaluator's input was the findings corpus, and that is addressed structurally by
    // the router/synthesizer split rather than by caching.
    const systemPrompt = injectCurrentDate(promptTemplate, role);
    // `partial_synthesis_section` is the only run-varying value either template takes, and
    // only the synthesizer uses it — it names which reduce pass this call is. A
    // single-pass synthesis and every router call pass '', so their system prompts stay
    // byte-identical across the whole run.
    const populate = (partialSection: string): string => this.populatePrompt(systemPrompt, {
      complexity_label: complexity === 1 ? 'Level 1 (Normal)' : complexity === 2 ? 'Level 2 (Deep)' : 'Level 3 (Ultra)',
      disabled_tools_section: disabledToolsSection,
      complexity_guidance: complexityGuidance,
      max_team_size: maxTeamSize,
      query_budget: queryBudget,
      youtube_query_every_n: config.YOUTUBE_QUERY_EVERY_N,
      partial_synthesis_section: partialSection,
    });

    // Run-varying context, appended AFTER the bulk of the message (digests for the
    // router, findings for the synthesizer). `reports` is cumulative and iterated in
    // insertion order, and normalizeCitations assigns global ids by first appearance in
    // that same order, so a report written in round 1 is byte-identical in later rounds'
    // messages. Anything placed before it would destroy that: the global source list used
    // to sit at the front and grew by a line per new URL, which moved every byte after it.
    const runContext = [
      `## RUN CONTEXT`,
      `- **ROOT QUERY**: ${query}`,
      // Router only, and in RESEARCH rounds — the same denominator as the phase
      // guidance below, because two different round counts in one prompt is worse than
      // either alone. The router's only decision is delegate-vs-synthesize, and the
      // trailing synthesis pass is not a round it can spend.
      //
      // Omitted for the synthesizer, which has no round decision to calibrate. Showing
      // it there reintroduced the impossible round number this denominator was meant to
      // remove: the forced final synthesis runs AT the cap, so it read "Current round:
      // 2 / 1" on every complexity-1 run — and then promised a final synthesis pass to
      // the call that was itself the final synthesis pass.
      isRouter ? `- **Current round**: ${round} / ${researchRounds} (research rounds; a final synthesis pass follows)` : '',
      initialAgendaSection.trim(),
      previousQueriesSection.trim(),
      // Round-phase guidance calibrates a ROUTING decision against the round budget. The
      // terminal synthesis has no decision left to make, so it is omitted there.
      isRouter ? roundPhaseGuidance.trim() : '',
      steeringSection.trim(),
    ].filter(Boolean).join('\n\n');

    try {
      const authResult = await safeGetApiKeyAndHeaders(modelRegistry, model);
      if (!authResult.ok) {
        throw new Error(`Failed to get API key for evaluation: ${authResult.error}`);
      }

      const callOptions = {
        model,
        apiKey: authResult.apiKey || '',
        headers: authResult.headers,
        signal,
        sessionId,
        config,
        complexity,
        observer,
      };

      const responseText = isRouter
        ? await this.callLead({
            ...callOptions,
            systemPrompt: populate(''),
            userMessage: buildRouterMessage(...this.buildRouterEvidence(options, round), runContext),
            maxTokens: ROUTER_MAX_TOKENS,
            component: 'router',
            label: 'router-updatePlanForRound',
          })
        : await this.synthesizeCorpus({ ...callOptions, reports, runContext, populate });

      // Extract and validate JSON
      let plan: ResearchPlan | null = null;
      try {
          plan = this.parseJsonPlan(responseText);
      } catch {
        logger.warn(`[PlanningService] ${role} JSON malformed, attempting agentic repair`);
        const repaired = await repairJsonWithLlm<ResearchPlan>(
            responseText,
            completeSimple,
            { apiKey: authResult.apiKey || '', headers: authResult.headers },
            {
                model,
                schema: EvaluationResponseSchemaAsTSchema,
                context: `Research ${role} for: ${query} (Round ${round})`,
                serviceName: 'PlanningService',
                signal,
                sessionId,
                maxTokens: isRouter ? ROUTER_MAX_TOKENS : config.SYNTHESIS_MAX_TOKENS,
                thinkingLevel: config.LLM_THINKING_LEVEL,
                onUsage: (rawUsage) => recordLlmUsage(model, rawUsage, { component: role, complexity, observer }),
            }
        );
        if (repaired) {
            // Validate repaired JSON
            try {
                plan = this.parseJsonPlan(JSON.stringify(repaired));
            } catch {
                plan = null;
            }
        }
      }

      if (!plan) {
        // A parse failure here used to ALWAYS default to synthesize, which prematurely
        // ended a run on a single transient/garbled evaluator response (with rounds still
        // remaining) — and put the raw, often-truncated text into the report body.
        // Only finalize early when synthesis was already mandatory (final round); otherwise,
        // if there is a prior agenda to continue, delegate another round rather than giving up.
        // Round budget (maxRounds) still bounds this, so it cannot loop indefinitely.
        if (mustSynthesize) {
          logger.warn('[PlanningService] Failed to generate valid synthesis JSON on the final round; synthesizing from raw text');
          const safeContent = salvageReportText(responseText);
          plan = { action: 'synthesize', content: safeContent, researchers: [] };
        } else if (previousPlan?.researchers && previousPlan.researchers.length > 0) {
          logger.warn('[PlanningService] Routing decision unparseable mid-research; continuing the prior agenda rather than finishing early');
          plan = { action: 'delegate', content: '', researchers: previousPlan.researchers };
        } else {
          // A ROUTER's raw text is never a report — it has not read the findings. Salvaging
          // it as `content` (which is what this branch used to do, back when one call did
          // both jobs) would ship the model's routing prose to the user as the run's
          // output. Hand back an empty synthesis decision instead, so the orchestrator
          // runs the real terminal synthesis over the collected reports.
          logger.warn('[PlanningService] Routing decision unparseable and no prior agenda to continue; deferring to final synthesis');
          plan = { action: 'synthesize', content: '', researchers: [] };
        }
      }

      const finalPlan = plan as ResearchPlan;

      // Respect mustSynthesize flag
      if (mustSynthesize) {
          finalPlan.action = 'synthesize';
      } else if (finalPlan.action === 'synthesize' && finalPlan.content) {
        // The router is told not to write prose and is given no findings to write it from,
        // but a model that ignores that would produce an ungrounded report — and the
        // orchestrator would ship it verbatim. Drop it; the terminal synthesis, which does
        // read every report, writes the output.
        logger.warn('[PlanningService] Router returned report content despite having no findings; discarding it in favour of the final synthesis');
        finalPlan.content = '';
      }

      // `action` is OPTIONAL in the schema, and parseJsonPlan accepts a plan without one
      // as long as it carries researchers — its own comment says such a plan "defaults to
      // delegation downstream", which was true of generatePlan and never of this method.
      // A router emitting `{"researchers":[...]}` therefore fell through every branch
      // below and was returned verbatim: no team-size cap, no per-researcher query
      // budget, no round hard cap, and no duplicate-id renumbering — and duplicate ids
      // collide on the `${round}.${id}` report key, silently discarding one researcher's
      // entire report. The orchestrator then matched none of its `action === 'delegate'`
      // branches, so it announced no decision and never grew the progress bar, yet ran
      // the researchers anyway and the bar visibly regressed.
      //
      // 'wait' is preserved: the orchestrator acts on it, and it is not a delegation.
      if (finalPlan.action !== 'synthesize' && finalPlan.action !== 'wait') {
          finalPlan.action = 'delegate';
      }

      // Final safety cap if delegating
      if (finalPlan.action === 'delegate') {
          const capped = this.capResearcherQueries(finalPlan, complexity, this.name);
          // Mirror generatePlan's empty-after-cap guard, adapted to mid-run: a
          // delegate whose researchers ALL had empty query arrays caps to zero and
          // comes back force-synthesized — indistinguishable to the orchestrator
          // from a real synthesis decision, so its rationale prose (or nothing)
          // would ship as the final report with rounds remaining. Treat it like a
          // degradable evaluator failure instead: continue the prior agenda when
          // one exists, else synthesize with empty content so the orchestrator's
          // reports-based fallback (not the rationale) produces the report.
          if (!capped.researchers || capped.researchers.length === 0) {
              if (previousPlan?.researchers && previousPlan.researchers.length > 0) {
                  const fallback = this.capResearcherQueries(
                    { action: 'delegate', content: '', researchers: previousPlan.researchers },
                    complexity,
                    this.name,
                  );
                  if (fallback.researchers && fallback.researchers.length > 0) {
                      logger.warn('[PlanningService] Evaluator delegated zero runnable researchers; continuing the prior agenda rather than synthesizing early');
                      this.currentPlans.set(sessionId, fallback);
                      return fallback;
                  }
              }
              logger.warn('[PlanningService] Evaluator delegated zero runnable researchers and no prior agenda is runnable; synthesizing from collected reports');
              const fallback: ResearchPlan = { action: 'synthesize', content: '', researchers: [] };
              this.currentPlans.set(sessionId, fallback);
              return fallback;
          }
          this.currentPlans.set(sessionId, capped);
          return capped;
      }

      this.currentPlans.set(sessionId, finalPlan);
      return finalPlan;
    } catch (err) {
      // A genuine cancellation must propagate so the orchestrator can abort cleanly.
      // Re-throw BEFORE logging so a quit-mid-run is a clean stop, not a red
      // "Failed to update plan" line (matching generatePlan's abort hygiene).
      if (signal?.aborted) throw err;
      logger.error('[PlanningService] Failed to update plan:', err);
      // Degrading below is only sound MID-LOOP for a transient failure (timeout, empty
      // response, transport abort) — the same isDegradableLlmError gate generatePlan
      // applies. A hard failure (revoked/missing auth, explicit provider rejection)
      // would hit every remaining round identically, burning each one on doomed search
      // bursts and researcher launches instead of surfacing the real cause — so it
      // stays fatal mid-loop. The forced FINAL synthesis (mustSynthesize) is different:
      // it is a one-shot call with no rounds left to protect, and a hard throw there
      // (e.g. a context-overflow 400 from oversized findings) discards every collected
      // report — degrade instead, so the orchestrator's reports-based fallback
      // synthesis still salvages a report.
      if (!mustSynthesize && !isDegradableLlmError(err, signal)) throw err;
      // Otherwise degrade gracefully: a transient evaluator failure (timeout, empty
      // or provider error) reaches here BEFORE the JSON-parse fallback above and used
      // to throw — aborting the whole run with no decision (looks like "the evaluator
      // never came"). Mirror that fallback: continue the prior agenda mid-run, else
      // synthesize from whatever reports were already collected. maxRounds still bounds it.
      if (!mustSynthesize && previousPlan?.researchers && previousPlan.researchers.length > 0) {
        logger.warn('[PlanningService] Evaluator call failed mid-research; continuing the prior agenda rather than aborting the run');
        const fallback = this.capResearcherQueries(
          { action: 'delegate', content: '', researchers: previousPlan.researchers },
          complexity,
          this.name,
        );
        this.currentPlans.set(sessionId, fallback);
        return fallback;
      }
      logger.warn('[PlanningService] Evaluator call failed with no prior agenda; synthesizing from collected reports');
      const fallback: ResearchPlan = { action: 'synthesize', content: '', researchers: [] };
      this.currentPlans.set(sessionId, fallback);
      return fallback;
    }
  }

  /**
   * Coverage digests for the router, one per researcher that has reported.
   *
   * Callers that hold the synthesis service pass them in. Callers that don't (tests, the
   * SDK's direct entry points) get digests derived from the report bodies, so the router
   * always sees an entry for every researcher rather than being handed nothing and
   * concluding the round produced no work.
   */
  /**
   * Split what the router sees into evidence it must judge and history it already judged.
   *
   * The fidelity/cost trade this protocol turns on. Sending every report every round gives
   * a correct decision but grows with the square of the round count; sending only digests
   * is cheap but makes the decision hostage to what each researcher claims about its own
   * work. Sending each report in full exactly ONCE — on the round it arrives — costs the
   * corpus linearly and still puts real prose in front of every decision.
   */
  private buildRouterEvidence(
    options: UpdatePlanOptions,
    round: number,
  ): [Map<string, { body: string; digest: string }>, Map<string, string>] {
    const digests = this.resolveDigests(options);
    const { freshIds, priorIds } = splitReportsByRound(options.reports, round);

    const fresh = new Map<string, { body: string; digest: string }>();
    for (const id of freshIds) {
      fresh.set(id, {
        body: stripCitedLinks(options.reports.get(id) ?? ''),
        digest: digests.get(id) ?? '(none provided)',
      });
    }

    const prior = new Map<string, string>();
    for (const id of priorIds) {
      const digest = digests.get(id);
      if (digest) prior.set(id, digest);
    }
    // A digest whose report is gone still belongs in the history block — dropping it hides
    // that researcher from the router entirely.
    for (const [id, digest] of digests.entries()) {
      if (!fresh.has(id) && !prior.has(id)) prior.set(id, digest);
    }

    return [fresh, prior];
  }

  private resolveDigests(options: UpdatePlanOptions): Map<string, string> {
    // Fill per REPORT, not per supplied digest. Taking `options.digests` wholesale would
    // leave the router blind to any researcher missing from it — and a researcher the
    // router cannot see reads as one that produced nothing, which argues for re-delegating
    // work already done. Iterating the reports guarantees exactly one entry per researcher
    // whatever the caller passed.
    const supplied = options.digests;
    const resolved = new Map<string, string>();
    for (const [id, report] of options.reports.entries()) {
      resolved.set(id, supplied?.get(id) ?? deriveCoverageDigest(report));
    }
    // A digest for an id with no report (a caller tracking them separately) is still worth
    // showing — dropping it would hide a researcher entirely.
    if (supplied) {
      for (const [id, digest] of supplied.entries()) {
        if (!resolved.has(id)) resolved.set(id, digest);
      }
    }
    return resolved;
  }

  /**
   * One lead LLM call: transport retry, timeout, text validation, usage accounting.
   *
   * Shared by the router and by every pass of the synthesizer so all of them get the same
   * transient-failure handling. Retries the transport call AND validation together (see
   * generatePlan — a "terminated" abort only throws at validateAndExtractText, so
   * validation must sit inside the retried region); repair and fallback stay outside, in
   * the caller.
   */
  private async callLead(args: {
    model: Model<any>;
    apiKey: string;
    headers?: Record<string, string | null>;
    signal?: AbortSignal;
    sessionId: string;
    config: Config;
    complexity: 1 | 2 | 3;
    observer?: UpdatePlanOptions['observer'];
    systemPrompt: string;
    userMessage: string;
    maxTokens: number;
    component: string;
    label: string;
  }): Promise<string> {
    const { model, signal, config, complexity, observer, label } = args;

    const { response, responseText } = await retryWithBackoff(
      async () => {
        const response = await withTimeout(
          completeSimple(model, {
            systemPrompt: args.systemPrompt,
            messages: [
              { role: 'user', content: [{ type: 'text', text: args.userMessage }], timestamp: Date.now() },
            ],
          }, buildSafeOptions(model, {
            apiKey: args.apiKey,
            headers: args.headers,
            signal,
            sessionId: args.sessionId,
          }, args.maxTokens, config.LLM_THINKING_LEVEL)),
          config.LLM_TIMEOUT_MS, label,
        );
        const responseText = validateAndExtractText(response, label);
        return { response, responseText };
      },
      {
        maxRetries: LLM_MAX_RETRIES,
        initialDelay: LLM_RETRY_INITIAL_DELAY_MS,
        maxDelay: LLM_RETRY_MAX_DELAY_MS,
        label,
        signal,
        isTransientError: (err) => isRetriableLlmError(err, signal),
      },
    );

    // Track usage once, on the successful attempt (failed attempts throw before here).
    recordLlmUsage(model, (response as any).usage, { component: args.component, complexity, observer });
    return responseText;
  }

  /**
   * Produce the final report from the full corpus, in one pass when it fits and a bounded
   * reduce when it does not.
   *
   * The reduce exists because this is the only call whose input is unbounded, and its
   * failure mode is the worst in the system: the provider rejects an over-window request
   * after the whole run has been paid for, and the user receives a mechanical
   * concatenation of raw reports. Partitioning trades one guaranteed-to-fit pass per
   * partition plus a merge for that cliff.
   */
  private async synthesizeCorpus(args: {
    model: Model<any>;
    apiKey: string;
    headers?: Record<string, string | null>;
    signal?: AbortSignal;
    sessionId: string;
    config: Config;
    complexity: 1 | 2 | 3;
    observer?: UpdatePlanOptions['observer'];
    reports: Map<string, string>;
    runContext: string;
    populate: (partialSection: string) => string;
  }): Promise<string> {
    const { config, reports, runContext, populate } = args;

    // Normalize citations across all reports to ONE global numbering BEFORE the synthesis
    // LLM sees them, and hand it the matching Global Source List. The synthesizer prompt
    // promises exactly this ("reports have already been normalized to these global
    // numbers"); doing it here is what makes the synthesized body's [N] line up with the
    // final CITED LINKS list that ensureCitedLinks() regenerates from the same
    // normalization. Done once, before partitioning, so every partial pass sees the same
    // global numbering as the merge.
    const { normalizedReports, globalCitations } = normalizeCitations(reports);
    const globalSourceList = globalCitations.length > 0
      ? 'GLOBAL SOURCE LIST (use these exact [N] numbers for every inline citation):\n' +
        globalCitations
          .map((c) => `[${c.id}] ${c.url}${c.source ? ` [Source: ${c.source}]` : ''}${c.description ? ` — ${c.description}` : ''}`)
          .join('\n')
      : '';

    const budgetChars = synthesisCorpusBudgetChars(args.model, config.SYNTHESIS_MAX_TOKENS);

    let entries: Array<[string, string]> = Array.from(normalizedReports.entries())
      .map(([id, report]) => [`Researcher ${id}`, truncateToBudget(report, budgetChars, id)] as [string, string]);

    let pass = 0;
    let reduced = false;
    while (pass < MAX_SYNTHESIS_REDUCE_PASSES) {
      const partitions = partitionCorpus(entries, entrySize, budgetChars);
      if (partitions.length <= 1) break;
      reduced = true;
      logger.warn(
        `[PlanningService] Synthesis corpus (${entries.reduce((n, e) => n + entrySize(e), 0)} chars) exceeds the ` +
        `${budgetChars}-char budget for ${args.model.id}; reducing in ${partitions.length} partial passes (pass ${pass + 1})`,
      );
      // Budget each partial's OUTPUT so that all of them together fit the next pass's
      // input. Left at the full synthesis ceiling, N partials can total N x 32k tokens —
      // larger than the corpus they replaced — so the reduce would need pass after pass to
      // converge and could still run out of passes. Dividing the budget makes one pass
      // sufficient in practice. Floored so a wide fan-out cannot squeeze a partial down to
      // uselessly few tokens; if the floor binds, the extra passes below absorb it.
      const partialMaxTokens = Math.min(
        config.SYNTHESIS_MAX_TOKENS,
        Math.max(
          MIN_PARTIAL_SYNTHESIS_TOKENS,
          Math.floor(budgetChars / CHARS_PER_TOKEN / partitions.length),
        ),
      );
      const next: Array<[string, string]> = [];
      for (const [index, partition] of partitions.entries()) {
        const text = await this.callLead({
          ...args,
          systemPrompt: populate(partialSynthesisSection(index + 1, partitions.length)),
          userMessage: buildSynthesisMessage(partition, globalSourceList, runContext, true),
          maxTokens: partialMaxTokens,
          component: 'synthesizer',
          label: `synthesizer-reduce-${pass + 1}.${index + 1}`,
        });
        next.push([`Partial synthesis ${index + 1}`, unwrapPartialSynthesis(text, this)]);
      }
      entries = next;
      pass++;
    }

    // Exiting on the pass cap with the corpus still over budget means the request below is
    // knowingly oversized. Say so: a silent truncation-or-overflow here reads downstream as
    // "the model refused", and the run has already been paid for by this point.
    const finalSize = entries.reduce((n, e) => n + entrySize(e), 0);
    if (finalSize > budgetChars) {
      logger.warn(
        `[PlanningService] Synthesis corpus is still ${finalSize} chars after ` +
        `${MAX_SYNTHESIS_REDUCE_PASSES} reduce pass(es), over the ${budgetChars}-char budget for ` +
        `${args.model.id}. Sending it anyway — the provider may reject this request.`,
      );
    }

    return this.callLead({
      ...args,
      systemPrompt: populate(reduced ? MERGE_SYNTHESIS_SECTION : ''),
      userMessage: buildSynthesisMessage(entries, globalSourceList, runContext, false),
      maxTokens: config.SYNTHESIS_MAX_TOKENS,
      component: 'synthesizer',
      label: 'synthesizer-final',
    });
  }

  /**
   * Generate queries for a researcher
   */
  async generateQueries(options: GenerateQueriesOptions): Promise<string[]> {
    return options.researcher.queries || [];
  }
}

/**
 * Take the prose out of a partial pass's response, whatever shape it arrived in.
 *
 * A partial pass is told to return plain text, and the override that says so is now the
 * last thing in its prompt. A model can still return the synthesis envelope out of habit —
 * and if it does, the merge pass would receive a raw JSON blob where it expects prose,
 * then dutifully reproduce the braces in the final report. Unwrapping here costs one
 * parse attempt and makes the reduce independent of that going right.
 */
function unwrapPartialSynthesis(text: string, service: { parseJsonPlan(t: string): ResearchPlan }): string {
  const trimmed = text.trim();
  if (!trimmed.includes('"content"')) return trimmed;
  try {
    const parsed = service.parseJsonPlan(trimmed);
    const content = typeof parsed.content === 'string' ? parsed.content.trim() : '';
    if (content) {
      logger.debug('[PlanningService] Partial synthesis returned a JSON envelope; unwrapped its content');
      return content;
    }
  } catch {
    // Not an envelope — it is prose that happens to mention "content". Use it as written.
  }
  return trimmed;
}

/** Chars a corpus entry contributes, including its `### <label>` heading line. */
function entrySize(entry: [string, string]): number {
  return entry[1].length + entry[0].length + 8;
}

/**
 * Cut a single report that is larger than the entire corpus budget.
 *
 * Reached only when one researcher produced more text than the model can hold at once, at
 * which point there is no partitioning left to do — the choice is a truncated report or a
 * rejected request. The marker is left in the text so the model knows the tail is missing
 * rather than treating the cut as the end of the findings.
 */
function truncateToBudget(report: string, budgetChars: number, id: string): string {
  if (report.length <= budgetChars) return report;
  logger.warn(
    `[PlanningService] Report ${id} (${report.length} chars) exceeds the whole synthesis corpus budget ` +
    `(${budgetChars}); truncating it — the tail of this report will not reach the final report`,
  );
  return `${report.slice(0, budgetChars)}\n\n[report truncated: exceeded the synthesis context budget]`;
}

/**
 * Which reports the router has not read in full yet.
 *
 * A report is FRESH on the one round it arrives, and thereafter is represented by its
 * digest — the router already read it, and re-sending it is the repetition this protocol
 * exists to remove. Derived from the `${round}.${id}` key the synthesis service stores
 * under, so it needs no extra state and survives a `wait` retry re-running the same round.
 *
 * An id with no parseable round prefix is treated as FRESH. That errs toward showing the
 * router more evidence: the failure mode of guessing wrong in the other direction is a
 * decision made without ever having seen a finding.
 */
export function splitReportsByRound(
  reports: ReadonlyMap<string, string>,
  currentRound: number,
): { freshIds: string[]; priorIds: string[] } {
  const freshIds: string[] = [];
  const priorIds: string[] = [];
  for (const id of reports.keys()) {
    const round = Number.parseInt(id.split('.')[0] ?? '', 10);
    // Reports produced during round `currentRound - 1` are the ones this call is judging.
    // `>=` rather than `===` so a round that produced nothing cannot strand a later
    // report in the "already reviewed" bucket it was never shown in.
    if (!Number.isFinite(round) || round >= currentRound - 1) freshIds.push(id);
    else priorIds.push(id);
  }
  return { freshIds, priorIds };
}

/**
 * Drop the trailing CITED LINKS section from a report body.
 *
 * Routing needs the findings, not the bibliography — and the bibliography is a large share
 * of a report, since the researcher prompt asks for 3–6 dense sentences per source. The
 * digest already carries the source count, which is the only part of it a routing decision
 * uses. Anchored on a real line-leading header, never an incidental mention in prose.
 */
function stripCitedLinks(report: string): string {
  const { lineStart } = lastCitedLinksHeader(report);
  return (lineStart >= 0 ? report.slice(0, lineStart) : report).trim();
}

/**
 * The router's user message.
 *
 * Earlier rounds come FIRST and are append-only — round r's block is a byte-identical
 * prefix of round r+1's — so the stable part of the request sits where a prompt cache can
 * hold it, and the volatile new reports sit after it.
 *
 * Each fresh report is shown with the digest its researcher wrote for it. That pairing is
 * the point: a self-reported "Gaps: none" sitting next to thin prose is visible as a
 * mismatch, where a digest on its own has to be taken on trust.
 */
export function buildRouterMessage(
  fresh: ReadonlyMap<string, { body: string; digest: string }>,
  priorDigests: ReadonlyMap<string, string>,
  runContext: string,
): string {
  const priorBlock = priorDigests.size > 0
    ? `## REVIEWED IN EARLIER ROUNDS\nYou read these reports in full when they arrived and already judged them. Only their coverage digests are repeated here.\n\n${formatDigestsForRouter(priorDigests)}`
    : '';

  const freshBlock = fresh.size > 0
    ? `## NEW SINCE YOUR LAST DECISION — FULL REPORTS\nJudge these on the evidence in the reports themselves. Each carries the digest its researcher wrote; treat that as a claim to check against the report below it, not as a fact.\n\n${
        Array.from(fresh.entries())
          .map(([id, r]) => `### Researcher ${id}\nResearcher's coverage claim:\n${r.digest}\n\nReport:\n${r.body || '(this researcher produced no usable report)'}`)
          .join('\n\n')
      }`
    : '(No new reports since your last decision.)';

  return [
    'Findings from the research team follow.',
    priorBlock,
    freshBlock,
    runContext,
    'Decide whether the research is complete or another round is needed. Return JSON only.',
  ].filter(Boolean).join('\n\n---\n\n');
}

/** The synthesizer's user message: corpus, global source list, run context, directive. */
function buildSynthesisMessage(
  entries: Array<[string, string]>,
  globalSourceList: string,
  runContext: string,
  isPartialPass: boolean,
): string {
  const isMerge = entries.some(([label]) => label.startsWith('Partial synthesis'));
  const leadIn = isMerge
    ? 'Partial syntheses of the research findings follow.'
    : 'Findings from the research team follow.';
  const body = entries.map(([label, text]) => `### ${label}\n${text}`).join('\n\n');
  const directive = isPartialPass
    ? 'Write the partial synthesis for the findings above, as plain text.'
    : 'Write the final report now, based on the findings above.';
  return [leadIn, body, globalSourceList, runContext, directive]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

/**
 * Overrides the synthesizer's output contract for one partition of a reduce pass.
 *
 * Interpolated at the very END of the template, after the Output Requirements block, so
 * this is the last instruction the model reads. Placed earlier it loses: the JSON-only
 * format rule further down would be the final word, the model would return an envelope
 * instead of prose, and the merge pass would receive raw JSON blobs where it expects
 * partial syntheses.
 */
function partialSynthesisSection(index: number, total: number): string {
  return [
    '---',
    '',
    '## PARTIAL PASS — read this LAST; it OVERRIDES the Output Requirements and CITED LINKS rules above',
    '',
    `The run's findings did not fit in one request. You are being given partition ${index} of ${total}.`,
    '',
    '- Write an exhaustive, topic-organized synthesis of ONLY the findings you were given. Every rule about detail, grounding and anonymity still applies at full strength — a later pass merges your output, so anything you omit is lost for good.',
    '- Use the global [N] numbers from the Global Source List for every inline citation, exactly as instructed above.',
    '- Do NOT write a CITED LINKS section. The merge pass writes the single one.',
    '- Do NOT return JSON. Return the synthesis as plain text and nothing else.',
    '- Do NOT mention partitioning, or that other findings exist.',
  ].join('\n');
}

/** Tells the final pass that its inputs are partial syntheses rather than raw reports. */
const MERGE_SYNTHESIS_SECTION = [
  '---',
  '',
  '## MERGE PASS',
  '',
  'The material above is a set of partial syntheses of this run\'s findings, each covering a different part of it. Merge them into one report.',
  '',
  '- Reorganize across the partials BY TOPIC. Do not present them in sequence, and do not label or reference them.',
  '- Keep every fact, date, name and statistic from every partial. Merging is not summarizing.',
  '- Reconcile overlap: where two partials cover the same ground, state it once, keeping the citations from both.',
  '- All other rules above — including the CITED LINKS section and the JSON output format — apply to your output as normal.',
].join('\n');
