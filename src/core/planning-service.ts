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
import { completeSimple } from '@earendil-works/pi-ai';
import { injectCurrentDate } from './llm/inject-date.ts';
import { loadPrompt } from './llm/prompts.ts';
import { extractUsage } from '../types/llm.ts';
import { metrics } from '../utils/metrics.ts';
import { repairJsonWithLlm } from './llm/agentic-repair.ts';
import { buildSafeOptions, validateAndExtractText } from './llm/llm-utils.ts';
import { createTimeout } from './llm/llm-timeout.ts';
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
    
    const config = getConfig(options.cwd);
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
    });

    const userMessage = `Generate the initial research plan for: "${query}"`;

    try {
      const authResult = await modelRegistry.getApiKeyAndHeaders(model);
      if (!authResult.ok) {
        throw new Error(`Failed to get API key for planning: ${authResult.error}`);
      }

      const llmTimeout = config.LLM_TIMEOUT_MS;

      const response = await Promise.race([
        completeSimple(model, {
          systemPrompt: populatedPrompt,
          messages: [
            { role: 'user', content: [{ type: 'text', text: userMessage }], timestamp: Date.now() },
          ],
        }, buildSafeOptions(model, { 
          apiKey: authResult.apiKey || '', 
          headers: authResult.headers, 
          signal
        }, 4096)),
        createTimeout(llmTimeout, 'coordinator-generatePlan'),
      ]);

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
      logger.error('[PlanningService] Failed to generate plan:', err);
      throw err;
    }
  }

  /**
   * Update plan / evaluate progress after a round
   */
  async updatePlanForRound(options: UpdatePlanOptions): Promise<ResearchPlan> {
    const { sessionId, query, complexity, round, model, reports, mustSynthesize, signal, observer, steeringMessages, modelRegistry } = options;
    
    logger.log(`[PlanningService] Evaluating Round ${round} findings for: "${query}"`);

    const config = getConfig(options.cwd);
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
    });

    const findings = Array.from(reports.entries())
        .map(([id, report]) => `### Researcher ${id}\n${report}`)
        .join('\n\n');

    const userMessage = mustSynthesize 
        ? `Research budget exhausted. Synthesize final report now based on findings:\n\n${findings}`
        : `Evaluate the following findings and decide next steps (delegate more researchers or synthesize final report):\n\n${findings}`;

    try {
      const authResult = await modelRegistry.getApiKeyAndHeaders(model);
      if (!authResult.ok) {
        throw new Error(`Failed to get API key for evaluation: ${authResult.error}`);
      }

      const llmTimeout = config.LLM_TIMEOUT_MS;

      const response = await Promise.race([
        completeSimple(model, {
          systemPrompt: populatedPrompt,
          messages: [
            { role: 'user', content: [{ type: 'text', text: userMessage }], timestamp: Date.now() },
          ],
        }, buildSafeOptions(model, { 
          apiKey: authResult.apiKey || '', 
          headers: authResult.headers, 
          signal
        }, 4096)),
        createTimeout(llmTimeout, 'evaluator-updatePlanForRound'),
      ]);

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
        logger.warn('[PlanningService] Failed to generate valid evaluation, falling back to synthesize');
        plan = { action: 'synthesize', content: responseText, researchers: [] };
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
      throw err;
    }
  }

  /**
   * Generate queries for a researcher
   */
  async generateQueries(options: GenerateQueriesOptions): Promise<string[]> {
    return options.researcher.queries || [];
  }
}
