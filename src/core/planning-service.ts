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
import { completeSimple } from '@earendil-works/pi-ai/compat';
import { injectCurrentDate } from './llm/inject-date.ts';
import { loadPrompt } from './llm/prompts.ts';
import { extractUsage } from '../types/llm.ts';
import { metrics } from '../utils/metrics.ts';
import { normalizeCitations } from '../utils/citation-utils.ts';
import { repairJsonWithLlm } from './llm/agentic-repair.ts';
import { buildSafeOptions, validateAndExtractText } from './llm/llm-utils.ts';
import { safeGetApiKeyAndHeaders } from './llm/model-registry-factory.ts';
import { withTimeout } from './llm/llm-timeout.ts';
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

      const response = await withTimeout(
        completeSimple(model, {
          systemPrompt: populatedPrompt,
          messages: [
            { role: 'user', content: [{ type: 'text', text: userMessage }], timestamp: Date.now() },
          ],
        }, buildSafeOptions(model, {
          apiKey: authResult.apiKey || '',
          headers: authResult.headers,
          signal
        }, config.PLANNING_MAX_TOKENS, config.LLM_THINKING_LEVEL)),
        llmTimeout, 'coordinator-generatePlan',
      );

      // Track usage
      const rawUsage = (response as any).usage;
      if (rawUsage) {
        const { tokens, cost } = extractUsage(model, rawUsage);
        if (tokens > 0 || cost > 0) {
          metrics.increment('llm_tokens_total', tokens, { component: 'coordinator', complexity: String(complexity) });
          metrics.increment('llm_cost_total', cost, { component: 'coordinator', complexity: String(complexity) });
          observer?.onTokensConsumed?.(tokens, cost);
        }
      }

      const responseText = validateAndExtractText(response, 'Coordinator');

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
                maxTokens: config.PLANNING_MAX_TOKENS,
                thinkingLevel: config.LLM_THINKING_LEVEL,
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
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = msg.includes('timed out') || msg.includes('returned no text content');
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
    const maxRounds = _getMaxRounds(complexity);
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

    const systemPrompt = injectCurrentDate(promptTemplate, 'evaluator');
    const populatedPrompt = this.populatePrompt(systemPrompt, {
      root_query: query,
      round_number: round,
      max_rounds: maxRounds,
      complexity_label: complexity === 1 ? 'Level 1 (Normal)' : complexity === 2 ? 'Level 2 (Deep)' : 'Level 3 (Ultra)',
      initial_agenda_section: initialAgendaSection,
      previous_queries_section: previousQueriesSection,
      additional_considerations: steeringSection,
      disabled_tools_section: disabledToolsSection,
      complexity_guidance: complexityGuidance,
      round_phase_guidance: roundPhaseGuidance,
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
          .join('\n') +
        '\n\n---\n\n'
      : '';
    const findings = globalSourceList + Array.from(normalizedReports.entries())
        .map(([id, report]) => `### Researcher ${id}\n${report}`)
        .join('\n\n');

    const userMessage = mustSynthesize 
        ? `Research budget exhausted. Synthesize final report now based on findings:\n\n${findings}`
        : `Evaluate the following findings and decide next steps (delegate more researchers or synthesize final report):\n\n${findings}`;

    try {
      const authResult = await safeGetApiKeyAndHeaders(modelRegistry, model);
      if (!authResult.ok) {
        throw new Error(`Failed to get API key for evaluation: ${authResult.error}`);
      }

      const llmTimeout = config.LLM_TIMEOUT_MS;

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
          signal
        }, config.SYNTHESIS_MAX_TOKENS, config.LLM_THINKING_LEVEL)),
        llmTimeout, 'evaluator-updatePlanForRound',
      );

      // Track usage
      const rawUsage = (response as any).usage;
      if (rawUsage) {
        const { tokens, cost } = extractUsage(model, rawUsage);
        if (tokens > 0 || cost > 0) {
          metrics.increment('llm_tokens_total', tokens, { component: 'evaluator', complexity: String(complexity) });
          metrics.increment('llm_cost_total', cost, { component: 'evaluator', complexity: String(complexity) });
          observer?.onTokensConsumed?.(tokens, cost);
        }
      }

      const responseText = validateAndExtractText(response, 'Evaluator');

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
                maxTokens: config.SYNTHESIS_MAX_TOKENS,
                thinkingLevel: config.LLM_THINKING_LEVEL,
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
          const safeContent = responseText.length > 50 ? responseText : '';
          plan = { action: 'synthesize', content: safeContent, researchers: [] };
        } else if (previousPlan?.researchers && previousPlan.researchers.length > 0) {
          logger.warn('[PlanningService] Evaluation unparseable mid-research; continuing the prior agenda rather than synthesizing early');
          plan = { action: 'delegate', content: '', researchers: previousPlan.researchers };
        } else {
          logger.warn('[PlanningService] Evaluation unparseable and no prior agenda to continue; falling back to synthesize');
          const safeContent = responseText.length > 50 ? responseText : '';
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
          this.currentPlans.set(sessionId, capped);
          return capped;
      }

      this.currentPlans.set(sessionId, finalPlan);
      return finalPlan;
    } catch (err) {
      logger.error('[PlanningService] Failed to update plan:', err);
      // A genuine cancellation must propagate so the orchestrator can abort cleanly.
      if (signal?.aborted) throw err;
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
