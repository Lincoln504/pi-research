/**
 * Deep Research Orchestrator (Refactored)
 *
 * This is the heart of the pi-research system. It implements a multi-round,
 * multi-agent research loop inspired by systems like OpenAI Deep Research.
 *
 * Refactored to use dedicated services:
 * - ResearchSessionService: Session lifecycle management
 * - ResearchOrchestrationService: Core orchestration logic
 * - ResearchSynthesisService: Result aggregation and synthesis
 */

import {
    type ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { type Model } from '@mariozechner/pi-ai';
import { logger } from '../logger.ts';
import { getConfig, type Config } from '../config.ts';
import { getService } from '../core/service-registry.ts';
import { ServiceNames, IKnowledgeStore } from '../core/service-interfaces.ts';
import type { PlanningService } from '../core/planning-service.ts';
import type { ResearchObserver } from './research-observer.ts';
import { metrics } from '../utils/metrics.ts';
import {
    MAX_ROUNDS_LEVEL_1,
    MAX_ROUNDS_LEVEL_2,
    MAX_ROUNDS_LEVEL_3,
    MAX_EXTRA_ROUNDS,
} from '../constants.ts';
import { ResearchOrchestrationService } from './research-orchestration-service.ts';
import {
    initializeResearchServices,
    getResearchSessionService,
    getResearchSynthesisService,
    cleanupResearchServices,
} from './research-session-manager.ts';
import { Type, type Static } from 'typebox';

const ResearcherConfigSchema = Type.Object({
    id: Type.Union([Type.String(), Type.Number()]),
    name: Type.String(),
    goal: Type.String(),
    queries: Type.Array(Type.String()),
    historicalLinks: Type.Optional(Type.Array(Type.String()))
});

const ResearchPlanSchema = Type.Object({
    action: Type.Optional(Type.Union([Type.Literal('synthesize'), Type.Literal('delegate')])),
    researchers: Type.Optional(Type.Array(ResearcherConfigSchema)),
    allQueries: Type.Optional(Type.Array(Type.String())),
    content: Type.Optional(Type.String())
});

export type ResearchPlan = Static<typeof ResearchPlanSchema>;
export type ResearcherConfig = Static<typeof ResearcherConfigSchema>;

export interface DeepResearchOrchestratorOptions {
  ctx: ExtensionContext;
  model: Model<any>;
  query: string;
  complexity: 1 | 2 | 3;
  sessionId: string;
  researchId: string;
  observer?: ResearchObserver;
  config?: Config;
}

/**
 * Deep Research Orchestrator
 *
 * Coordinates multi-round research using specialized services.
 */
export class DeepResearchOrchestrator {
  private currentRound = 0;
  private startTime: number = Date.now();
  private config: Config;
  private readonly sessionStart: number = Date.now();
  constructor(private options: DeepResearchOrchestratorOptions) {
    this.config = options.config || getConfig();
    const orchestrationService = new ResearchOrchestrationService();
    // Use instance variable
    this.orchestrationService = orchestrationService;
  }

  private orchestrationService: ResearchOrchestrationService;

  private async getPlanningService(): Promise<PlanningService> {
    return await getService<PlanningService>(ServiceNames.PLANNING);
  }

  private elapsed(): string {
    const s = Math.round((Date.now() - this.startTime) / 1000);
    return `+${s}s`;
  }

  /**
   * Run the multi-round research loop
   */
  async run(signal?: AbortSignal): Promise<string> {
    // Initialize services for this research run
    initializeResearchServices();
    const sessionService = getResearchSessionService();
    const synthesisService = getResearchSynthesisService();

    logger.log(`[Orchestrator] Starting deep research with complexity ${this.options.complexity}`);
    this.options.observer?.onStart?.(this.options.query, this.options.complexity);
    metrics.increment('research_sessions_total', 1, { mode: 'deep', complexity: String(this.options.complexity) });

    // Knowledge Store Context Injection
    let historicalLinksSection = '';
    if (this.config.KNOWLEDGE_STORE_ENABLED) {
      try {
        const store = await getService<IKnowledgeStore>(ServiceNames.KNOWLEDGE_STORE);
        const historicalUrls = await store.findRelevantUrls(this.options.query, { limit: 20 });
        if (historicalUrls.length > 0) {
          historicalLinksSection = '\n\n## Historical Knowledge Store (Discovery)\n' +
            'The following relevant URLs were found in your local knowledge store. They contain summaries of findings from previous research sessions:\n\n' +
            historicalUrls.map(u => `- ${u}`).join('\n') +
            '\n\nDistribute these historical links among your researchers for re-investigation. Researchers will retrieve a historical summary hint and the fresh full content when scraping.';
        }
      } catch (err) {
        logger.warn('[Orchestrator] Failed to fetch historical context (non-fatal):', err);
      }
    }

    const planningService = await this.getPlanningService();
    const coordStartMs = Date.now();

    try {
      // 1. Initial Planning
      this.options.observer?.onPlanningStart?.(1);

      // Generate plan using PlanningService
      let currentPlan = await planningService.generatePlan({
        query: this.options.query,
        complexity: this.options.complexity,
        model: this.options.model,
        historicalLinksSection,
        signal,
      });

      if (!currentPlan || !currentPlan.researchers) throw new Error('Coordinator failed to plan any researchers.');

      this.options.observer?.onPlanningSuccess?.(currentPlan);

      logger.log(`[Orchestrator] ${this.elapsed()} Coordinator done in ${((Date.now() - coordStartMs) / 1000).toFixed(1)}s - planned ${currentPlan.researchers?.length || 0} researcher(s)`);
      const coordDuration = Date.now() - coordStartMs;
      metrics.observe('coordinator_latency_ms', coordDuration, { complexity: String(this.options.complexity) });
      metrics.observe('coordinator_researchers_planned', currentPlan.researchers?.length || 0, { complexity: String(this.options.complexity) });

      const maxRounds = this.options.complexity === 1 ? MAX_ROUNDS_LEVEL_1 :
                           this.options.complexity === 2 ? MAX_ROUNDS_LEVEL_2 :
                           MAX_ROUNDS_LEVEL_3;
      metrics.increment('research_queries_total', currentPlan.allQueries?.length || 0, { mode: 'deep', complexity: String(this.options.complexity) });

      // Add queries to history in PlanningService
      if (currentPlan.allQueries) {
        planningService.addToQueryHistory(currentPlan.allQueries);
      }

      while (this.currentRound < maxRounds + MAX_EXTRA_ROUNDS) {
          if (signal?.aborted) throw new Error("Research aborted.");
          this.currentRound++;

          // Log health status at the start of each round for long-running research
          await this.orchestrationService.runHealthCheck(this.currentRound);

          if (!currentPlan || !currentPlan.researchers || currentPlan.researchers.length === 0) break;

          this.options.observer?.onRoundStart?.(this.currentRound);

          // 2. Search Burst
          // CRITICAL: Researchers MUST have search results. If no queries, this is an error.
          if (!currentPlan.allQueries || currentPlan.allQueries.length === 0) {
              throw new Error(`[Orchestrator] Delegated ${currentPlan.researchers?.length || 0} researchers but no queries to search. Researchers cannot run without search results.`);
          }

          const searchResults = await this.orchestrationService.runSearchBurst(
            currentPlan.allQueries,
            this.config,
            this.options.complexity,
            this.options.observer,
            signal
          );

          logger.info(`[Orchestrator] Search burst completed. Distributing results to ${currentPlan.researchers.length} researcher(s)...`);
          const researcherLinks = this.orchestrationService.distributeResults(currentPlan, searchResults);
          logger.info(`[Orchestrator] Starting ${currentPlan.researchers.length} researchers in parallel with search results...`);
          const researcherStartMs = Date.now();
          await this.orchestrationService.runResearchersParallel({
            configs: currentPlan.researchers,
            linksMap: researcherLinks,
            sessionId: this.options.sessionId,
            researchId: this.options.researchId,
            round: this.currentRound,
            query: this.options.query,
            complexity: this.options.complexity,
            ctx: this.options.ctx,
            model: this.options.model,
            researchConfig: this.config,
            planningService,
            observer: this.options.observer,
            signal,
            sessionStart: this.sessionStart,
          });
          const researcherDuration = Date.now() - researcherStartMs;
          metrics.observe('research_researcher_latency_ms', researcherDuration, { mode: 'deep', complexity: String(this.options.complexity), round: String(this.currentRound) });

          // Store researcher-generated link descriptions for vector search.
          await this.orchestrationService.storeLinkDescriptions(
            this.currentRound,
            this.options.researchId,
            this.config
          );

          const mustSynthesize = this.currentRound >= maxRounds + MAX_EXTRA_ROUNDS;
          const evaluationStartMs = Date.now();
          currentPlan = await this.evaluate(signal, mustSynthesize, planningService, synthesisService);
          const evaluationDuration = Date.now() - evaluationStartMs;
          metrics.observe('research_evaluation_latency_ms', evaluationDuration, { mode: 'deep', complexity: String(this.options.complexity), round: String(this.currentRound) });

          if (currentPlan.action === 'synthesize') {
              metrics.increment('research_synthesis_decisions_total', 1, { mode: 'deep', complexity: String(this.options.complexity), round: String(this.currentRound) });
              const synthesis = synthesisService.ensureCitedLinks(currentPlan.content || synthesisService.buildFallbackSynthesis(this.currentRound));
              this.options.observer?.onComplete?.(synthesis);
              const sessionDuration = Date.now() - this.sessionStart;
              metrics.observe('research_session_duration_ms', sessionDuration, { mode: 'deep', complexity: String(this.options.complexity), status: 'success' });
              metrics.observe('research_rounds_total', this.currentRound, { mode: 'deep', complexity: String(this.options.complexity) });
              metrics.observe('researchers_total', planningService.getTotalResearchersPlanned(), { mode: 'deep', complexity: String(this.options.complexity) });
              metrics.increment('research_sessions_total', 1, { mode: 'deep', complexity: String(this.options.complexity), status: 'success' });
              await this.cleanup(sessionService, synthesisService);
              return synthesis;
          }
          metrics.increment('research_delegation_decisions_total', 1, { mode: 'deep', complexity: String(this.options.complexity), round: String(this.currentRound) });
      }

      const finalSynthesis = synthesisService.buildFallbackSynthesis(this.currentRound);
      this.options.observer?.onComplete?.(finalSynthesis);
      const sessionDuration = Date.now() - this.sessionStart;
      metrics.observe('research_session_duration_ms', sessionDuration, { mode: 'deep', complexity: String(this.options.complexity), status: 'success' });
      metrics.observe('research_rounds_total', this.currentRound, { mode: 'deep', complexity: String(this.options.complexity) });
      metrics.observe('researchers_total', planningService.getTotalResearchersPlanned(), { mode: 'deep', complexity: String(this.options.complexity) });
      metrics.increment('research_sessions_total', 1, { mode: 'deep', complexity: String(this.options.complexity), status: 'success' });
      await this.cleanup(sessionService, synthesisService);
      return finalSynthesis;

    } catch (error) {
      if (error instanceof Error && error.message === 'Research aborted.') {
        await this.cleanup(sessionService, synthesisService);
        throw error;
      }
      const sessionDuration = Date.now() - this.sessionStart;
      metrics.observe('research_session_duration_ms', sessionDuration, { mode: 'deep', complexity: String(this.options.complexity), status: 'error' });
      metrics.observe('research_rounds_total', this.currentRound, { mode: 'deep', complexity: String(this.options.complexity) });
      metrics.increment('research_sessions_total', 1, { mode: 'deep', complexity: String(this.options.complexity), status: 'error' });
      logger.error('[Orchestrator] Run failed:', error);
      if (synthesisService.hasReports()) {
        const partial = synthesisService.buildFallbackSynthesis(this.currentRound);
        this.options.observer?.onComplete?.(partial);
        this.options.observer?.onError?.(error as Error);
        await this.cleanup(sessionService, synthesisService);
        return partial;
      }
      this.options.observer?.onError?.(error as Error);
      await this.cleanup(sessionService, synthesisService);
      return "Research failed. Check debug logs for details.";
    }
  }

  /**
   * Clean up internal state and abort all active researcher sessions.
   */
  private async cleanup(
    sessionService: ReturnType<typeof getResearchSessionService>,
    synthesisService: ReturnType<typeof getResearchSynthesisService>
  ): Promise<void> {
    await sessionService.cleanup();
    synthesisService.clearReports();
    await cleanupResearchServices();
  }

  /**
   * Evaluate researcher reports and decide whether to continue or synthesize
   */
  private async evaluate(
    signal: AbortSignal | undefined,
    mustSynthesize: boolean,
    planningService: PlanningService,
    synthesisService: ReturnType<typeof getResearchSynthesisService>
  ): Promise<ResearchPlan> {
      this.options.observer?.onEvaluationStart?.(this.currentRound);
      this.options.observer?.onEvaluationProgress?.('eval');
      metrics.increment('evaluator_runs_total', 1, { complexity: String(this.options.complexity), round: String(this.currentRound) });

      const previousPlan = planningService.getCurrentPlan();

      // Knowledge Store Context Injection for Evaluator
      let historicalLinksSection = '';
      if (this.config.KNOWLEDGE_STORE_ENABLED) {
        try {
          const store = await getService<IKnowledgeStore>(ServiceNames.KNOWLEDGE_STORE);
          const historicalUrls = await store.findRelevantUrls(this.options.query, { limit: 20 });
          if (historicalUrls.length > 0) {
            historicalLinksSection = '\n\n## Historical Knowledge Store (Discovery)\n' +
              'The following relevant URLs were found in your local knowledge store. They contain summaries of findings from previous research sessions:\n\n' +
              historicalUrls.map(u => `- ${u}`).join('\n') +
              '\n\nDistribute these historical links among your newly delegated researchers for re-investigation. Researchers will retrieve a historical summary hint and the fresh full content when scraping.';
          }
        } catch (err) {
          logger.warn('[Orchestrator] Failed to fetch historical context for evaluation (non-fatal):', err);
        }
      }

      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.model);
      if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);
      logger.log(`[Orchestrator] Evaluator auth for model ${this.options.model.id}: ok=${auth.ok}, hasApiKey=${!!auth.apiKey}, headerKeys=${JSON.stringify(Object.keys(auth.headers ?? {}))}`);

      // Use PlanningService for evaluation
      const plan = await planningService.updatePlanForRound({
        reports: synthesisService.getAllReports(),
        round: this.currentRound,
        query: this.options.query,
        complexity: this.options.complexity,
        model: this.options.model,
        signal,
        previousPlan,
        totalResearchersPlanned: planningService.getTotalResearchersPlanned(),
        mustSynthesize,
        historicalLinksSection,
      });

      // Track observer callback
      this.options.observer?.onEvaluationDecision?.(plan.action as 'synthesize' | 'delegate', plan, this.currentRound);

      // Add new queries to history
      if (plan.allQueries && plan.allQueries.length > 0) {
        planningService.addToQueryHistory(plan.allQueries);
      }

      // Handle forced synthesis fallback
      if (mustSynthesize && plan.action !== 'synthesize') {
          logger.warn('[Orchestrator] Evaluator tried to delegate despite reaching max rounds; forcing synthesis.');
          plan.action = 'synthesize';
          // When forcing synthesis from a delegation plan, the model hasn't produced
          // a synthesis report, so we must use the fallback.
          plan.content = synthesisService.buildFallbackSynthesis(this.currentRound);
      }

      return plan;
  }
}