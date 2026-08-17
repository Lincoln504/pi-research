/**
 * Deep Research Orchestrator
 *
 * Coordinates multi-round research using specialized services.
 */

import type { ExtensionContext, AgentToolResult } from '@earendil-works/pi-coding-agent';
import { type Model } from '@earendil-works/pi-ai';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import { getSteeringMessages, consumeQueuedMessages, getActiveSteeringMessages, getFailedResearchers, getResearcherFailureReasons } from './session-state.ts';
import { MAX_EXTRA_ROUNDS_WITH_STEERING, resolveExcludedTools } from '../constants.ts';
import {
  getMaxRounds,
} from '../core/planning-utils.ts';
import type {
  ResearchObserver,
} from '../core/interfaces/observer-interfaces.ts';
import { HeadlessObserver, makeSafeObserver, type HeadlessObserverOptions } from './headless-observer.ts';
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
    
    // Resolve observer: if options were provided instead of an instance, create the instance.
    // Either way, wrap it so a throwing observer callback can never fail the run.
    if (options.observer && typeof (options.observer as any).onProgress === 'function' && !(options.observer instanceof HeadlessObserver)) {
       this.observer = makeSafeObserver(new HeadlessObserver(options.observer as HeadlessObserverOptions));
    } else {
       this.observer = options.observer ? makeSafeObserver(options.observer as ResearchObserver) : undefined;
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
    // Whether the ROUTER chose to finish inside the loop, as opposed to the loop ending
    // because the round budget ran out. The router never carries the report: it is asked
    // for a decision, is given no corpus to write from (it sees each report once, on the
    // round it arrives, and digests thereafter), and any content it returns anyway is
    // discarded in planning-service. So this only records which UI and observer events
    // already fired, not a result to reuse. Final synthesis runs either way, below.
    let routerChoseSynthesis = false;
    // Highest round number handed to observer.onRoundStart. The final synthesis
    // announces itself too, and it must not repeat or skip: `round_start` is an SDK
    // event and a consumer counting rounds reads the gaps.
    let lastAnnouncedRound = 0;

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

        // The final iteration synthesizes; it never researches. Leave BEFORE announcing
        // it, because announcing it is the whole problem: the log said `Round 2/2`, the
        // observer fired onRoundStart (which arms the panel's deferred clear, consumed
        // by a researcher start that never comes), the SDK emitted a `round_start`
        // event, and a full infrastructure health check ran — 105 seconds of it on one
        // measured run — for a round in which no researcher was ever dispatched. 92 of
        // 93 capped runs in the retained logs announced a round that did nothing.
        //
        // This must sit AFTER the steering block above: a message consumed at the top of
        // the final iteration raises maxRounds and legitimately turns this into a real
        // research round. It must also not fire on round 1, which researches even when
        // the budget is 1. The increment stays — the forced synthesis below is told
        // which round it is synthesizing at.
        if (this.currentRound > 1 && this.currentRound >= maxRounds) {
          logger.log(`[DeepOrchestrator] Round cap (${maxRounds}) reached — skipping the evaluator and going straight to final synthesis ${this.elapsed()}`);
          break;
        }

        const roundLabel = this.currentRound > baseMaxRounds
          ? `Round ${this.currentRound}/${maxRounds} (extra, steering-driven, base=${baseMaxRounds})`
          : `Round ${this.currentRound}/${maxRounds}`;
        logger.log(`[DeepOrchestrator] ${roundLabel} ${this.elapsed()}`);
        // Guarded, because a 'wait' decision decrements the round and re-enters the loop
        // to run the SAME round again. Announcing it each time emitted `round_start`
        // 1, 2, 2, 3 — a duplicate rather than the gap the post-loop guard was added for,
        // but the same broken contract for a consumer counting rounds.
        if (this.currentRound > lastAnnouncedRound) {
          observer?.onRoundStart?.(this.currentRound);
          lastAnnouncedRound = this.currentRound;
        }

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
                // Both are used by routing, for different rounds: the bodies of the reports
                // that arrived THIS round are sent in full, and every earlier researcher is
                // represented by its digest alone. Passing reports also lets a caller-side
                // digest miss fall back to deriving one from the body.
                reports: synthesisService.getAllReports(researchId),
                digests: synthesisService.getAllDigests(researchId),
                previousPlan: planningService.getCurrentPlan(researchId),
                totalResearchersPlanned: planningService.getTotalResearchersPlanned(researchId),
                // Live, steering-extended budget — see maxRounds comment above. Without
                // this, updatePlanForRound recomputes the BASE complexity-table value
                // internally and understates the denominator once steering has extended
                // the round budget, prematurely skewing its round-phase guidance to LATE.
                maxRounds,
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
                // Only the ROUTER (round 2+) can reach this: generatePlan pins round 1 to
                // 'delegate' so a coordinator can never end the run before any source is
                // read. The router's decision ends the loop, but it has never held the
                // whole corpus — only this round's reports and earlier digests — so the
                // report itself is written by the terminal synthesis below.
                routerChoseSynthesis = true;
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
                // Deliberately REFERENCED: this sleep IS the run's sole pending
                // operation at this moment (nothing else is in flight during a
                // 'wait'), so an unref'd timer would let the process drain its
                // event loop and exit 0 silently mid-run. Abortability, not
                // unref, is what keeps cancellation responsive here.
                const timeout = setTimeout(() => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                }, 5000);
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
                    excludeTools: resolveExcludedTools(this.options.excludeTools),
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

        // Counted at the END of a round that actually researched, which is what the
        // run summary means by "rounds". The counter it used to read
        // (`evaluator_runs_total`) lost its emit site in c90d7f37 and nothing noticed,
        // because the only consumer gates on `> 1` — so a value permanently stuck at 0
        // is indistinguishable from a single-round run, and the "N rounds" line has
        // never rendered since.
        metrics.increment('research_rounds_completed_total', 1, { mode: 'deep', complexity: String(complexity) });
      }

      // Final Synthesis — always its own call. Routing and synthesis are separate jobs:
      // no router call ever holds the whole corpus (it reads each report on the single
      // round it arrives, and digests after that), so none of them can produce the report
      // and there is nothing from the loop to reuse. This costs one extra call on runs the
      // router ends early, and in exchange removes a full re-send of the corpus from every
      // round that preceded it.
      //
      // ZERO reports collected AND researchers actually failed — the run attempted
      // research and produced nothing groundable. Checked BEFORE the synthesis call
      // rather than after it: with every researcher failed (exactly the insufficient-
      // credit class the researcher classifier exists for) the corpus is empty, so the
      // call is billed over nothing and its result is then discarded by this very gate.
      // The verdict does not depend on the synthesis text — it depends on whether there
      // was any source material — so nothing is lost by asking first.
      //
      // Gated on failures, not merely on the absence of reports: a run cancelled before
      // any researcher finished has no reports and no failures, and must not be reported
      // as having produced nothing groundable.
      const synthesisCheckService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
      const hasReports = synthesisCheckService.hasReports(researchId);
      const failedIds = getFailedResearchers(this.options.sessionId, researchId);
      if (!hasReports && failedIds.length > 0) {
          const reasons = getResearcherFailureReasons(this.options.sessionId, researchId);
          const causes = failedIds
            .map((id) => `researcher ${id}: ${reasons[id] ?? 'no usable report'}`)
            .join('; ');
          throw new Error(
            `Research produced no report — no source material was collected. Causes: ${causes}`
          );
      }

      logger.log(`[DeepOrchestrator] Final synthesis ${this.elapsed()}`);
      // Only spin up the evaluation-phase UI when the loop ended on maxRounds. If the
      // router already chose to finish inside the loop, its eval slice was completed at
      // that point (onEvaluationDecision) and its decision is final — re-adding a fresh
      // 'eval' box here would leave a perpetually-"evaluating" slice that nothing ever
      // completes, and re-emit start/progress after the decision. Symmetric with the
      // decision guard below.
      if (!routerChoseSynthesis) {
        // The synthesis pass announces the round it is synthesizing AT, which is the
        // one the loop stopped on — not `maxRounds + 1`, a number outside the budget
        // every other event is expressed in. That was harmless while the loop
        // announced the phantom final round (1,2,3 then a 4 nobody minded); with the
        // phantom gone it left a hole: a 3-round run emitted round_start 1, 2, 4.
        // Guarded so a one-round budget cannot announce the same round twice.
        if (this.currentRound > lastAnnouncedRound) {
          observer?.onRoundStart?.(this.currentRound);
          lastAnnouncedRound = this.currentRound;
        }
        // The round this synthesis actually happens at, not the budget. They coincide on
        // the round-cap exit but not on the wait-exhaustion one, which breaks out early —
        // that path announced `evaluation_start` for a round no `round_start` had ever
        // named, and the round it really stopped on was left with an evaluation slice
        // that never received a decision.
        observer?.onEvaluationStart?.(this.currentRound);
        observer?.onEvaluationProgress?.('evaluating');
      }

      // Final synthesis is beginning: flip steering OFF *before* the final drain
      // below. Ordering matters — there is no next round, so a message queued after
      // the drain would show the affirmative "will steer the next research round"
      // toast and then be destroyed at teardown. With the flag off first (this and
      // the consume run synchronously — no interleaving window), any later steer
      // takes the input handler's fall-through path (forwarded to pi, accurate
      // toast). On the router-chose-synthesis path this is idempotent: the
      // observer already flipped the flag in onEvaluationDecision('synthesize').
      // NOTE: this must also come after the onEvaluationStart above, which re-sets
      // the flag to true (correct for in-loop evaluations, wrong for this final one).
      observer?.onSynthesisStart?.();

      // One final check for new steering messages before synthesis. Done for BOTH
      // exit paths: a message arriving after the router chose to finish was previously
      // never consumed nor appended — fully dropped. Consuming here marks it active so
      // appendSteeringGuidance includes it.
      consumeQueuedMessages(this.options.sessionId);
      const finalSteeringTexts = getSteeringMessages(this.options.sessionId).map(m => m.text);

      const synthesisServiceFinal = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
      const finalReport: ResearchPlan = await planningService.updatePlanForRound({
          sessionId: researchId,
          query: query,
          complexity,
          round: this.currentRound,
          model: coordinatorModel,
          modelRegistry: ctx.modelRegistry,
          cwd: ctx.cwd,
          config: this.config,
          reports: synthesisServiceFinal.getAllReports(researchId),
          previousPlan: planningService.getCurrentPlan(researchId),
          totalResearchersPlanned: planningService.getTotalResearchersPlanned(researchId),
          mustSynthesize: true,
          // Live, steering-extended budget — see the in-loop call above.
          maxRounds,
          signal,
          observer,
          excludeTools: this.options.excludeTools,
          steeringMessages: finalSteeringTexts,
      });

      // Only emit the synthesis decision here for the FORCED-synthesis path. When the
      // router chose to finish inside the loop, onEvaluationDecision('synthesize', ...)
      // was already fired at that point; emitting again would double-count synthesis for
      // observers (e.g. the TUI progress bar).
      if (!routerChoseSynthesis) {
          // Same round the matching onEvaluationStart above used — see there.
          observer?.onEvaluationDecision?.('synthesize', finalReport, this.currentRound);
      }

      let result = finalReport.content || '';

      if (!result.trim()) {
          if (hasReports) {
              // Content is empty but reports exist — build a fallback synthesis.
              logger.warn(`[DeepOrchestrator] LLM returned empty synthesis for ${researchId}, building fallback from ${synthesisCheckService.getReportCount(researchId)} reports`);
              result = synthesisCheckService.buildFallbackSynthesis(researchId, this.currentRound);
          } else {
              // No reports, no recorded failures, and nothing to ship either.
              throw new Error('Research produced no report — no source material was collected.');
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

      // Observability: log the FULL final synthesis body. Every other layer —
      // researcher prompts, researcher final responses, searches, scrapes — is logged
      // at DEBUG; the synthesis itself (the actual bytes returned to the caller) was
      // the one conspicuous exception, which made post-hoc diagnosis of citation /
      // output issues impossible (a reported "the engine returned placeholder X"
      // could not be confirmed or refuted from the logs). Mirrors the DEBUG logging
      // of researcher final responses. Truncation is deliberately NOT applied: the
      // raw bytes are exactly what's needed to diagnose grounding failures.
      logger.debug(`[DeepOrchestrator] Final synthesis for ${researchId} (${result.length} chars):\n${result}`);

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
          logger.debug(`[DeepOrchestrator] Fallback synthesis for ${researchId} (${result.length} chars):\n${result}`);
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
