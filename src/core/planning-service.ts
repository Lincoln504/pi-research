/**
 * Planning Service
 *
 * Responsible for generating research plans, coordinating researchers,
 * and managing query generation for multi-round research.
 *
 * This service extracts the planning logic from the orchestrator,
 * making it reusable and testable.
 */

import type { IPlanningService, ResearchPlan, ResearcherConfig } from './service-interfaces.ts';
import { ServiceLifecycle } from './service-registry.ts';
import { logger } from '../logger.ts';
import { complete, completeSimple, type TextContent, type Message } from '@mariozechner/pi-ai';
import { extractJson } from '../utils/json-utils.ts';
import { injectCurrentDate } from '../utils/inject-date.ts';
import { loadPrompt } from '../utils/prompts.ts';
import type { GeneratePlanOptions, GenerateQueriesOptions, UpdatePlanOptions } from './planning-types.ts';
import type { LLMResponseMetadata } from '../types/index.ts';
import { parseTokenUsage, calculateTotalTokens } from '../types/llm.ts';
import { metrics } from '../utils/metrics.ts';
import {
  getTeamSize,
  getQueryBudget,
  getMaxRounds,
  getComplexityGuidance,
  getEvaluatorComplexityGuidance,
  getRoundPhaseGuidance,
  parseJsonPlan,
  buildFallbackCoordinatorPlan,
  capResearcherQueries,
  generateResearchers,
} from './planning-utils.ts';

export class PlanningService implements IPlanningService {
  readonly name = 'PlanningService';
  lifecycle = ServiceLifecycle.UNINITIALIZED as ServiceLifecycle;

  private isInitialized = false;

  // Planning state
  private currentPlan: ResearchPlan | null = null;
  private queryHistory: string[] = [];
  private totalResearchersPlanned: number = 0;

  // Dependencies
  private ctx?: any;

  constructor() {
    this.lifecycle = ServiceLifecycle.UNINITIALIZED;
  }

  async initialize(ctx?: any): Promise<void> {
    if (this.isInitialized) {
      logger.debug(`[${this.name}] Already initialized`);
      return;
    }

    this.lifecycle = ServiceLifecycle.INITIALIZING;
    this.ctx = ctx;
    this.isInitialized = true;
    this.lifecycle = ServiceLifecycle.INITIALIZED;
    logger.log(`[${this.name}] Initialized`);
  }

  getName(): string {
    return this.name;
  }

  isReady(): boolean {
    return this.isInitialized;
  }

  async dispose(): Promise<void> {
    this.lifecycle = ServiceLifecycle.DISPOSING;
    this.clearPlanningState();
    this.ctx = undefined;
    this.isInitialized = false;
    this.lifecycle = ServiceLifecycle.DISPOSED;
    logger.log(`[${this.name}] Disposed`);
  }

  // ========================================================================
  // Plan Generation Methods
  // ========================================================================

  async generatePlan(options: GeneratePlanOptions): Promise<ResearchPlan> {
    const { query, complexity, model, signal, historicalLinksSection = '' } = options;

    logger.log(`[${this.name}] Generating plan for complexity ${complexity}`);
    metrics.increment('coordinator_plans_total', 1, { complexity: String(complexity) });

    const maxTeamSize = getTeamSize(complexity);
    const queryBudget = getQueryBudget(complexity);
    const complexityLabel = complexity === 1 ? 'Normal' : complexity === 2 ? 'Deep' : 'Ultra';
    const complexityGuidance = getComplexityGuidance(complexity, maxTeamSize, queryBudget);

    const basePlanningPrompt = injectCurrentDate(loadPrompt('system-coordinator', '..'), 'coordinator')
      .replace(/\{ROOT_QUERY\}/g, query)
      .replace('{MAX_TEAM_SIZE}', maxTeamSize.toString())
      .replace('{QUERY_BUDGET}', queryBudget.toString())
      .replace('{COMPLEXITY_LABEL}', complexityLabel)
      .replace('{COMPLEXITY_GUIDANCE}', complexityGuidance)
      .replace('{{historical_links_section}}', historicalLinksSection);

    const auth = await this.ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);

    logger.log(`[${this.name}] Coordinator auth for model ${model.id}: ok=${auth.ok}, hasApiKey=${!!auth.apiKey}`);

    let plan: ResearchPlan | null = null;
    let lastRawPlanText = '';

    for (let attempt = 1; attempt <= 3; attempt++) {
      const retryHint = attempt > 1 ? '\n\n**RETRY**: Your previous JSON was malformed. Ensure you return ONLY valid JSON in a code block.' : '';
      const messages: Message[] = attempt === 1
        ? [{ role: 'user', content: [{ type: 'text', text: `Please plan a research team for: "${query}"` }], timestamp: Date.now() }]
        : [];

      logger.debug(`[${this.name}] Coordinator attempt ${attempt}`);

      const planResponse = await complete(model, {
        systemPrompt: basePlanningPrompt + retryHint,
        messages,
      }, { apiKey: auth.apiKey, headers: auth.headers, signal });

      const planMetadata = planResponse as LLMResponseMetadata;
      if (planMetadata.stopReason === 'error' || planMetadata.stopReason === 'aborted') {
        const apiError = planMetadata.errorMessage || `Model API returned stop reason: ${planMetadata.stopReason}`;
        logger.error(`[${this.name}] Coordinator API call failed (attempt ${attempt}): ${apiError}`);
        metrics.increment('llm_api_errors_total', 1, { component: 'coordinator', stopReason: planMetadata.stopReason });
        throw new Error(`Coordinator model API error: ${apiError}`);
      }

      const textContent = planResponse.content.find((c): c is TextContent => c.type === 'text');
      const rawPlanText = textContent?.text || '';
      lastRawPlanText = rawPlanText;

      logger.debug(`[${this.name}] Coordinator Response:\n${rawPlanText}`);

      try {
        plan = parseJsonPlan(rawPlanText, this.name);

        if (planResponse.usage) {
          const coordUsage = parseTokenUsage(planResponse.usage);
          const tokens = calculateTotalTokens(coordUsage);
          const cost = planResponse.usage.cost?.total ?? 0;
          metrics.increment('llm_tokens_total', tokens, { component: 'coordinator', complexity: String(complexity) });
          metrics.increment('llm_cost_total', cost, { component: 'coordinator', complexity: String(complexity) });
        }

        metrics.increment('coordinator_plans_total', 1, { complexity: String(complexity), status: 'success' });
        break;
      } catch (err) {
        if (attempt >= 3) {
          logger.warn(`[${this.name}] Coordinator failed JSON parsing after 3 attempts; building fallback plan`);
          metrics.increment('coordinator_plans_total', 1, { complexity: String(complexity), status: 'fallback' });
          plan = buildFallbackCoordinatorPlan(this.name, lastRawPlanText, query);
          break;
        }
        metrics.increment('coordinator_plans_total', 1, { complexity: String(complexity), status: 'error' });
      }
    }

    if (!plan || !plan.researchers) {
      throw new Error('Coordinator failed to plan any researchers.');
    }

    // Cap team size
    if (plan.researchers.length > maxTeamSize) {
      plan.researchers = plan.researchers.slice(0, maxTeamSize);
      plan.allQueries = plan.researchers.flatMap(r => r.queries);
    }

    // Cap researcher queries
    plan = capResearcherQueries(plan, complexity, this.name);

    // Update state
    this.currentPlan = plan;
    this.totalResearchersPlanned += plan.researchers?.length ?? 0;

    logger.log(`[${this.name}] Generated plan with ${plan.researchers?.length || 0} researcher(s)`);
    metrics.observe('coordinator_researchers_planned', plan.researchers?.length || 0, { complexity: String(complexity) });

    return plan;
  }

  generateResearchers(plan: ResearchPlan, query: string, complexity: 1 | 2 | 3): ResearcherConfig[] {
    return generateResearchers(plan, query, complexity);
  }

  async generateQueries(options: GenerateQueriesOptions): Promise<string[]> {
    const { researcher } = options;
    return researcher.queries || [];
  }

  async updatePlanForRound(options: UpdatePlanOptions): Promise<ResearchPlan> {
    const {
      reports,
      round,
      query,
      complexity,
      model,
      signal,
      previousPlan,
      totalResearchersPlanned,
      mustSynthesize = false,
      historicalLinksSection = '',
    } = options;

    logger.log(`[${this.name}] Evaluating for round ${round}`);
    metrics.increment('evaluator_runs_total', 1, { complexity: String(complexity), round: String(round) });

    const previousQueriesSection = previousPlan?.allQueries && previousPlan.allQueries.length > 0
      ? `\n### Previous Queries (Sibling Researchers)\n${previousPlan.allQueries.map(q => `- ${q}`).join('\n')}\n`
      : '';

    const nextId = totalResearchersPlanned + 1;
    const maxTeamSize = getTeamSize(complexity);
    const maxRounds = getMaxRounds(complexity);

    const evalPrompt = injectCurrentDate(loadPrompt('system-lead-evaluator', '..'), 'evaluator')
      .replace(/\{ROOT_QUERY\}/g, query)
      .replace('{ROUND_NUMBER}', round.toString())
      .replace('{MAX_ROUNDS}', maxRounds.toString())
      .replace('{MAX_TEAM_SIZE}', maxTeamSize.toString())
      .replace('{QUERY_BUDGET}', getQueryBudget(complexity).toString())
      .replace('{COMPLEXITY_LABEL}', complexity === 1 ? 'Level 1 (Normal)' : complexity === 2 ? 'Level 2 (Deep)' : 'Level 3 (Ultra)')
      .replace('{COMPLEXITY_GUIDANCE}', getEvaluatorComplexityGuidance(complexity))
      .replace('{ROUND_PHASE_GUIDANCE}', getRoundPhaseGuidance(round, maxRounds, complexity))
      .replace('{{previous_queries_section}}', previousQueriesSection)
      .replace('{{historical_links_section}}', historicalLinksSection)
      .replace('{NEXT_ID}', `${nextId}`);

    const reportsText = Array.from(reports.entries())
      .map(([id, report]) => {
        const displayId = id.includes('.') ? id.split('.').slice(1).join('.') : id;
        return `### Researcher ${displayId} Report\n\n${report}`;
      })
      .join('\n\n---\n\n');

    const auth = await this.ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);

    const synthOverride = mustSynthesize
      ? '\n\n**MANDATORY — ABSOLUTE MAXIMUM REACHED**: No further research rounds are permitted. You MUST return `"action": "synthesize"` with a comprehensive synthesis in the `content` field. Do NOT return delegate.'
      : '';
    const evalUserMessage = `${evalPrompt}${synthOverride}\n\n---\n\nFindings so far:\n\n${reportsText}`;

    let text = '';
    for (let evalAttempt = 1; evalAttempt <= 2; evalAttempt++) {
      const response = await completeSimple(model, {
        messages: [{ role: 'user', content: [{ type: 'text', text: evalUserMessage }], timestamp: Date.now() }]
      }, { apiKey: auth.apiKey, headers: auth.headers, signal });

      const responseMetadata = response as LLMResponseMetadata;
      if (responseMetadata.stopReason === 'error' || responseMetadata.stopReason === 'aborted') {
        const apiError = responseMetadata.errorMessage || `Model API returned stop reason: ${responseMetadata.stopReason}`;
        logger.error(`[${this.name}] Evaluator API call failed (attempt ${evalAttempt}): ${apiError}`);
        metrics.increment('llm_api_errors_total', 1, { component: 'evaluator', stopReason: responseMetadata.stopReason });
        throw new Error(`Evaluator model API error: ${apiError}`);
      }

      const textContent = response.content.find((c): c is TextContent => c.type === 'text');
      text = textContent?.text || '';

      if (response.usage) {
        const evalUsage = parseTokenUsage(response.usage);
        const tokens = calculateTotalTokens(evalUsage);
        const cost = response.usage.cost?.total ?? 0;
        metrics.increment('llm_tokens_total', tokens, { component: 'evaluator', complexity: String(complexity) });
        metrics.increment('llm_cost_total', cost, { component: 'evaluator', complexity: String(complexity) });
      }

      if (text.trim()) break;
    }

    let extracted = extractJson<ResearchPlan>(text, 'any');
    const estimatedTokens = this.estimateTokenCount(evalUserMessage) + this.estimateTokenCount(text);
    const correctionSafe = estimatedTokens < 100_000;

    if (!extracted.success && text.trim() && correctionSafe) {
      logger.warn(`[${this.name}] Evaluator JSON parse failed; attempting self-correction`);
      const correctionMsg = `${evalUserMessage}\n\n---\n\nYOUR PREVIOUS RESPONSE (not valid JSON):\n${text}\n\n---\n\nReturn ONLY a valid JSON object now. No prose before or after.`;
      const corrResponse = await completeSimple(model, {
        messages: [{ role: 'user', content: [{ type: 'text', text: correctionMsg }], timestamp: Date.now() }]
      }, { apiKey: auth.apiKey, headers: auth.headers, signal });
      const corrText = corrResponse.content.find((c): c is TextContent => c.type === 'text');
      if (corrText?.text?.trim()) {
        extracted = extractJson<ResearchPlan>(corrText.text, 'any');
        if (extracted.success) text = corrText.text;
      }
    }

    let plan: ResearchPlan;
    if (extracted.success && extracted.value) {
      plan = extracted.value;
      if (plan.action === 'delegate') {
        if (!Array.isArray(plan.researchers)) {
          plan.action = 'synthesize';
        } else {
          plan.researchers = plan.researchers.filter(r => r && typeof r === 'object' && Array.isArray(r.queries));
          if (plan.researchers.length === 0) {
            plan.action = 'synthesize';
          } else {
            // We'll update totalResearchersPlanned in the orchestrator
          }
        }
        plan.allQueries = (plan.researchers ?? []).flatMap(r => r.queries);
      }
      if (plan.action === 'synthesize' && !plan.content) {
        plan = { action: 'synthesize', content: text, researchers: [], allQueries: [] };
      }
    } else {
      plan = { action: 'synthesize', content: text, researchers: [], allQueries: [] };
    }

    if (mustSynthesize && plan.action !== 'synthesize') {
      logger.warn(`[${this.name}] Evaluator tried to delegate despite reaching max rounds; forcing synthesis.`);
      plan.action = 'synthesize';
    }

    this.currentPlan = plan;

    return plan.action !== 'synthesize' && Array.isArray(plan.researchers) && plan.researchers.length > 0 && !mustSynthesize
      ? this.capResearcherQueries(plan, complexity)
      : plan;
  }

  // ========================================================================
  // Query History Methods
  // ========================================================================

  getQueryHistory(): string[] {
    return [...this.queryHistory];
  }

  addToQueryHistory(queries: string[]): void {
    this.queryHistory.push(...queries);
    logger.debug(`[${this.name}] Added ${queries.length} queries to history (total: ${this.queryHistory.length})`);
  }

  // ========================================================================
  // State Management Methods
  // ========================================================================

  getCurrentPlan(): ResearchPlan | null {
    return this.currentPlan;
  }

  getTotalResearchersPlanned(): number {
    return this.totalResearchersPlanned;
  }

  getTeamSize(complexity: 1 | 2 | 3): number {
    return getTeamSize(complexity);
  }

  getQueryBudget(complexity: 1 | 2 | 3): number {
    return getQueryBudget(complexity);
  }

  getComplexityGuidance(complexity: 1 | 2 | 3, maxTeamSize: number, queryBudget: number): string {
    return getComplexityGuidance(complexity, maxTeamSize, queryBudget);
  }

  getEvaluatorComplexityGuidance(complexity: 1 | 2 | 3): string {
    return getEvaluatorComplexityGuidance(complexity);
  }

  getRoundPhaseGuidance(currentRound: number, maxRounds: number, complexity: 1 | 2 | 3): string {
    return getRoundPhaseGuidance(currentRound, maxRounds, complexity);
  }

  capResearcherQueries(plan: ResearchPlan, complexity: 1 | 2 | 3): ResearchPlan {
    return capResearcherQueries(plan, complexity, this.name);
  }

  parseJsonPlan(text: string): ResearchPlan {
    return parseJsonPlan(text, this.name);
  }

  buildFallbackCoordinatorPlan(rawText: string, query: string): ResearchPlan {
    return buildFallbackCoordinatorPlan(this.name, rawText, query);
  }

  clearPlanningState(): void {
    this.currentPlan = null;
    this.queryHistory = [];
    this.totalResearchersPlanned = 0;
    logger.debug(`[${this.name}] Cleared planning state`);
  }

  // ========================================================================
  // Private Helper Methods
  // ========================================================================

  private estimateTokenCount(text: string): number {
    // Rough estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }
}