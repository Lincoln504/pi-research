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
import { complete, completeSimple, calculateCost, type TextContent, type Message, type ThinkingLevel } from '@earendil-works/pi-ai';
import { extractJson } from '../utils/json-utils.ts';
import { repairJsonWithLlm } from '../utils/agentic-repair.ts';
import { injectCurrentDate } from '../utils/inject-date.ts';
import { loadPrompt } from '../utils/prompts.ts';
import type { GeneratePlanOptions, GenerateQueriesOptions, UpdatePlanOptions } from './interfaces/planning-interfaces.ts';
import { ResearchPlanSchema } from './interfaces/planning-interfaces.ts';
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

interface PlanningState {
  currentPlan: ResearchPlan | null;
  queryHistory: string[];
  totalResearchersPlanned: number;
}

export class PlanningService implements IPlanningService {
  readonly name = 'PlanningService';
  lifecycle = ServiceLifecycle.UNINITIALIZED as ServiceLifecycle;

  // Planning state mapped by sessionId
  private sessions = new Map<string, PlanningState>();

  // Dependencies
  private ctx?: any;

  constructor() {
    this.lifecycle = ServiceLifecycle.UNINITIALIZED;
  }

  private getState(sessionId: string): PlanningState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { currentPlan: null, queryHistory: [], totalResearchersPlanned: 0 };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  async initialize(ctx?: any): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.INITIALIZED && !ctx) {
      logger.debug(`[${this.name}] Already initialized`);
      return;
    }

    if (ctx) {
      this.ctx = ctx;
    }

    this.lifecycle = ServiceLifecycle.INITIALIZING;
    this.lifecycle = ServiceLifecycle.INITIALIZED;
    logger.log(`[${this.name}] Initialized`);
  }

  getName(): string {
    return this.name;
  }

  isReady(): boolean {
    return this.lifecycle === ServiceLifecycle.INITIALIZED;
  }

  async dispose(): Promise<void> {
    this.lifecycle = ServiceLifecycle.DISPOSING;
    this.sessions.clear();
    this.ctx = undefined;
    this.lifecycle = ServiceLifecycle.DISPOSED;
    logger.log(`[${this.name}] Disposed`);
  }

  // ========================================================================
  // Plan Generation Methods
  // ========================================================================

  async generatePlan(options: GeneratePlanOptions): Promise<ResearchPlan> {
    const { sessionId, query, complexity, model, signal, historicalLinksSection = '' } = options;

    logger.log(`[${this.name}] Generating plan for complexity ${complexity} (Session: ${sessionId})`);
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
      .replace('{{historical_links_section}}', historicalLinksSection)
      .replace('{{disabled_tools_section}}', options.excludeTools && options.excludeTools.length > 0
          ? `\n### DISABLED TOOLS\nThe following internal research tools are currently DISABLED and MUST NOT be used in your plan: ${options.excludeTools.join(', ')}\n`
          : '');

    if (!this.ctx) throw new Error(`[${this.name}] Not initialized with ctx — call initialize(ctx) before generating plans`);
    const auth = await this.ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);

    logger.log(`[${this.name}] Coordinator auth for model ${model.id}: ok=${auth.ok}, hasApiKey=${!!auth.apiKey}`);

    let plan: ResearchPlan | null = null;
    let lastRawPlanText!: string;

    const coordUserMessage = `Please plan a research team for: "${query}"`;

    for (let attempt = 1; attempt <= 3; attempt++) {
      options.observer?.onPlanningStart?.(attempt);
      const retryHint = attempt > 1 ? '\n\n**RETRY**: Your previous JSON was malformed. Ensure you return ONLY valid JSON in a code block.' : '';
      const messages: Message[] = attempt === 1
        ? [{ role: 'user', content: [{ type: 'text', text: coordUserMessage }], timestamp: Date.now() }]
        : [];

      logger.debug(`[${this.name}] Coordinator attempt ${attempt}`);
      options.observer?.onPlanningProgress?.(attempt > 1 ? `planning (retry ${attempt - 1})` : 'planning');

      const reasoning: ThinkingLevel = 'medium';

      try {
        const planResponse = await complete(model, {
          systemPrompt: basePlanningPrompt + retryHint,
          messages,
        }, { 
          apiKey: auth.apiKey, 
          headers: auth.headers, 
          signal,
          ...({ reasoning } as any)
        });

        const planMetadata = planResponse as LLMResponseMetadata;
        if (planMetadata.stopReason === 'error' || planMetadata.stopReason === 'aborted') {
          const apiError = planMetadata.errorMessage || `Model API returned stop reason: ${planMetadata.stopReason}`;
          logger.error(`[${this.name}] Coordinator API call failed (attempt ${attempt}): ${apiError}`);
          metrics.increment('llm_api_errors_total', 1, { component: 'coordinator', stopReason: planMetadata.stopReason });
          if (attempt >= 3) throw new Error(`Coordinator model API error: ${apiError}`);
          continue;
        }

        const textContent = planResponse.content.find((c): c is TextContent => c.type === 'text');
        const thinkingContent = (planResponse.content as any[]).find((c): c is { type: 'thinking', thinking: string } => c.type === 'thinking');
        
        if (thinkingContent?.thinking) {
          logger.debug(`[${this.name}] Coordinator Thinking:\n${thinkingContent.thinking}`);
        }

        const rawPlanText = textContent?.text || '';
        lastRawPlanText = rawPlanText;

        logger.debug(`[${this.name}] Coordinator Response:\n${rawPlanText}`);

        try {
          plan = parseJsonPlan(rawPlanText);

          if (planResponse.usage) {
            const coordUsage = parseTokenUsage(planResponse.usage);
            const tokens = calculateTotalTokens(coordUsage);
            
            let cost = coordUsage.cost?.total ?? planResponse.usage.cost?.total ?? 0;
            if (cost === 0 && tokens > 0) {
                const calculatedCost = calculateCost(model, planResponse.usage);
                cost = calculatedCost.total;
            }

            metrics.increment('llm_tokens_total', tokens, { component: 'coordinator', complexity: String(complexity) });
            metrics.increment('llm_cost_total', cost, { component: 'coordinator', complexity: String(complexity) });
            options.observer?.onPlanningTokens?.(tokens, cost);
          }

          metrics.increment('coordinator_plans_total', 1, { complexity: String(complexity), status: 'success' });
          options.observer?.onPlanningSuccess?.(plan);
          break;
        } catch (_err) {
          // Attempt agentic salvage
          const salvaged = await repairJsonWithLlm<ResearchPlan>(rawPlanText, completeSimple, auth, {
            model,
            context: coordUserMessage,
            schema: ResearchPlanSchema,
            serviceName: this.name,
            signal
          });

          if (salvaged) {
            plan = salvaged;
            metrics.increment('coordinator_plans_total', 1, { complexity: String(complexity), status: 'salvaged' });
            options.observer?.onPlanningSuccess?.(plan);
            break;
          }

          if (attempt >= 3) {
            logger.warn(`[${this.name}] Coordinator failed JSON parsing after 3 attempts; building fallback plan`);
            metrics.increment('coordinator_plans_total', 1, { complexity: String(complexity), status: 'fallback' });
            plan = buildFallbackCoordinatorPlan(this.name, lastRawPlanText, query);
            break;
          }
          metrics.increment('coordinator_plans_total', 1, { complexity: String(complexity), status: 'error' });
        }
      } catch (err) {
        logger.error(`[${this.name}] Coordinator unexpected error (attempt ${attempt}):`, err);
        if (attempt >= 3) throw err;
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!plan || !plan.researchers) {
      throw new Error('Coordinator failed to plan any researchers.');
    }

    if (plan.researchers.length > maxTeamSize) {
      plan.researchers = plan.researchers.slice(0, maxTeamSize);
      plan.allQueries = plan.researchers.flatMap(r => r.queries);
    }

    plan = capResearcherQueries(plan, complexity, this.name);

    const state = this.getState(sessionId);
    state.currentPlan = plan;
    state.totalResearchersPlanned += plan.researchers?.length ?? 0;

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
      sessionId,
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
      observer,
    } = options;

    logger.log(`[${this.name}] Evaluating for round ${round} (Session: ${sessionId})`);
    metrics.increment('evaluator_runs_total', 1, { complexity: String(complexity), round: String(round) });
    
    observer?.onEvaluationStart?.(round);
    observer?.onEvaluationProgress?.(round > 1 ? 'evaluating' : 'planning');

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
      .replace('{{disabled_tools_section}}', options.excludeTools && options.excludeTools.length > 0
          ? `\n### DISABLED TOOLS\nThe following internal research tools are currently DISABLED and MUST NOT be used in your plan: ${options.excludeTools.join(', ')}\n`
          : '')
      .replace('{NEXT_ID}', `${nextId}`);

    const reportsText = Array.from(reports.entries())
      .map(([id, report]) => {
        const displayId = id.includes('.') ? id.split('.').slice(1).join('.') : id;
        return `### Researcher ${displayId} Report\n\n${report}`;
      })
      .join('\n\n---\n\n');

    if (!this.ctx) throw new Error(`[${this.name}] Not initialized with ctx — call initialize(ctx) before updating plans`);
    const auth = await this.ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);

    const synthOverride = mustSynthesize
      ? '\n\n**MANDATORY — ABSOLUTE MAXIMUM REACHED**: No further research rounds are permitted. You MUST return `"action": "synthesize"` with a comprehensive synthesis in the `content` field. Do NOT return delegate.'
      : '';
    const evalUserMessage = `${evalPrompt}${synthOverride}\n\n---\n\nFindings so far:\n\n${reportsText}`;

    let text = '';
    let lastEvalError: any = null;

    for (let evalAttempt = 1; evalAttempt <= 2; evalAttempt++) {
      try {
        const response = await completeSimple(model, {
          messages: [{ role: 'user', content: [{ type: 'text', text: evalUserMessage }], timestamp: Date.now() }],
        }, { apiKey: auth.apiKey, headers: auth.headers, signal });

        const responseMetadata = response as LLMResponseMetadata;
        if (responseMetadata.stopReason === 'error' || responseMetadata.stopReason === 'aborted') {
          const apiError = responseMetadata.errorMessage || `Model API returned stop reason: ${responseMetadata.stopReason}`;
          logger.error(`[${this.name}] Evaluator API call failed (attempt ${evalAttempt}): ${apiError}`);
          metrics.increment('llm_api_errors_total', 1, { component: 'evaluator', stopReason: responseMetadata.stopReason });
          lastEvalError = new Error(`Evaluator model API error: ${apiError}`);
          continue; // Retry on API error
        }

        const textContent = response.content.find((c): c is TextContent => c.type === 'text');
        const thinkingContent = (response.content as any[]).find((c): c is { type: 'thinking', thinking: string } => c.type === 'thinking');
        
        if (thinkingContent?.thinking) {
          logger.debug(`[${this.name}] Evaluator Thinking:\n${thinkingContent.thinking}`);
          observer?.onPlanningProgress?.('thinking');
        }

        text = textContent?.text || '';

        if (response.usage) {
          const evalUsage = parseTokenUsage(response.usage);
          const tokens = calculateTotalTokens(evalUsage);
          
          let cost = evalUsage.cost?.total ?? response.usage.cost?.total ?? 0;
          if (cost === 0 && tokens > 0) {
              const calculatedCost = calculateCost(model, response.usage);
              cost = calculatedCost.total;
          }

          metrics.increment('llm_tokens_total', tokens, { component: 'evaluator', complexity: String(complexity) });
          metrics.increment('llm_cost_total', cost, { component: 'evaluator', complexity: String(complexity) });
          
          observer?.onEvaluationTokens?.(tokens, cost);
          observer?.onTokensConsumed?.(tokens, cost);
        }

        if (text.trim()) break;
      } catch (err) {
        logger.error(`[${this.name}] Evaluator unexpected error (attempt ${evalAttempt}):`, err);
        lastEvalError = err;
        if (evalAttempt >= 2) throw err;
        // Small delay before retry
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!text.trim() && lastEvalError) {
      throw lastEvalError;
    }

    let extracted = extractJson<ResearchPlan>(text, 'any');
    
    if (!extracted.success && text.trim()) {
      const salvaged = await repairJsonWithLlm<ResearchPlan>(text, completeSimple, auth, {
        model,
        context: evalUserMessage,
        schema: ResearchPlanSchema,
        serviceName: this.name,
        signal
      });
      if (salvaged) {
        extracted = { success: true, value: salvaged, method: 'raw-object' };
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
          }
        }
        plan.allQueries = (plan.researchers ?? []).flatMap(r => r.queries);
      }
      
      // If synthesizing, ensure we have a clean content string
      if (plan.action === 'synthesize') {
        if (!plan.content) {
            // Fall back to stripped text if content missing from valid JSON
            plan.content = this.stripModelArtifacts(text);
        } else {
            // Clean up content field itself if it contains JSON/MD wrappers
            plan.content = this.stripModelArtifacts(plan.content);
        }
      }
    } else {
      // JSON failed - assume synthesis if text present, or use whole text as fallback
      plan = { 
        action: 'synthesize', 
        content: this.stripModelArtifacts(text), 
        researchers: [], 
        allQueries: [] 
      };
    }

    if (mustSynthesize && plan.action !== 'synthesize') {
      logger.warn(`[${this.name}] Evaluator tried to delegate despite reaching max rounds; forcing synthesis.`);
      plan.action = 'synthesize';
      if (!plan.content) {
        plan.content = this.stripModelArtifacts(text);
      }
    }

    observer?.onEvaluationDecision?.(plan.action as 'synthesize' | 'delegate', plan, round);

    this.getState(sessionId).currentPlan = plan;

    return plan.action !== 'synthesize' && Array.isArray(plan.researchers) && plan.researchers.length > 0 && !mustSynthesize
      ? this.capResearcherQueries(plan, complexity)
      : plan;
  }

  // ========================================================================
  // Query History Methods
  // ========================================================================

  getQueryHistory(sessionId: string): string[] {
    return [...this.getState(sessionId).queryHistory];
  }

  addToQueryHistory(sessionId: string, queries: string[]): void {
    const state = this.getState(sessionId);
    state.queryHistory.push(...queries);
    logger.debug(`[${this.name}] Added ${queries.length} queries to history (total: ${state.queryHistory.length}) for session ${sessionId}`);
  }

  // ========================================================================
  // State Management Methods
  // ========================================================================

  getCurrentPlan(sessionId: string): ResearchPlan | null {
    return this.getState(sessionId).currentPlan;
  }

  getTotalResearchersPlanned(sessionId: string): number {
    return this.getState(sessionId).totalResearchersPlanned;
  }

  incrementTotalResearchersPlanned(sessionId: string, count: number): void {
    const state = this.getState(sessionId);
    state.totalResearchersPlanned += count;
    logger.debug(`[${this.name}] totalResearchersPlanned incremented to ${state.totalResearchersPlanned} for session ${sessionId}`);
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
    return parseJsonPlan(text);
  }

  buildFallbackCoordinatorPlan(rawText: string, query: string): ResearchPlan {
    return buildFallbackCoordinatorPlan(this.name, rawText, query);
  }

  clearPlanningState(sessionId?: string): void {
    if (sessionId) {
      this.sessions.delete(sessionId);
      logger.debug(`[${this.name}] Cleared planning state for session ${sessionId}`);
    } else {
      this.sessions.clear();
      logger.debug(`[${this.name}] Cleared all planning state`);
    }
  }

  // ========================================================================
  // Private Helper Methods
  // ========================================================================

  /**
   * Strip LLM internal artifacts from text (Thinking blocks, JSON code blocks, etc.)
   */
  private stripModelArtifacts(text: string): string {
    if (!text) return '';

    let cleaned = text;

    // 1. Remove thinking blocks if any (e.g., <thinking>...</thinking>)
    cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');

    // 2. Remove JSON code block wrappers if they wrap the whole content or parts of it
    // Search for the longest non-empty markdown text if JSON was the main envelope
    const jsonBlockMatch = /```json\s*([\s\S]*?)\s*```/gi;
    const blocks = Array.from(cleaned.matchAll(jsonBlockMatch));
    
    if (blocks.length > 0) {
        // If there's a content field inside the JSON, we prefer that, 
        // but this method is used when JSON parsing itself failed or is being bypassed.
        // For now, remove all json blocks to see if there's prose outside.
        cleaned = cleaned.replace(jsonBlockMatch, '');
    }

    // 3. Remove other code blocks that might be wrappers
    cleaned = cleaned.replace(/```markdown\s*([\s\S]*?)\s*```/gi, '$1');
    cleaned = cleaned.replace(/```\s*([\s\S]*?)\s*```/gi, '$1');

    return cleaned.trim();
  }
}