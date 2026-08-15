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
import { repairJsonWithLlm } from './llm/agentic-repair.ts';
import { buildSafeOptions, validateAndExtractText } from './llm/llm-utils.ts';
import { safeGetApiKeyAndHeaders } from './llm/model-registry-factory.ts';
import { withTimeout } from './llm/llm-timeout.ts';
import { retryWithBackoff, isTransientError } from '../web-research/retry-utils.ts';
import { getConfig } from '../config.ts';
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
   * Update plan / evaluate progress after a round
   */
  async updatePlanForRound(options: UpdatePlanOptions): Promise<ResearchPlan> {
    const { sessionId, query, complexity, round, model, reports, mustSynthesize, signal, observer, steeringMessages, modelRegistry } = options;
    
    logger.log(`[PlanningService] Evaluating Round ${round} findings for: "${query}"`);

    const config = options.config ?? getConfig(options.cwd);
    const promptTemplate = loadPrompt('system-lead-evaluator');
    
    const maxTeamSize = this.getTeamSize(complexity);
    const queryBudget = this.getQueryBudget(complexity);
    // Prefer the caller's live, steering-extended round budget (e.g. the
    // orchestrator's maxRounds, which grows past the base complexity-table
    // value once steering messages unlock extra rounds). Only fall back to
    // the base per-complexity value when the caller doesn't supply one, so
    // callers that don't pass it (other/test callers) keep prior behavior.
    const maxRounds = options.maxRounds ?? _getMaxRounds(complexity);
    const complexityGuidance = this.getEvaluatorComplexityGuidance(complexity);
    const roundPhaseGuidance = this.getRoundPhaseGuidance(round, maxRounds, complexity, maxTeamSize);

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

    // The evaluator system prompt is deliberately ROUND-INVARIANT: it interpolates only
    // values that are fixed for the whole run (complexity, team size, query budget, the
    // disabled-tool list). Everything that changes between rounds — root query, round
    // number, agenda, executed queries, steering, round-phase guidance — is appended to
    // the END of the user message instead (see runContext below).
    //
    // The reason is prompt caching. Every provider caches on an exact prefix of the
    // serialized request, and the system prompt is the front of that prefix: a single
    // round-varying byte in it invalidates the entire request, including the findings
    // blob, which on a multi-round run is by far the largest thing we send. Anthropic-
    // style caching makes this sharper still — pi-ai places one cache_control breakpoint
    // at the end of the system prompt, so a system prompt that changes each round means
    // that breakpoint is written and never read (paying the 1.25x write multiplier for
    // nothing), and because invalidation is hierarchical (tools -> system -> messages)
    // the message-level breakpoint cannot hit either.
    //
    // Keeping it invariant means round 2+ re-reads one cache entry that is also shared
    // by every other run at the same complexity, and lets the findings prefix below do
    // the same. Measured with llm_cache_read_tokens_total (see utils/llm-usage.ts).
    const systemPrompt = injectCurrentDate(promptTemplate, 'evaluator');
    const populatedPrompt = this.populatePrompt(systemPrompt, {
      complexity_label: complexity === 1 ? 'Level 1 (Normal)' : complexity === 2 ? 'Level 2 (Deep)' : 'Level 3 (Ultra)',
      disabled_tools_section: disabledToolsSection,
      complexity_guidance: complexityGuidance,
      max_team_size: maxTeamSize,
      query_budget: queryBudget,
      youtube_query_every_n: config.YOUTUBE_QUERY_EVERY_N,
    });

    // Normalize citations across all reports to ONE global numbering BEFORE the
    // evaluator/synthesis LLM sees them, and hand it the matching Global Source
    // List. The evaluator prompt promises exactly this ("reports have already
    // been normalized to these global numbers"); doing it here is what makes the
    // synthesized body's [N] line up with the final CITED LINKS list that
    // ensureCitedLinks() regenerates from the same normalization.
    const { normalizedReports, globalCitations } = normalizeCitations(reports);
    const globalSourceList = globalCitations.length > 0
      ? 'GLOBAL SOURCE LIST (use these exact [N] numbers for every inline citation):\n' +
        globalCitations
          .map((c) => `[${c.id}] ${c.url}${c.source ? ` [Source: ${c.source}]` : ''}${c.description ? ` — ${c.description}` : ''}`)
          .join('\n')
      : '';
    const findings = Array.from(normalizedReports.entries())
        .map(([id, report]) => `### Researcher ${id}\n${report}`)
        .join('\n\n');

    // Run-varying context, appended AFTER the findings. `reports` is cumulative and
    // iterated in insertion order, and normalizeCitations assigns global ids by first
    // appearance in that same order, so a report written in round 1 is byte-identical
    // in the round-2 and round-3 messages — the findings block is a genuine stable
    // prefix that later rounds re-read from cache instead of re-paying for. Anything
    // placed before it would destroy that: the global source list used to sit at the
    // front and grew by a line per new URL, which moved every byte after it and made
    // the whole message uncacheable from the first round onward.
    const runContext = [
      `## RUN CONTEXT`,
      `- **ROOT QUERY**: ${query}`,
      `- **Current round**: ${round} / ${maxRounds}`,
      initialAgendaSection.trim(),
      previousQueriesSection.trim(),
      roundPhaseGuidance.trim(),
      steeringSection.trim(),
    ].filter(Boolean).join('\n\n');

    const directive = mustSynthesize
        ? `Research budget exhausted. Synthesize the final report now, based on the findings above.`
        : `Evaluate the findings above and decide next steps (delegate more researchers or synthesize the final report).`;

    const userMessage = [
      'Findings from the research team follow.',
      findings,
      globalSourceList,
      runContext,
      directive,
    ].filter(Boolean).join('\n\n---\n\n');

    try {
      const authResult = await safeGetApiKeyAndHeaders(modelRegistry, model);
      if (!authResult.ok) {
        throw new Error(`Failed to get API key for evaluation: ${authResult.error}`);
      }

      const llmTimeout = config.LLM_TIMEOUT_MS;

      // Retry the transport call + validation on transient failures (see generatePlan for the
      // rationale — a "terminated" abort only throws at validateAndExtractText, so validation
      // must be inside the retried region; repair/fallback stays outside).
      const { response, responseText } = await retryWithBackoff(
        async () => {
          const response = await withTimeout(
            completeSimple(model, {
              systemPrompt: populatedPrompt,
              messages: [
                { role: 'user', content: [{ type: 'text', text: userMessage }], timestamp: Date.now() },
              ],
              // The evaluator's response carries the final report whenever it synthesizes —
              // which it may choose to do on ANY round (voluntary early finish), not just the
              // forced final round. So every evaluator call gets the full synthesis budget; a
              // small decision response simply uses a fraction of it. Clamped to the model.
            }, buildSafeOptions(model, {
              apiKey: authResult.apiKey || '',
              headers: authResult.headers,
              signal,
              sessionId,
            }, config.SYNTHESIS_MAX_TOKENS, config.LLM_THINKING_LEVEL)),
            llmTimeout, 'evaluator-updatePlanForRound',
          );
          const responseText = validateAndExtractText(response, 'Evaluator');
          return { response, responseText };
        },
        {
          maxRetries: LLM_MAX_RETRIES,
          initialDelay: LLM_RETRY_INITIAL_DELAY_MS,
          maxDelay: LLM_RETRY_MAX_DELAY_MS,
          label: 'evaluator-updatePlanForRound',
          signal,
          isTransientError: (err) => isRetriableLlmError(err, signal),
        },
      );

      // Track usage once, on the successful attempt (failed attempts throw before here).
      recordLlmUsage(model, (response as any).usage, { component: 'evaluator', complexity, observer });

      // Extract and validate JSON
      let plan: ResearchPlan | null = null;
      try {
          plan = this.parseJsonPlan(responseText);
      } catch {
        logger.warn('[PlanningService] Evaluation JSON malformed, attempting agentic repair');
        const repaired = await repairJsonWithLlm<ResearchPlan>(
            responseText,
            completeSimple,
            { apiKey: authResult.apiKey || '', headers: authResult.headers },
            {
                model,
                schema: EvaluationResponseSchemaAsTSchema,
                context: `Research evaluation for: ${query} (Round ${round})`,
                serviceName: 'PlanningService',
                signal,
                sessionId,
                maxTokens: config.SYNTHESIS_MAX_TOKENS,
                thinkingLevel: config.LLM_THINKING_LEVEL,
                onUsage: (rawUsage) => recordLlmUsage(model, rawUsage, { component: 'evaluator', complexity, observer }),
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
          logger.warn('[PlanningService] Failed to generate valid evaluation on the final round; synthesizing from raw text');
          const safeContent = salvageReportText(responseText);
          plan = { action: 'synthesize', content: safeContent, researchers: [] };
        } else if (previousPlan?.researchers && previousPlan.researchers.length > 0) {
          logger.warn('[PlanningService] Evaluation unparseable mid-research; continuing the prior agenda rather than synthesizing early');
          plan = { action: 'delegate', content: '', researchers: previousPlan.researchers };
        } else {
          logger.warn('[PlanningService] Evaluation unparseable and no prior agenda to continue; falling back to synthesize');
          const safeContent = salvageReportText(responseText);
          plan = { action: 'synthesize', content: safeContent, researchers: [] };
        }
      }

      const finalPlan = plan as ResearchPlan;

      // Respect mustSynthesize flag
      if (mustSynthesize) {
          finalPlan.action = 'synthesize';
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
   * Generate queries for a researcher
   */
  async generateQueries(options: GenerateQueriesOptions): Promise<string[]> {
    return options.researcher.queries || [];
  }
}
