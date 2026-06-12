/**
 * Deep Research Orchestrator
 *
 * Coordinates multi-round research using specialized services.
 */

import type { ExtensionContext, AgentToolResult } from '@earendil-works/pi-coding-agent';
import { type Model } from '@earendil-works/pi-ai';
import { logger } from '../logger.ts';
import { safeUnref } from '../utils/safe-unref.ts';
import { metrics } from '../utils/metrics.ts';
import { getSteeringMessages, consumeQueuedMessages, getActiveSteeringMessages } from '../utils/session-state.ts';
import { MAX_EXTRA_ROUNDS_WITH_STEERING } from '../constants.ts';
import {
  getMaxRounds,
} from '../core/planning-utils.ts';
import type {
  ResearchObserver,
} from './research-observer.ts';
import {
  ServiceNames,
  type IResearchOrchestration,
  type ResearchPlan,
  type IKnowledgeStoreService,
  type IResearchSynthesisService,
} from '../core/service-interfaces.ts';
import { getService, tryGetServiceContainerFromCtx } from '../core/service-registry.ts';
import { getConfig } from '../config.ts';
import type { Config } from '../config.ts';
import type { PlanningService } from '../core/planning-service.ts';

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
    this.config = options.config || getConfig(options.ctx.cwd);
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
    const container = tryGetServiceContainerFromCtx(this.options.ctx);
    this.orchestrationService = await getService<IResearchOrchestration>(ServiceNames.RESEARCH_ORCHESTRATION, this.options.ctx, container);
    return this.orchestrationService;
  }

  private async getPlanningService(): Promise<PlanningService> {
    const container = tryGetServiceContainerFromCtx(this.options.ctx);
    // Pass ctx to ensure PlanningService has access to modelRegistry
    return await getService<PlanningService>(ServiceNames.PLANNING, this.options.ctx, container);
  }

  private elapsed(): string {
    const s = Math.round((Date.now() - this.startTime) / 1000);
    return `+${s}s`;
  }

  /**
   * Run the multi-round research loop
   */
  async run(signal?: AbortSignal): Promise<string> {
    const { model, query, complexity, researchId, observer, ctx } = this.options;
    const container = tryGetServiceContainerFromCtx(ctx);
    
    const orchestrationService = await this.getOrchestrationService();
    const planningService = await this.getPlanningService();

    // Reset services for this specific research run ID to ensure fresh state
    await orchestrationService.cleanupResearchServices(undefined, researchId);
    
    logger.log(`[DeepOrchestrator] Starting multi-round research (complexity ${complexity}) for: "${query}" (Run: ${researchId})`);
    metrics.increment('research_sessions_total', 1, { mode: 'deep', complexity: String(complexity) });

    // Fire onStart observer event
    observer?.onStart?.(query, complexity);

    // Consume all queued messages at the start of the research run so
    // that getQueuedSteeringMessages() below returns an accurate count
    // of NEW messages that arrived after prior research (not stale ones).
    consumeQueuedMessages(this.options.sessionId);

    // The base round budget for this complexity level, plus extra room
    // for any queued steering messages that arrived before this run
    // started (and were just consumed above). Each consumed steering
    // message unlocks one extra round, capped by
    // MAX_EXTRA_ROUNDS_WITH_STEERING. This keeps the round budget
    // concept simple (one number drives the loop) while letting the
    // user push research deeper via Alt+Enter when they have queued
    // guidance waiting to be applied.
    const baseMaxRounds = getMaxRounds(complexity);
    const queuedAtStart = getSteeringMessages(this.options.sessionId).length;
    const steeringBonusRounds = Math.min(queuedAtStart, MAX_EXTRA_ROUNDS_WITH_STEERING);
    const maxRounds = baseMaxRounds + steeringBonusRounds;
    if (steeringBonusRounds > 0) {
      logger.log(
        `[DeepOrchestrator] Extending round budget from ${baseMaxRounds} to ${maxRounds} ` +
        `(${steeringBonusRounds} extra round(s) for ${queuedAtStart} queued steering message(s), ` +
        `cap ${MAX_EXTRA_ROUNDS_WITH_STEERING})`
      );
    }

    const MAX_WAIT_RETRIES = 5;
    let waitRetryCount = 0;
    let loopSynthesisPlan: ResearchPlan | null = null;

    try {
      while (this.currentRound < maxRounds) {
        if (signal?.aborted) throw new Error('Research aborted');
        this.currentRound++;
        this.startTime = Date.now();

        // Refresh steering messages and consume any new queued ones at round start
        consumeQueuedMessages(this.options.sessionId);
        const steeringMessages = getSteeringMessages(this.options.sessionId);
        const steeringTexts = steeringMessages.map(m => m.text);

        const roundLabel = this.currentRound > baseMaxRounds
          ? `Round ${this.currentRound}/${maxRounds} (extra, steering-driven, base=${baseMaxRounds})`
          : `Round ${this.currentRound}/${maxRounds}`;
        logger.log(`[DeepOrchestrator] ${roundLabel} ${this.elapsed()}`);
        observer?.onRoundStart?.(this.currentRound);

        // Check infrastructure health (only if round > 1 or complexity > 1)
        const healthy = await orchestrationService.checkHealth(this.currentRound, researchId, ctx);
        if (!healthy && this.currentRound > 1) {
            logger.warn(`[DeepOrchestrator] Infrastructure unhealthy at Round ${this.currentRound}, attempting to continue with existing data...`);
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
                modelRegistry: ctx.modelRegistry,
                cwd: ctx.cwd,
                signal,
                observer,
                excludeTools: this.options.excludeTools,
                steeringMessages: steeringTexts,
            });
        } else {
            const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
            observer?.onEvaluationStart?.(this.currentRound);
            observer?.onEvaluationProgress?.('evaluating');
            plan = await planningService.updatePlanForRound({
                sessionId: researchId,
                query: query,
                complexity,
                round: this.currentRound,
                model,
                modelRegistry: ctx.modelRegistry,
                cwd: ctx.cwd,
                reports: synthesisService.getAllReports(researchId),
                previousPlan: planningService.getCurrentPlan(researchId),
                totalResearchersPlanned: planningService.getTotalResearchersPlanned(researchId),
                signal,
                observer,
                excludeTools: this.options.excludeTools,
                steeringMessages: steeringTexts,
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
                safeUnref(timeout);
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
        
        // 2. Search Phase + per-researcher store queries (run in parallel)
        let researcherLinks: Map<string, string[]> | undefined;
        let storeLinks: Map<string, { url: string; description: string }[]> | undefined;

        const searchTask = (plan.allQueries && plan.allQueries.length > 0)
          ? (async () => {
              observer?.onSearchStart?.(plan.allQueries!);
              const results = await orchestrationService.runSearchBurst(plan.allQueries!, this.config, signal, (links: number) => {
                  observer?.onSearchProgress?.(links);
              }, ctx);
              observer?.onSearchComplete?.(results.reduce((sum, r) => sum + (r.results?.length || 0), 0));
              researcherLinks = await orchestrationService.distributeSearchResults(plan, results);
            })()
          : Promise.resolve();

        const storeTask = ((this.config.LOCAL_KNOWLEDGE_STORE_ENABLED || this.config.GLOBAL_KNOWLEDGE_STORE_ENABLED) && plan.researchers && plan.researchers.length > 0)
          ? (async () => {
              try {
                const ksService = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, ctx, container);
                if (!ksService.isReady()) {
                  logger.debug('[DeepOrchestrator] Knowledge store service not ready, skipping per-researcher store queries');
                  return;
                }
                const store = await ksService.getStore();
                if (store && typeof store.findRelevantUrls === 'function') {
                  const storeMap = new Map<string, { url: string; description: string }[]>();
                  await Promise.all((plan.researchers ?? []).map(async (researcher) => {
                    const entries = await store.findRelevantUrls(researcher.goal, { limit: 4 });
                    if (entries.length > 0) {
                      storeMap.set(String(researcher.id), entries);
                      logger.debug(`[DeepOrchestrator] Researcher ${researcher.id}: ${entries.length} store URL(s) from goal query`);
                    }
                  }));
                  if (storeMap.size > 0) storeLinks = storeMap;
                }
              } catch (err) {
                logger.warn('[DeepOrchestrator] Per-researcher store queries failed (non-fatal):', err);
              }
            })()
          : Promise.resolve();

        await Promise.all([searchTask, storeTask]);

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
            }, researcherLinks, storeLinks);
        }

        // 4. Store synthesized descriptions for semantic search
        // Show embedding indicator in eval box while embedding runs
        observer?.onEvaluationStart?.(this.currentRound);
        observer?.onEvaluationProgress?.('embedding');
        await orchestrationService.storeLinkDescriptions(researchId, this.currentRound, researchId, this.config, ctx);

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
          // One final check for new steering messages before synthesis
          consumeQueuedMessages(this.options.sessionId);
          const finalSteeringTexts = getSteeringMessages(this.options.sessionId).map(m => m.text);

          const synthesisServiceFinal = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
          finalReport = await planningService.updatePlanForRound({
              sessionId: researchId,
              query: query,
              complexity,
              round: maxRounds,
              model,
              modelRegistry: ctx.modelRegistry,
              cwd: ctx.cwd,
              reports: synthesisServiceFinal.getAllReports(researchId),
              previousPlan: planningService.getCurrentPlan(researchId),
              totalResearchersPlanned: planningService.getTotalResearchersPlanned(researchId),
              mustSynthesize: true,
              signal,
              observer,
              excludeTools: this.options.excludeTools,
              steeringMessages: finalSteeringTexts,
          });
      }

      observer?.onEvaluationDecision?.('synthesize', finalReport, maxRounds);

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

      // Final post-processing: Ensure CITED LINKS section is accurate and consistent
      const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
      result = synthesisService.ensureCitedLinks(researchId, result);

      // Append steering guidance — only active (consumed by orchestrator) messages
      const finalSteeringMessages = getActiveSteeringMessages(this.options.sessionId);
      result = synthesisService.appendSteeringGuidance(result, finalSteeringMessages);

      // Append research metadata (model used)
      result = synthesisService.appendMetadata(result, model.id);

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

      // Attempt fallback synthesis from collected reports before re-throwing
      try {
        const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
        if (synthesisService.hasReports(researchId)) {
          let fallback = synthesisService.buildFallbackSynthesis(researchId, this.currentRound);
          fallback = synthesisService.ensureCitedLinks(researchId, fallback);
          logger.log(`[DeepOrchestrator] Returning fallback synthesis (${fallback.length} chars) from ${synthesisService.getReportCount(researchId)} collected reports`);
          const finalSteeringMessages = getActiveSteeringMessages(this.options.sessionId);
          const result = synthesisService.appendSteeringGuidance(fallback, finalSteeringMessages);
          observer?.onComplete?.(result);
          return result;
        }
      } catch (fallbackErr) {
        logger.warn(`[DeepOrchestrator] Fallback synthesis also failed:`, fallbackErr);
      }

      throw error;
    } finally {
      const orch = await this.getOrchestrationService();
      await orch.cleanupResearchServices(undefined, researchId, ctx);
    }
  }
}
