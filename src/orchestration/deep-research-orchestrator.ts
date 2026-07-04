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
import { getSteeringMessages, consumeQueuedMessages, getActiveSteeringMessages, getFailedResearchers, getResearcherFailureReasons } from './session-state.ts';
import { MAX_EXTRA_ROUNDS_WITH_STEERING } from '../constants.ts';
import {
  getMaxRounds,
} from '../core/planning-utils.ts';
import type {
  ResearchObserver,
} from '../core/interfaces/observer-interfaces.ts';
import { HeadlessObserver, type HeadlessObserverOptions } from './headless-observer.ts';
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
  observer?: ResearchObserver | HeadlessObserverOptions;
  onUpdate?: (update: AgentToolResult<any>) => void;
  config?: Config;
  orchestrationService?: IResearchOrchestration;
  excludeTools?: string[];
  initialLinks?: string[];
}

/**
 * Deep Research Orchestrator
 *
 * Coordinates multi-round research using specialized services.
 */
export class DeepResearchOrchestrator {
  private currentRound = 0;
  private observer: ResearchObserver | undefined;
  private startTime: number = Date.now();
  private config: Config;
  private readonly sessionStart: number = Date.now();
  private orchestrationService: IResearchOrchestration | null = null;

  constructor(private options: DeepResearchOrchestratorOptions) {
    this.config = options.config || getConfig(options.ctx.cwd);
    
    // Resolve observer: if options were provided instead of an instance, create the instance
    if (options.observer && typeof (options.observer as any).onProgress === 'function' && !(options.observer instanceof HeadlessObserver)) {
       this.observer = new HeadlessObserver(options.observer as HeadlessObserverOptions);
    } else {
       this.observer = options.observer as ResearchObserver | undefined;
    }

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
    const { model, query, complexity, researchId, ctx } = this.options;
    const observer = this.observer;
    const container = tryGetServiceContainerFromCtx(ctx);

    // RESEARCH_MODEL contract (config.ts): the coordinator and evaluator always
    // use the caller's model (ctx.model); RESEARCH_MODEL overrides only the
    // researcher sub-agents. `model` is the resolved research model — it equals
    // ctx.model on the SDK/CLI path, but on the pi-tool path it is the
    // RESEARCH_MODEL override, so planning must key off ctx.model explicitly.
    // Fall back to `model` when the host exposes no ctx.model.
    const coordinatorModel = (ctx.model as Model<any> | undefined) ?? model;
    
    const orchestrationService = await this.getOrchestrationService();
    const planningService = await this.getPlanningService();

    // Reset services for this specific research run ID to ensure fresh state.
    // Pass ctx so the reset targets the SAME (ctx-scoped) container the run resolves
    // its services from — otherwise it clears state on, and runs the knowledge-store
    // FTS/optimize pass against, the global container instead (see the finally below,
    // which already passes ctx).
    await orchestrationService.cleanupResearchServices(undefined, researchId, ctx, this.config);
    
    logger.log(`[DeepOrchestrator] Starting multi-round research (complexity ${complexity}) for: "${query}" (Run: ${researchId})`);
    metrics.increment('research_sessions_total', 1, { mode: 'deep', complexity: String(complexity) });

    // Fire onStart observer event
    observer?.onStart?.(query, complexity);

    // Consume all queued messages at the start of the research run. The
    // returned list is exactly the messages that were 'queued' for THIS run
    // (transitioned queued->active here); use its length below rather than
    // getSteeringMessages(), which also counts 'active' messages left over
    // from prior runs and would inflate the steering round bonus.
    const consumedAtStart = consumeQueuedMessages(this.options.sessionId);

    // The base round budget for this complexity level, plus extra room
    // for any queued steering messages that arrived before this run
    // started (and were just consumed above). Each consumed steering
    // message unlocks one extra round, capped by
    // MAX_EXTRA_ROUNDS_WITH_STEERING. This keeps the round budget
    // concept simple (one number drives the loop) while letting the
    // user push research deeper via Alt+Enter when they have queued
    // guidance waiting to be applied.
    const baseMaxRounds = getMaxRounds(complexity);
    const queuedAtStart = consumedAtStart.length;
    const steeringBonusRounds = Math.min(queuedAtStart, MAX_EXTRA_ROUNDS_WITH_STEERING);
    let maxRounds = baseMaxRounds + steeringBonusRounds;
    // Track total steering-driven extra rounds already granted.
    // New steering consumed mid-run can add more budget up to the cap.
    let totalSteeringExtraRounds = steeringBonusRounds;
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
        const beforeConsume = getSteeringMessages(this.options.sessionId).filter(m => m.status === 'active').length;
        consumeQueuedMessages(this.options.sessionId);
        const steeringMessages = getSteeringMessages(this.options.sessionId);
        const steeringTexts = steeringMessages.map(m => m.text);

        // Dynamically extend round budget when new steering messages are consumed mid-run.
        // The initial budget only accounts for messages present at research start;
        // messages entered mid-research need fresh budget so the evaluator can act on them.
        const newlyConsumed = steeringMessages.filter(m => m.status === 'active').length - beforeConsume;
        if (newlyConsumed > 0 && totalSteeringExtraRounds < MAX_EXTRA_ROUNDS_WITH_STEERING) {
          const additionalRounds = Math.min(newlyConsumed, MAX_EXTRA_ROUNDS_WITH_STEERING - totalSteeringExtraRounds);
          maxRounds += additionalRounds;
          totalSteeringExtraRounds += additionalRounds;
          if (additionalRounds > 0) {
            logger.log(
              `[DeepOrchestrator] Extended round budget from ${maxRounds - additionalRounds} to ${maxRounds} ` +
              `(${additionalRounds} extra round(s) for ${newlyConsumed} newly consumed steering message(s), ` +
              `total steering extra: ${totalSteeringExtraRounds}/${MAX_EXTRA_ROUNDS_WITH_STEERING})`
            );
          }
        }

        const roundLabel = this.currentRound > baseMaxRounds
          ? `Round ${this.currentRound}/${maxRounds} (extra, steering-driven, base=${baseMaxRounds})`
          : `Round ${this.currentRound}/${maxRounds}`;
        logger.log(`[DeepOrchestrator] ${roundLabel} ${this.elapsed()}`);
        observer?.onRoundStart?.(this.currentRound);

        // Check infrastructure health (advisory: logs status, never aborts the run).
        await orchestrationService.checkHealth(this.currentRound, researchId, ctx);

        // 1. Update/Generate Plan
        let plan: ResearchPlan;
        if (this.currentRound === 1) {
            observer?.onPlanningStart?.(1);
            observer?.onPlanningProgress?.('planning');
            plan = await planningService.generatePlan({
                sessionId: researchId,
                query,
                complexity,
                model: coordinatorModel,
                modelRegistry: ctx.modelRegistry,
                cwd: ctx.cwd,
                config: this.config,
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
                model: coordinatorModel,
                modelRegistry: ctx.modelRegistry,
                cwd: ctx.cwd,
                config: this.config,
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
          } else if (this.currentRound < maxRounds) {
            // Only announce a delegation that will actually run. At the round cap
            // the loop breaks to synthesis below regardless of this decision, so
            // emitting it here would grow the progress bar's expected units for
            // researchers that never execute — the bar then visibly regresses.
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
                // Don't throw away everything gathered so far. Break to final synthesis
                // (mustSynthesize) so the user still gets a report from collected reports
                // instead of a hard error that discards the whole run.
                logger.warn(`[DeepOrchestrator] Max wait retries (${MAX_WAIT_RETRIES}) exceeded at Round ${this.currentRound}; synthesizing from collected reports`);
                break;
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

              // Merge initialLinks into Round 1 researchers if provided
              if (this.currentRound === 1 && this.options.initialLinks && this.options.initialLinks.length > 0) {
                if (!researcherLinks) researcherLinks = new Map();
                for (const researcher of plan.researchers || []) {
                  const id = String(researcher.id);
                  const existing = researcherLinks.get(id) || [];
                  researcherLinks.set(id, [...new Set([...existing, ...this.options.initialLinks!])]);
                }
              }
            })()
          : (async () => {
              // Even if no queries were generated, if we have initialLinks in Round 1, distribute them
              if (this.currentRound === 1 && this.options.initialLinks && this.options.initialLinks.length > 0) {
                researcherLinks = new Map();
                for (const researcher of plan.researchers || []) {
                  researcherLinks.set(String(researcher.id), [...this.options.initialLinks!]);
                }
              }
            })();

        const storeTask = (this.config.KNOWLEDGE_STORE_MODE !== 'none' && plan.researchers && plan.researchers.length > 0)
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
            // so that high-capability models don't waste time on developer-only tools.
            await orchestrationService.runResearchers({
                plan,
                options: {
                    ...this.options,
                    config: this.config,
                    excludeTools: this.options.excludeTools || ['grep'],
                    observer: this.observer,
                },
                currentRound: this.currentRound,
                signal
            }, researcherLinks, storeLinks);
        }

        // Esc/abort responsiveness: runResearchers returns NORMALLY when the signal
        // fires (researchers are individually aborted), so without this check a
        // cancelled run would still perform the full post-round embedding pass
        // (storeLinkDescriptions → writer.drain) before the loop-top guard throws.
        // Throw here instead — the catch below returns the partial fallback report.
        // Skipping the store pass is safe: nothing has been enqueued for this round
        // yet, and the FTS rebuild is an optimization pass (see cleanup below), not
        // required for durability of previously drained rows.
        if (signal?.aborted) throw new Error('Research aborted');

        // 4. Store synthesized descriptions for semantic search
        // Show embedding indicator in eval box while embedding runs
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
      // Only spin up the evaluation-phase UI when we still have to CALL the evaluator
      // (loop ended on maxRounds). If the evaluator already chose to synthesize inside
      // the loop, its eval slice was completed at that point (onEvaluationDecision) and
      // its decision is final — re-adding a fresh 'eval' box here would leave a
      // perpetually-"evaluating" slice that nothing ever completes, and re-emit
      // start/progress after the decision. Symmetric with the decision guard below.
      if (loopSynthesisPlan === null) {
        observer?.onRoundStart?.(maxRounds + 1); // Progress indicator for synthesis
        observer?.onEvaluationStart?.(maxRounds);
        observer?.onEvaluationProgress?.('evaluating');
      }

      // Final synthesis is beginning: flip steering OFF *before* the final drain
      // below. Ordering matters — there is no next round, so a message queued after
      // the drain would show the affirmative "will steer the next research round"
      // toast and then be destroyed at teardown. With the flag off first (this and
      // the consume run synchronously — no interleaving window), any later steer
      // takes the input handler's fall-through path (forwarded to pi, accurate
      // toast). On the evaluator-chose-synthesize path this is idempotent: the
      // observer already flipped the flag in onEvaluationDecision('synthesize').
      // NOTE: this must also come after the onEvaluationStart above, which re-sets
      // the flag to true (correct for in-loop evaluations, wrong for this final one).
      observer?.onSynthesisStart?.();

      // One final check for new steering messages before synthesis. Done for BOTH
      // exit paths: a message arriving after the evaluator chose 'synthesize' (the
      // loopSynthesisPlan path) was previously never consumed nor appended — fully
      // dropped. Consuming here marks it active so appendSteeringGuidance includes it.
      consumeQueuedMessages(this.options.sessionId);
      const finalSteeringTexts = getSteeringMessages(this.options.sessionId).map(m => m.text);

      let finalReport: ResearchPlan;
      if (loopSynthesisPlan !== null) {
          finalReport = loopSynthesisPlan;
      } else {
          const synthesisServiceFinal = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
          finalReport = await planningService.updatePlanForRound({
              sessionId: researchId,
              query: query,
              complexity,
              round: maxRounds,
              model: coordinatorModel,
              modelRegistry: ctx.modelRegistry,
              cwd: ctx.cwd,
              config: this.config,
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

      // Only emit the synthesis decision here for the FORCED-synthesis path. When the
      // evaluator itself chose to synthesize inside the loop (loopSynthesisPlan set),
      // onEvaluationDecision('synthesize', ...) was already fired at that point; emitting
      // again would double-count synthesis for observers (e.g. the TUI progress bar).
      if (loopSynthesisPlan === null) {
          observer?.onEvaluationDecision?.('synthesize', finalReport, maxRounds);
      }

      let result = finalReport.content || '';
      
      // If content is empty but we have reports, build a fallback synthesis
      if (!result.trim()) {
          const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
          if (synthesisService.hasReports(researchId)) {
              logger.warn(`[DeepOrchestrator] LLM returned empty synthesis for ${researchId}, building fallback from ${synthesisService.getReportCount(researchId)} reports`);
              result = synthesisService.buildFallbackSynthesis(researchId, this.currentRound);
          } else {
              // ZERO reports were collected — the run produced nothing groundable.
              // With the default single-researcher plan the fast-stop threshold
              // (MAX_FAILED_RESEARCHERS = 2) never trips, so a lone researcher that
              // exhausts its retries (e.g. a provider rate limit) used to land here
              // and return a hollow "no summary was generated" string on the SUCCESS
              // path — exit 0. That is a FAILED run: throw, and surface the recorded
              // root causes so the user sees the 429/model error, not a shrug.
              const failedIds = getFailedResearchers(this.options.sessionId, researchId);
              const reasons = getResearcherFailureReasons(this.options.sessionId, researchId);
              const causes = failedIds
                .map((id) => `researcher ${id}: ${reasons[id] ?? 'no usable report'}`)
                .join('; ');
              throw new Error(
                'Research produced no report — no source material was collected' +
                (causes ? `. Causes: ${causes}` : '.')
              );
          }
      }

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

      // Append steering guidance — all consumed messages throughout the session
      const finalSteeringMessages = getActiveSteeringMessages(this.options.sessionId);
      if (finalSteeringMessages.length > 0) {
          logger.debug(`[DeepOrchestrator] Appending guidance from ${finalSteeringMessages.length} steering messages to final report`);
          result = synthesisService.appendSteeringGuidance(result, finalSteeringMessages);
      }

      // NOTE: Model metadata (appendMetadata) is now applied at the very end
      // of the result chain in research-tool-definition.ts (or sdk.ts for SDK
      // users) so it always appears after metrics/summaries.

      const sessionDuration = Date.now() - this.sessionStart;
      metrics.observe('research_session_duration_ms', sessionDuration, { mode: 'deep', complexity: String(complexity), status: 'success' });
      
      // Fire onComplete observer event. A throwing user observer must NOT divert
      // control into the catch below — that would fire onComplete AGAIN with a
      // fallback payload (double terminal callback) AND silently replace the
      // full report with the fallback synthesis. Isolate it, mirroring the
      // researcher-executor's safeObserve pattern.
      try {
        observer?.onComplete?.(result);
      } catch (obsErr) {
        logger.debug('[DeepOrchestrator] onComplete observer threw:', obsErr);
      }

      return result;

    } catch (error) {
      const sessionDuration = Date.now() - this.sessionStart;
      const aborted = signal?.aborted === true;
      metrics.observe('research_session_duration_ms', sessionDuration, { mode: 'deep', complexity: String(complexity), status: aborted ? 'cancelled' : 'error' });
      // A user cancellation is a clean stop, not an error — log it at debug so a
      // quit-mid-run doesn't surface a red error line that reads like a failure.
      if (aborted) {
        logger.debug(`[DeepOrchestrator] Research cancelled: ${error instanceof Error ? error.message : String(error)}`);
      } else {
        logger.error(`[DeepOrchestrator] Research failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Terminal-callback contract (shared with QuickResearchOrchestrator): fire
      // EXACTLY ONE of onComplete / onError. A returned report — full above, or a
      // partial fallback synthesised from whatever was collected (the natural
      // outcome of a mid-run cancel) — is a completion (onComplete). Only a run
      // with nothing to return is a failure (onError + throw). Previously this
      // fired onError AND THEN onComplete on the fallback path, signalling both
      // "errored" and "completed" for one run.
      try {
        const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
        if (synthesisService.hasReports(researchId)) {
          let fallback = synthesisService.buildFallbackSynthesis(researchId, this.currentRound);
          fallback = synthesisService.ensureCitedLinks(researchId, fallback);
          logger.log(`[DeepOrchestrator] Returning ${aborted ? 'partial (cancelled)' : 'fallback'} synthesis (${fallback.length} chars) from ${synthesisService.getReportCount(researchId)} collected reports`);
          const finalSteeringMessages = getActiveSteeringMessages(this.options.sessionId);
          const result = synthesisService.appendSteeringGuidance(fallback, finalSteeringMessages);
          try {
            observer?.onComplete?.(result);
          } catch (obsErr) {
            logger.debug('[DeepOrchestrator] fallback onComplete observer threw:', obsErr);
          }
          return result;
        }
      } catch (fallbackErr) {
        logger.warn(`[DeepOrchestrator] Fallback synthesis also failed:`, fallbackErr);
      }

      // Nothing to return — this run genuinely failed (or was cancelled with no
      // collected work). Fire onError and propagate, matching QuickOrchestrator.
      try {
        observer?.onError?.(error instanceof Error ? error : new Error(String(error)));
      } catch (obsErr) {
        logger.debug('[DeepOrchestrator] onError observer threw:', obsErr);
      }
      throw error;
    } finally {
      // Guard cleanup: getOrchestrationService()/cleanup can throw when the
      // container is disposing (e.g. SIGTERM mid-run). An unguarded throw here
      // would replace the in-flight error or discard a successful return value.
      // Mirrors QuickResearchOrchestrator's guarded cleanup.
      try {
        const orch = await this.getOrchestrationService();
        // On user abort, skip the post-run FTS rebuild + optimize: they are
        // non-signal-aware optimization passes (durability lives in the LanceDB
        // commits already made) and would block Esc from returning promptly.
        // Any rows the run committed are picked up by the next run's start-of-run
        // cleanup (which performs the same rebuild) or the next completed run.
        await orch.cleanupResearchServices(undefined, researchId, ctx, this.config,
          { skipStoreMaintenance: signal?.aborted === true });
      } catch (cleanupErr) {
        logger.warn('[DeepOrchestrator] Failed to cleanup research services:', cleanupErr);
      }
    }
  }
}
