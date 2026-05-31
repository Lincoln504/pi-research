/**
 * Deep Research Orchestrator
 *
 * Coordinates multi-round research using specialized services.
 */

import type { ExtensionContext, AgentToolResult } from '@earendil-works/pi-coding-agent';
import { type Model } from '@earendil-works/pi-ai';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import {
  getMaxRounds,
} from '../core/planning-utils.ts';
import type {
  ResearchObserver,
} from './research-observer.ts';
import {
  getResearchSynthesisService,
  cleanupResearchServices,
  resetResearchServices,
} from './research-session-manager.ts';
import {
  ServiceNames,
} from '../core/service-interfaces.ts';
import { getService } from '../core/service-registry.ts';
import { getConfig } from '../config.ts';
import type { Config } from '../config.ts';
import type { PlanningService } from '../core/planning-service.ts';
import type { IResearchOrchestration, ResearchPlan } from '../core/service-interfaces.ts';

export interface DeepResearchOrchestratorOptions {
  ctx: ExtensionContext;
  model: Model<any>;
  query: string;
  complexity: 1 | 2 | 3;
  sessionId: string;
  researchId: string;
  observer?: ResearchObserver;
  onUpdate?: (update: AgentToolResult<any>) => void;
  config?: Config;
  orchestrationService?: IResearchOrchestration;
  excludeTools?: string[];
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
  private orchestrationService: IResearchOrchestration | null = null;

  constructor(private options: DeepResearchOrchestratorOptions) {
    this.config = options.config || getConfig();
    if (options.orchestrationService) {
      this.orchestrationService = options.orchestrationService;
    }
    // Validate that ctx is available
    if (!options.ctx) {
      throw new Error('DeepResearchOrchestrator requires ExtensionContext (ctx) to be provided');
    }
  }

  private async getOrchestrationService(): Promise<IResearchOrchestration> {
    if (this.orchestrationService) return this.orchestrationService;
    this.orchestrationService = await getService<IResearchOrchestration>(ServiceNames.RESEARCH_ORCHESTRATION);
    return this.orchestrationService;
  }

  private async getPlanningService(): Promise<PlanningService> {
    // Pass ctx to ensure PlanningService has access to modelRegistry
    return await getService<PlanningService>(ServiceNames.PLANNING, this.options.ctx);
  }

  private elapsed(): string {
    const s = Math.round((Date.now() - this.startTime) / 1000);
    return `+${s}s`;
  }

  /**
   * Run the multi-round research loop
   */
  async run(signal?: AbortSignal): Promise<string> {
    const { model, query, complexity, researchId, observer } = this.options;
    
    // Reset services for this specific research run ID to ensure fresh state
    await resetResearchServices(researchId);
    
    const orchestrationService = await this.getOrchestrationService();
    const planningService = await this.getPlanningService();

    logger.log(`[DeepOrchestrator] Starting multi-round research (complexity ${complexity}) for: "${query}" (Run: ${researchId})`);
    metrics.increment('research_sessions_total', 1, { mode: 'deep', complexity: String(complexity) });

    // Fire onStart observer event
    observer?.onStart?.(query, complexity);

    const maxRounds = getMaxRounds(complexity);
    const MAX_WAIT_RETRIES = 5;
    let waitRetryCount = 0;
    let loopSynthesisPlan: ResearchPlan | null = null;
    // Persisted across rounds so the final forced-synthesis call can reuse the last value.
    let historicalLinksSection = '';

    try {
      while (this.currentRound < maxRounds) {
        if (signal?.aborted) throw new Error('Research aborted');
        this.currentRound++;
        this.startTime = Date.now();

        logger.log(`[DeepOrchestrator] Round ${this.currentRound}/${maxRounds} ${this.elapsed()}`);
        observer?.onRoundStart?.(this.currentRound);

        // Check infrastructure health (only if round > 1 or complexity > 1)
        const healthy = await orchestrationService.checkHealth(this.currentRound, researchId);
        if (!healthy && this.currentRound > 1) {
            logger.warn(`[DeepOrchestrator] Infrastructure unhealthy at Round ${this.currentRound}, attempting to continue with existing data...`);
        }

        // Query the knowledge store once per round so the coordinator/evaluator can
        // distribute previously-discovered URLs to researchers via historicalLinks.
        historicalLinksSection = '';
        if (this.config.KNOWLEDGE_STORE_ENABLED) {
          try {
            const knowledgeStoreService = await getService<any>(ServiceNames.KNOWLEDGE_STORE);
            if (knowledgeStoreService) {
              const store = typeof knowledgeStoreService.getStore === 'function'
                ? await knowledgeStoreService.getStore()
                : knowledgeStoreService;
              if (store && typeof store.findRelevantUrls === 'function') {
                const historicalUrls: string[] = await store.findRelevantUrls(query, { limit: 10 });
                if (historicalUrls.length > 0) {
                  historicalLinksSection = '## Historical Knowledge Store\n' +
                    'The following URLs are from previous research sessions on related topics. ' +
                    'Assign them via the `historicalLinks` field to the most relevant researchers:\n' +
                    historicalUrls.map(u => `- ${u}`).join('\n');
                  logger.debug(`[DeepOrchestrator] Injecting ${historicalUrls.length} historical URL(s) into round ${this.currentRound} plan`);
                }
              }
            }
          } catch (err) {
            logger.warn('[DeepOrchestrator] Failed to fetch historical URLs (non-fatal):', err);
          }
        }

        // 1. Update/Generate Plan
        let plan: ResearchPlan;
        if (this.currentRound === 1) {
            observer?.onPlanningStart?.(1);
            observer?.onPlanningProgress?.('planning');
            plan = await planningService.generatePlan({
                sessionId: researchId,
                query,
                complexity,
                model,
                signal,
                observer,
                historicalLinksSection,
                excludeTools: this.options.excludeTools,
            });
        } else {
            const synthesisService = await getResearchSynthesisService();
            observer?.onEvaluationStart?.(this.currentRound);
            observer?.onEvaluationProgress?.('evaluating');
            plan = await planningService.updatePlanForRound({
                sessionId: researchId,
                query: query,
                complexity,
                round: this.currentRound,
                model,
                reports: synthesisService.getAllReports(researchId),
                previousPlan: planningService.getCurrentPlan(researchId),
                totalResearchersPlanned: planningService.getTotalResearchersPlanned(researchId),
                signal,
                observer,
                historicalLinksSection,
                excludeTools: this.options.excludeTools,
            });
        }
        
        if (plan.action === 'delegate') {
          if (this.currentRound === 1) {
            observer?.onPlanningSuccess?.(plan);
          } else {
            observer?.onEvaluationDecision?.('delegate', plan, this.currentRound);
          }
        }
        
        if (plan.action === 'synthesize' || this.currentRound >= maxRounds) {
            logger.log(`[DeepOrchestrator] Synthesis phase reached at Round ${this.currentRound} ${this.elapsed()}`);
            if (plan.action === 'synthesize') {
                loopSynthesisPlan = plan;
                observer?.onEvaluationDecision?.('synthesize', plan, this.currentRound);
            }
            break;
        }

        if (plan.action === 'wait') {
            waitRetryCount++;
            observer?.onPlanningProgress?.('planning');
            if (waitRetryCount > MAX_WAIT_RETRIES) {
                logger.error(`[DeepOrchestrator] Max wait retries (${MAX_WAIT_RETRIES}) exceeded at Round ${this.currentRound}, stopping research`);
                observer?.onError?.(new Error('Max wait retries exceeded'));
                throw new Error(`Max wait retries (${MAX_WAIT_RETRIES}) exceeded. The research coordinator was unable to proceed after multiple wait requests.`);
            }
            logger.debug(`[DeepOrchestrator] AI requested wait, retrying Round ${this.currentRound} in 5s (retry ${waitRetryCount}/${MAX_WAIT_RETRIES})...`);
            
            // Abortable sleep
            if (signal?.aborted) {
                throw new Error('Research cancelled');
            }
            await new Promise<void>((resolve, reject) => {
                const onAbort = () => {
                    clearTimeout(timeout);
                    reject(new Error('Research cancelled'));
                };
                const timeout = setTimeout(() => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                }, 5000);
                if ((timeout as any).unref) (timeout as any).unref();
                signal?.addEventListener('abort', onAbort, { once: true });
            });
            
            this.currentRound--; // Retry this round
            continue;
        }

        // Reset wait retry counter on successful actions
        waitRetryCount = 0;

        // Track how many researchers were planned this round
        // updatePlanForRound has a comment "We'll update totalResearchersPlanned in the orchestrator"
        if (plan.action === 'delegate' && plan.researchers && plan.researchers.length > 0) {
            planningService.incrementTotalResearchersPlanned(researchId, plan.researchers.length);
        }

        // Record all queries used this round for cross-round deduplication
        if (plan.allQueries && plan.allQueries.length > 0) {
            planningService.addToQueryHistory(researchId, plan.allQueries);
        }
        
        // 2. Search Phase (if queries generated)
        let researcherLinks: Map<string, string[]> | undefined;
        if (plan.allQueries && plan.allQueries.length > 0) {
            observer?.onSearchStart?.(plan.allQueries);
            const results = await orchestrationService.runSearchBurst(plan.allQueries, this.config, signal, (links: number) => {
                observer?.onSearchProgress?.(links);
            });
            observer?.onSearchComplete?.(results.reduce((sum, r) => sum + (r.results?.length || 0), 0));
            researcherLinks = await orchestrationService.distributeSearchResults(plan, results);
        }

        // 3. Researcher Phase
        if (plan.researchers && plan.researchers.length > 0) {
            // Pass this.config (the resolved Config) rather than this.options (where
            // options.config may be undefined). runResearcher accesses researchConfig.RESEARCHER_MAX_RETRIES
            // and similar fields — passing undefined crashes immediately.
            // Default excludeTools to ['grep'] if not explicitly set — mirrors QuickResearchOrchestrator
            // so that advanced reasoning models can't waste time on developer-only tools.
            await orchestrationService.runResearchers({
                plan,
                options: {
                    ...this.options,
                    config: this.config,
                    excludeTools: this.options.excludeTools || ['grep'],
                },
                currentRound: this.currentRound,
                signal
            }, researcherLinks);
        }

        // 4. Store synthesized descriptions for semantic search
        // Show embedding indicator in eval box while embedding runs
        observer?.onEvaluationStart?.(this.currentRound);
        observer?.onEvaluationProgress?.('embedding');
        await orchestrationService.storeLinkDescriptions(researchId, this.currentRound, researchId, this.config);

        // 5. Evaluation Phase
        observer?.onEvaluationProgress?.('evaluating');
      }

      // Final Synthesis — reuse the plan from the loop if the evaluator already
      // decided to synthesize (avoids a second full LLM call). Only call the
      // evaluator again when the loop ended because maxRounds was hit without
      // the evaluator explicitly choosing to synthesize.
      logger.log(`[DeepOrchestrator] Final synthesis ${this.elapsed()}`);
      observer?.onRoundStart?.(maxRounds + 1); // Progress indicator for synthesis
      observer?.onEvaluationStart?.(maxRounds);
      observer?.onEvaluationProgress?.('evaluating');

      let finalReport: ResearchPlan;
      if (loopSynthesisPlan !== null) {
          finalReport = loopSynthesisPlan;
      } else {
          const synthesisServiceFinal = await getResearchSynthesisService();
          finalReport = await planningService.updatePlanForRound({
              sessionId: researchId,
              query: query,
              complexity,
              round: maxRounds,
              model,
              reports: synthesisServiceFinal.getAllReports(researchId),
              previousPlan: planningService.getCurrentPlan(researchId),
              totalResearchersPlanned: planningService.getTotalResearchersPlanned(researchId),
              mustSynthesize: true,
              signal,
              observer,
              historicalLinksSection,
              excludeTools: this.options.excludeTools,
          });
          observer?.onEvaluationDecision?.('synthesize', finalReport, maxRounds);
      }

      let result = finalReport.content || 'Research completed but no summary was generated.';
      // Guard: if the LLM returned the full JSON envelope as its response text and JSON
      // parsing failed upstream, finalReport.content may be the raw JSON string rather
      // than the extracted markdown. Unwrap it here so docs never show the raw JSON.
      try {
        const parsed: unknown = JSON.parse(result);
        if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>)['content'] === 'string') {
          result = (parsed as Record<string, unknown>)['content'] as string;
        }
      } catch { /* result is not JSON — use as-is */ }
      const sessionDuration = Date.now() - this.sessionStart;
      metrics.observe('research_session_duration_ms', sessionDuration, { mode: 'deep', complexity: String(complexity), status: 'success' });
      
      // Fire onComplete observer event
      observer?.onComplete?.(result);
      
      return result;

    } catch (error) {
      const sessionDuration = Date.now() - this.sessionStart;
      metrics.observe('research_session_duration_ms', sessionDuration, { mode: 'deep', complexity: String(complexity), status: 'error' });
      logger.error(`[DeepOrchestrator] Research failed: ${error instanceof Error ? error.message : String(error)}`);
      observer?.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      await cleanupResearchServices(researchId);
    }
  }
}
