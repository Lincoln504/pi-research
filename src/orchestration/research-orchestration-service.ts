/**
 * Research Orchestration Service
 *
 * Handles the core orchestration logic for multi-round research.
 * Responsible for:
 * - Multi-round research coordination
 * - Agent spawning and concurrent execution management
 * - Search result distribution to researchers
 * - Health check integration
 * - Knowledge store integration for link descriptions
 */

import type { Model } from '@earendil-works/pi-ai';
import { resolveResearchModel } from '../core/llm/research-model-resolver.ts';
import type { QueryResultWithError } from '../web-research/types.ts';
import type { RunResearchersOptions } from './orchestration-types.ts';
import { RESEARCHER_LAUNCH_DELAY_MS, RESEARCH_TOOL_NAMES, resolveExcludedTools } from '../constants.ts';
import { search } from '../web-research/search.ts';
import { parseCitations } from '../utils/text-utils.ts';
import { logger, resetLogger } from '../logger.ts';
import { healthRegistry } from '../healthcheck/index.ts';
import { clearSessionCircuitBreaker } from '../infrastructure/browser/browser-error-utils.ts';
import { getService, ServiceLifecycle, tryGetService, tryGetServiceContainerFromCtx } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type {
  IKnowledgeStoreService,
  IHealthRegistryService,
  IResearchOrchestration,
  StoreUrlEntry,
  ResearchOptions,
  ResearchPlan,
  IPlanningService,
  IResearchSynthesisService,
} from '../core/service-interfaces.ts';
import type { Config } from '../config.ts';
import { getConfig, DEFAULTS } from '../config.ts';
import { getCachedScrapedContent, normalizeUrl, cleanupSharedLinks } from '../utils/shared-links.ts';
import { runResearcher } from './researcher-executor.ts';
import { ResearchRunSemaphore, ResearchRunCapacityError } from '../infrastructure/research-run-semaphore.ts';
import { recordResearcherFailure, shouldStopResearch, createResearchStopError } from './session-state.ts';
import { raceWithSignal } from '../utils/cancellation.ts';
import { isAbortSentinel, boundSessionAbort } from './abort-utils.ts';
import type { ResearchSessionService } from './research-session-service.ts';
import { QuickResearchOrchestrator } from './quick-research-orchestrator.ts';
import { DeepResearchOrchestrator } from './deep-research-orchestrator.ts';
import { metrics } from '../utils/metrics.ts';

/**
 * Research Orchestration Service
 *
 * Handles core orchestration logic for multi-round research.
 */
export class ResearchOrchestrationService implements IResearchOrchestration {
  readonly name = ServiceNames.RESEARCH_ORCHESTRATION;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  async initialize(): Promise<void> {
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }
  async dispose(): Promise<void> {
    this.lifecycle = ServiceLifecycle.DISPOSED;
  }

  /**
   * Resolve the model for research based on options and config.
   */
  async resolveResearchModel(options: ResearchOptions): Promise<Model<any>> {
    const { ctx, model, config } = options;
    // If a fully-resolved model was already provided (carries both provider and
    // id), use it verbatim. Re-resolving from its id alone can land on a
    // different provider's entry that happens to share the same id — e.g. the
    // host's authed `glm-coding/glm-4.7` vs pi's built-in unauthed `zai/glm-4.7`
    // — silently dropping the provider that actually has an API key.
    if (model && (model as any).provider && (model as any).id) {
      return model as Model<any>;
    }
    return resolveResearchModel({
      modelRegistry: ctx.modelRegistry,
      config: config || getConfig(ctx.cwd),
      modelId: (model as any)?.id,
      hostModel: ctx.model as Model<any>,
      cwd: ctx.cwd,
    });
  }

  /**
   * Run a research task (Quick or Deep)
   */
  async runResearch(options: ResearchOptions, signal?: AbortSignal): Promise<string> {
    const { ctx, query, depth = 0, observer, onUpdate, sessionId, researchId, config, excludeTools } = options;

    const researchConfig = config || getConfig(ctx.cwd);

    // Fold the config-level per-tool disable list (PI_RESEARCH_DISABLED_TOOLS) into the
    // per-run excludeTools stream. This is the single chokepoint that constructs both the
    // Quick and Deep orchestrators, so the merged list reaches BOTH each researcher's tool
    // allowlist AND the coordinator/evaluator "DISABLED TOOLS" prompt section for free.
    // Disable-only and additive: any per-call excludeTools (e.g. CLI --exclude-tools) is preserved.
    const configDisabledTools = researchConfig.DISABLED_TOOLS
      ? researchConfig.DISABLED_TOOLS.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    // Unknown names are a SILENT no-op downstream (the merge is a blind Set union),
    // so a typo leaves the tool enabled for a whole billed run while the user
    // believes it is off. `--exclude-tools` fails fast on this in the CLI parser;
    // its two siblings — the SDK's `excludeTools` option and
    // PI_RESEARCH_DISABLED_TOOLS — reach the same union with no check at all, and
    // RESEARCH_TOOL_NAMES already documents itself as the vocabulary all THREE
    // accept. Warn rather than throw here: this chokepoint is mid-run and serves a
    // library API and an ambient env var, where aborting a legitimate request over
    // one unrecognized name is the wrong trade — the CLI keeps its fail-fast.
    for (const [surface, names] of [
      ['excludeTools', excludeTools ?? []],
      ['PI_RESEARCH_DISABLED_TOOLS', configDisabledTools],
    ] as const) {
      const unknown = names.filter((t) => !RESEARCH_TOOL_NAMES.includes(t));
      if (unknown.length > 0) {
        logger.warn(
          `[ResearchOrchestrationService] ${surface}: ignoring unknown tool name${unknown.length === 1 ? '' : 's'} ` +
          `${unknown.map((t) => `"${t}"`).join(', ')} — these exclude nothing. Valid names: ${RESEARCH_TOOL_NAMES.join(', ')}.`
        );
      }
    }
    const mergedExcludeTools = resolveExcludedTools(excludeTools, configDisabledTools);

    // Resolve model using centralized priority logic
    const selectedModel = await this.resolveResearchModel(options);
    logger.info(`[ResearchOrchestrationService] Using model: ${selectedModel.provider}/${selectedModel.id}`);

    const researchStart = Date.now();

    // Cross-process run-cap: acquire one of N slots so concurrent research runs
    // can't saturate the shared leader-elected browser/embedding pool and degrade
    // into ~60-error failures. Over-cap runs QUEUE for a slot (announced once via
    // the observer) rather than failing, because an extra run is a legitimate
    // request to do work, not an error. Fail-OPEN on internal/IO errors (a
    // semaphore bug must never break research); only a genuine
    // ResearchRunCapacityError — nothing freed within the whole queue window —
    // propagates. The slot is released in finally.
    let runSlot: { slotIndex: number; release(): Promise<void> } | null = null;
    try {
      const container = tryGetServiceContainerFromCtx(ctx);
      const semaphore = await getService<ResearchRunSemaphore>(ServiceNames.RESEARCH_RUN_SEMAPHORE, ctx, container);
      runSlot = await semaphore.acquire(undefined, signal, (slots, maxWaitMs) => {
        // The queue notice fires BEFORE any orchestrator exists, so `observer` is
        // still exactly what the caller passed: either a ResearchObserver, or the
        // HeadlessObserverOptions bag (only `onProgress`) that the CLI supplies and
        // the orchestrator would normally wrap later. Dispatch to whichever shape
        // is present — handling only the former silently drops the notice on the
        // CLI, which is the very front-end that most needs it.
        notifyRunQueued(observer, slots, maxWaitMs);
      });
      logger.info(`[ResearchOrchestrationService] Acquired research run slot ${runSlot.slotIndex} (cap ${semaphore.getMaxSlots()}).`);
    } catch (err) {
      const isTerminal =
        err instanceof ResearchRunCapacityError || (err instanceof Error && err.name === 'AbortError');
      if (isTerminal) {
        // The queue notice above may already have announced this run to the
        // observer (onRunQueued); rethrowing with no terminal event breaks the
        // "exactly one of onComplete/onError" contract both orchestrators keep —
        // an observer-driven consumer saw run_queued and then silence. No
        // orchestrator exists yet, so this cannot double-fire. Observer throws
        // stay isolated, as everywhere else.
        try {
          (observer as { onError?: (e: Error) => void } | undefined)?.onError?.(err as Error);
        } catch { /* observer isolation */ }
      }
      if (err instanceof ResearchRunCapacityError) {
        // Audit L1: a capacity-refused run was invisible to run-level metrics —
        // the rethrow happened before the success/error accounting ran.
        metrics.increment('research_manager_requests_total', 1, { depth: String(depth), status: 'capacity_refused', source: 'extension' });
        throw err; // capacity exhausted → fail fast
      }
      // A cancel while queueing for a slot must stay cancelled. Fail-open here would
      // start the very run the user just aborted.
      if (err instanceof Error && err.name === 'AbortError') {
        metrics.increment('research_manager_requests_total', 1, { depth: String(depth), status: 'cancelled', source: 'extension' });
        throw err;
      }
      logger.warn(`[ResearchOrchestrationService] Run-cap unavailable, proceeding without it: ${err instanceof Error ? err.message : String(err)}`);
    }

    let result: string;
    try {
      if (depth === 0) {
        const orchestrator = new QuickResearchOrchestrator({
          ctx,
          model: selectedModel,
          query,
          sessionId,
          researchId,
          observer,
          onUpdate,
          config: researchConfig,
          excludeTools: mergedExcludeTools,
          initialLinks: options.initialLinks,
        });
        result = await orchestrator.run(signal);
      } else {
        const orchestrator = new DeepResearchOrchestrator({
          ctx,
          model: selectedModel,
          query,
          complexity: depth as 1 | 2 | 3,
          sessionId,
          researchId,
          observer,
          onUpdate,
          config: researchConfig,
          excludeTools: mergedExcludeTools,
          orchestrationService: this,
          initialLinks: options.initialLinks,
        });
        result = await orchestrator.run(signal);
      }
      const researchDuration = Date.now() - researchStart;
      metrics.observe('research_manager_latency_ms', researchDuration, { depth: String(depth), status: 'success', source: 'extension' });
      metrics.increment('research_manager_requests_total', 1, { depth: String(depth), status: 'success', source: 'extension' });
      return result;
    } catch (error) {
      const researchDuration = Date.now() - researchStart;
      // Label a user cancel 'cancelled', not 'error' — the orchestrators' own
      // research_session_duration_ms one layer down already does, and a metrics
      // consumer diffing the two layers read every quick-mode cancel as an error.
      const status = signal?.aborted ? 'cancelled' : 'error';
      metrics.observe('research_manager_latency_ms', researchDuration, { depth: String(depth), status, source: 'extension' });
      metrics.increment('research_manager_requests_total', 1, { depth: String(depth), status, source: 'extension' });
      throw error;
    } finally {
      // Always release the run-cap slot — on success, error, or abort (the
      // orchestrator throws on AbortSignal, hitting this finally before rethrow).
      if (runSlot) {
        // Never let a release failure mask the run's own outcome — but do report it.
        // A slot that fails to release stays held for the lifetime of THIS process
        // (liveness reclaim only fires once the owner is gone), so it silently costs
        // one unit of capacity for every subsequent run in the session.
        await runSlot.release().catch((relErr) => {
          logger.warn(
            `[ResearchOrchestrationService] Failed to release run slot ${runSlot?.slotIndex}; capacity is reduced until this process exits: ${relErr instanceof Error ? relErr.message : String(relErr)}`,
          );
        });
      }
    }
  }

  /**
   * Cleanup and reset services for the current research run
   * @param opts.skipStoreMaintenance - skip the post-run FTS rebuild + optimize
   *   (used on user abort: both are non-signal-aware optimization passes; row
   *   durability lives in the LanceDB commits already made, and the next run's
   *   cleanup performs the same rebuild).
   */
  async cleanupResearchServices(sessionId?: string, researchId?: string, ctx?: any, config?: Config, opts?: { skipStoreMaintenance?: boolean }): Promise<void> {
    const targetId = researchId || sessionId;
    const container = tryGetServiceContainerFromCtx(ctx);
    // Use the run's RESOLVED config when the caller has it — an SDK caller's
    // options.config override (e.g. KNOWLEDGE_STORE_MODE:'none' to stay off the native
    // vector stack) must govern this post-run FTS/optimize gate too. Falling back to a
    // fresh getConfig(cwd) would ignore that override and either load the native stack on
    // a platform that lacks it, or skip the rebuild a store-enabled run legitimately needs.
    const resolvedConfig = config ?? getConfig(ctx?.cwd);
    
    // Cleanup session service
    try {
      const sessionService = await getService<ResearchSessionService>(ServiceNames.RESEARCH_SESSION_SERVICE, ctx, container);
      if (sessionService && targetId) {
        await sessionService.cleanup(targetId);
      }
      
      // Perform FTS index rebuild here after synthesis/completion — but only when
      // the knowledge store is enabled. With KNOWLEDGE_STORE_MODE='none' (or on a
      // platform missing the native @lancedb binding, e.g. Intel macOS) merely
      // resolving the service loads the native vector stack and throws; gating it
      // lets the rest of cleanup proceed instead of jumping to the catch below.
      if (opts?.skipStoreMaintenance) {
        logger.debug('[ResearchOrchestrationService] Skipping FTS rebuild/optimize (run aborted); next run\'s cleanup will rebuild');
      } else if (resolvedConfig.KNOWLEDGE_STORE_MODE !== 'none') {
        const ksService = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, ctx, container);
        if (ksService && ksService.isReady()) {
          const store = await ksService.getStore();
          if (store) {
            logger.info('[ResearchOrchestrationService] Rebuilding FTS index after research run');
            const rebuilt = await store.rebuildFtsIndex();
            // Only compact/prune when the FTS index was actually rebuilt — i.e. the
            // run changed the data. A no-op run skips both, so steady-state loops no
            // longer accumulate orphaned index/version files (the disk-bloat fix).
            if (rebuilt) {
              await store.optimize();
            }
          }
        }
      }
    } catch (_err) {
      logger.debug('[ResearchOrchestrationService] Service cleanup failed:', _err);
    }
    
    // NOTE: synthesis reports are intentionally NOT cleared here. This cleanup runs in
    // the orchestrator's own finally, i.e. INSIDE the run() call — clearing here erased
    // the per-researcher reports before the SDK's runDeepResearch() promise even resolved,
    // making getResearchReports()/runResearchDetailed().reports always return an empty Map.
    // Retention is bounded instead by ResearchSynthesisService's MAX_SESSIONS LRU cap, its
    // designed backstop; reports for a completed run linger only until evicted or the SDK
    // reads them. See getResearchReports() in sdk.ts.

    // Clear planning state
    const planningService = tryGetService<IPlanningService>(ServiceNames.PLANNING, container);
    if (planningService && targetId) {
      planningService.clearPlanningState(targetId);
      logger.debug(`[ResearchOrchestrationService] Cleared planning state for ${targetId}`);
    }
    
    if (targetId) {
      cleanupSharedLinks(targetId);
      resetLogger(targetId);
      clearSessionCircuitBreaker(targetId);
    }

    logger.debug(`[ResearchOrchestrationService] Cleaned up research services for ${targetId}`);
  }

  /**
   * Distribute search results to researchers based on query matching
   * @param plan - Research plan with researchers and queries
   * @param results - Search results from queries
   * @param _ctx - Optional context for container isolation
   * @returns Map of researcher ID -> array of URLs
   */
  async distributeSearchResults(plan: ResearchPlan, results: QueryResultWithError[], _ctx?: any): Promise<Map<string, string[]>> {
    const startTime = Date.now();
    const queryToResults = new Map(results.map(r => [r.query, r.results || []]));
    const linkMap = new Map<string, string[]>();

    for (const researcher of plan.researchers || []) {
      const researcherUrls = new Set<string>();
      for (const query of researcher.queries || []) {
        const queryResults = queryToResults.get(query) || [];
        for (const res of queryResults) {
          researcherUrls.add(res.url);
        }
      }
      linkMap.set(String(researcher.id), Array.from(researcherUrls));
    }

    logger.debug(`[ResearchOrchestrationService] Distributed ${results.length} results in ${Date.now() - startTime}ms`);
    return linkMap;
  }

  /**
   * Run researchers concurrently with launch delay
   * @param options - Run options
   * @param researcherLinks - Optional map of researcher ID -> search results
   * @param storeLinks - Optional map of researcher ID -> store results
   * @param _ctx - Optional context for container isolation
   */
  async runResearchers(
    options: RunResearchersOptions, 
    researcherLinks?: Map<string, string[]>, 
    storeLinks?: Map<string, StoreUrlEntry[]>,
    _ctx?: any
  ): Promise<void> {
    const { plan, options: orchestratorOptions, currentRound, signal } = options;
    const { sessionId, researchId, observer, ctx } = orchestratorOptions;
    const container = tryGetServiceContainerFromCtx(ctx);

    // Obtain the planning service once for all researchers in this round
    let planningService: IPlanningService;
    try {
      planningService = await getService<IPlanningService>(ServiceNames.PLANNING, ctx, container);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // If the service container is already disposing (SIGTERM during active research),
      // return gracefully rather than throwing — the research run is ending anyway.
      if (errMsg.includes('during container disposal') || options.signal?.aborted) {
        logger.info('[ResearchOrchestrationService] Service container disposing — skipping researchers gracefully');
        return;
      }
      logger.error('[ResearchOrchestrationService] Failed to get planning service:', err);
      throw new Error('Planning service not available. Research cannot continue.', { cause: err });
    }

    const researchers = plan.researchers || [];
    const active = new Set<Promise<void>>();
    // Set just before each fast-stop throw below. A researcher wedged past the
    // bounded abort/settle waits is ABANDONED by the stop — its promise settles
    // later, after the run's single terminal callback has fired (and, on the
    // tool path, after endResearchSession freed the session state). Its late
    // failure must then be suppressed: recordResearcherFailure would re-create
    // the just-freed session entry via getPiState's create-on-read (a
    // process-lifetime leak on the SDK's random per-run sessionIds), and
    // onResearcherFailure would violate the no-events-after-terminal contract.
    let runTerminated = false;
    // Honour MAX_CONCURRENT_RESEARCHERS — prevents resource spikes when a plan has many researchers.
    const maxConcurrent: number = (orchestratorOptions.config as Config)?.MAX_CONCURRENT_RESEARCHERS ?? DEFAULTS.MAX_CONCURRENT_RESEARCHERS;
    const maxFailedResearchers: number = (orchestratorOptions.config as Config)?.MAX_FAILED_RESEARCHERS ?? DEFAULTS.MAX_FAILED_RESEARCHERS;

    for (const configItem of researchers) {
      if (signal?.aborted) break;

      // Stop BEFORE launching if the failure threshold is already crossed. The
      // post-launch check below only fires after a researcher is in-flight, so
      // without this an early check, up to maxConcurrent-1 extra researchers could
      // start past the stop threshold and waste a browser slot + an LLM call.
      if (shouldStopResearch(sessionId, researchId, maxFailedResearchers)) {
        // A SIGTERM mid-run disposes the container, and getService then throws
        // "Cannot get service … during container disposal" — which would REPLACE
        // the already-decided stop error with a raw service error. Teardown is
        // happening either way, so a failure here must not gate the stop throw.
        try {
          const sessionService = await getService<ResearchSessionService>(ServiceNames.RESEARCH_SESSION_SERVICE, ctx, container);
          // Bounded: abortAllSessions awaits each session's abort, and session.abort()
          // can wedge on the very in-flight call it is cancelling — an unbounded await
          // here would hang the fast-stop throw for as long as the wedged call takes.
          // Proceed after the bound; the abandoned aborts drain in the background.
          await boundSessionAbort(
            sessionService.abortAllSessions(researchId),
            () => logger.debug('[ResearchOrchestrationService] Fast-stop abortAllSessions did not settle within bound; proceeding with stop'),
          );
        } catch (abortErr) {
          logger.debug(`[ResearchOrchestrationService] Fast-stop session abort unavailable (container disposing?): ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`);
        }
        // abortAllSessions only reaches REGISTERED sessions; a researcher still
        // building a session, in a retry backoff, or in its initial-links search
        // loop self-stops via shouldStopResearch (researcher-executor.ts). Bound-
        // await the active set so those self-stops settle BEFORE the stop error
        // returns the run and releases its run-cap slot — bounded for the same
        // reason as boundSessionAbort: one wedged researcher must not hang the
        // already-decided stop.
        await boundSessionAbort(
          Promise.allSettled(active).then(() => undefined),
          () => logger.debug('[ResearchOrchestrationService] Fast-stop: active researchers did not settle within bound; proceeding with stop'),
        );
        runTerminated = true;
        throw createResearchStopError(sessionId, researchId);
      }

      // Enforce the concurrency cap before launching the next researcher.
      // Wait for one slot to free up when we're at capacity, or abort immediately if signalled.
      if (active.size >= maxConcurrent) {
        if (signal?.aborted) break;
        // Hoist onAbort so the listener is removed once the race settles normally (a researcher
        // finished). The previous {once:true} listener was only cleaned up if abort actually
        // fired, so every capacity-wait that resolved by completion leaked a listener on `signal`
        // — accumulating across a long run toward MaxListenersExceededWarning.
        let onAbort: (() => void) | undefined;
        const abortPromise = signal ? new Promise<void>((_, reject) => {
          onAbort = () => reject(new Error('Aborted'));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }) : null;
        try {
          await Promise.race([...active, ...(abortPromise ? [abortPromise] : [])])
            .catch(err => { if (!isAbortSentinel(err.message)) throw err; });
        } finally {
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        }
        if (signal?.aborted) break;
      }

      const promise = (async () => {
        const id = String(configItem.id);
        try {
          const initialLinks = researcherLinks?.get(id) || [];
          const historicalUrls = storeLinks?.get(id) || [];

          await runResearcher({
            ...orchestratorOptions,
            // Correct field mappings — orchestratorOptions.config is the app Config;
            // the per-researcher plan item goes into 'config' (overriding the spread),
            // and the app Config moves to 'researchConfig'.
            config: configItem,
            researchConfig: orchestratorOptions.config ?? getConfig(ctx.cwd),
            round: currentRound,
            planningService,
            initialLinks,
            historicalUrls,
            signal,
            excludeTools: orchestratorOptions.excludeTools,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // A user cancellation (quit mid-run) surfaces here as an abort-sentinel
          // throw — either the race's bare 'Aborted' or the '<id>: Aborted' that
          // ensureAssistantResponse raises for an externally-aborted session (the
          // fast-stop path). Container disposal (SIGTERM mid-run) is the same
          // clean-teardown class: the executor stops retrying on it, and counting
          // its "during container disposal" throw as a researcher failure both
          // paints a red slice with a bogus root cause and can trip
          // shouldStopResearch during shutdown. None of these are researcher
          // failures: don't log at ERROR, don't count toward the fast-stop
          // threshold, don't paint the TUI slice red. Mirrors the guard in
          // researcher-executor.ts.
          if (signal?.aborted || isAbortSentinel(errMsg) || container?.isDisposing || errMsg.includes('during container disposal')) {
            logger.debug(`[ResearchOrchestrationService] Researcher ${id} cancelled (aborted).`);
          } else if (runTerminated) {
            // Abandoned-by-fast-stop researcher settling AFTER the run's
            // terminal error — see the runTerminated declaration above.
            logger.debug(`[ResearchOrchestrationService] Researcher ${id} settled after the run's fast-stop terminal error; suppressing post-terminal failure recording (${errMsg}).`);
          } else {
            logger.error(`[ResearchOrchestrationService] Researcher ${id} failed: ${errMsg}`);
            // Record failure (with its root cause) for stopping logic and for the
            // zero-report failure surfaced at synthesis time.
            recordResearcherFailure(sessionId, researchId, id, errMsg);
            // Notify observer
            observer?.onResearcherFailure?.(id, errMsg);
          }
        }
      })();

      // Prune the promise from the active set when it settles so Promise.race works
      // correctly and active.size stays accurate for the concurrency cap.
      promise.finally(() => active.delete(promise));
      active.add(promise);

      // Throttled launch to prevent resource spikes (stagger by RESEARCHER_LAUNCH_DELAY_MS,
      // skip after last). Abortable: an inert setTimeout would keep the loop alive for up to
      // RESEARCHER_LAUNCH_DELAY_MS per pending researcher after a cancel, delaying shutdown.
      if (RESEARCHER_LAUNCH_DELAY_MS > 0 && researchers.indexOf(configItem) < researchers.length - 1) {
        if (signal?.aborted) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
          }, RESEARCHER_LAUNCH_DELAY_MS);
          const onAbort = () => { clearTimeout(timer); resolve(); };
          if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
        });
        if (signal?.aborted) break;
      }

      if (shouldStopResearch(sessionId, researchId, maxFailedResearchers)) {
        // getService can throw during container disposal — same guard as the
        // pre-launch fast-stop above: the stop error must win, not a raw
        // "Cannot get service … during container disposal".
        try {
          const sessionService = await getService<ResearchSessionService>(ServiceNames.RESEARCH_SESSION_SERVICE, ctx, container);
          // Abort sessions specifically for this researchId, not the whole piSessionId.
          // Bounded for the same reason as the pre-launch fast-stop above: a wedged
          // session.abort() must not gate the stop error that is already decided.
          await boundSessionAbort(
            sessionService.abortAllSessions(researchId),
            () => logger.debug('[ResearchOrchestrationService] Fast-stop abortAllSessions did not settle within bound; proceeding with stop'),
          );
        } catch (abortErr) {
          logger.debug(`[ResearchOrchestrationService] Fast-stop session abort unavailable (container disposing?): ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`);
        }
        // Bound-await the active set so unregistered researchers self-stop before
        // the stop error releases the run-cap slot (see the pre-launch site).
        await boundSessionAbort(
          Promise.allSettled(active).then(() => undefined),
          () => logger.debug('[ResearchOrchestrationService] Fast-stop: active researchers did not settle within bound; proceeding with stop'),
        );

        runTerminated = true;
        throw createResearchStopError(sessionId, researchId);
      }
    }

    // Wait for remaining researchers
    await Promise.all(active);
  }

  /**
   * Run a search burst for the given queries
   * @param queries - Array of search queries
   * @param config - Research configuration
   * @param signal - Optional abort signal
   * @param onProgress - Optional progress callback
   * @param ctx - Optional context for container isolation
   * @returns Search results
   */
  async runSearchBurst(
    queries: string[],
    config: Config,
    signal?: AbortSignal,
    onProgress?: (links: number) => void,
    ctx?: any
  ): Promise<QueryResultWithError[]> {
    const container = tryGetServiceContainerFromCtx(ctx);
    const results = await search(queries, config, signal, onProgress, container);
    const totalResults = results.reduce((sum, r) => sum + (r.results?.length || 0), 0);
    logger.info(`[ResearchOrchestrationService] Search burst completed. Total results: ${totalResults}`);
    return results;
  }

  /**
   * Store link descriptions to knowledge store for a specific round
   * @param sessionId - Session identifier
   * @param round - Round number
   * @param researchId - Research ID
   * @param config - Research configuration
   * @param ctx - Optional extension context for container isolation
   */
  async storeLinkDescriptions(_sessionId: string, round: number, researchId: string, config: Config, ctx?: any): Promise<void> {
    // Knowledge store disabled — never load the native vector stack. Mirrors the
    // gates in the quick orchestrator and scrape.ts; without this, resolving the
    // service throws on platforms lacking the native @lancedb binding (e.g. Intel
    // macOS) and needlessly opens LanceDB even when the user set MODE='none'.
    if (config.KNOWLEDGE_STORE_MODE === 'none') return;

    const container = tryGetServiceContainerFromCtx(ctx);

    try {
      const ksService = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, ctx, container);
      if (!ksService.isReady()) {
        logger.debug('[ResearchOrchestrationService] Knowledge store not ready, skipping link descriptions');
        return;
      }

      const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
      // Resolve the writer queue directly from the already-fresh ksService rather
      // than through the WRITER_QUEUE DI registration: that registration caches the
      // FIRST IWriterQueue object it is ever handed, forever — WriterQueue's own
      // initialize() is a no-arg lifecycle no-op that never rebuilds its bound
      // store/chunker, so a later Knowledge Mode/cwd change that disposes and
      // rebuilds ksService's internal writer queue left every future getService()
      // call here still returning the stale, disposed one (writes silently dropped
      // via its "store is closing" guard). ksService.getWriterQueue() always
      // reflects whatever initialize() just settled on, which the isReady() check
      // above already confirmed is live.
      const writer = await ksService.getWriterQueue();
      if (!writer) {
        logger.debug('[ResearchOrchestrationService] Writer queue unavailable, skipping link descriptions');
        return;
      }

      const roundPrefix = `${round}.`;
      let enqueued = 0;
      let researcherCount = 0;

      const allReports = synthesisService.getAllReports(researchId);
      if (allReports.size === 0) {
        logger.warn(`[ResearchOrchestrationService] No reports found in synthesis service for researchId ${researchId} round ${round}`);
      }

      for (const [key, report] of allReports.entries()) {
        if (!key.startsWith(roundPrefix)) continue;
        researcherCount++;

        const links = parseCitations(report);
        if (links.length === 0) {
          logger.warn(`[ResearchOrchestrationService] Researcher ${key} produced no parseable CITED LINKS - no descriptions stored`);
          continue;
        }

        logger.debug(`[ResearchOrchestrationService] Storing ${links.length} citations for researcher ${key}`);

        for (const link of links) {
          if (link.url) {
            const cachedContent = getCachedScrapedContent(researchId, link.url) ?? undefined;
            const markdown = link.description || `(source: ${link.url})`;
            writer.enqueue({
              url: normalizeUrl(link.url),
              markdown: markdown,
              content: cachedContent,
              metadata: {
                researchId,
                round,
                researcherId: key,
                description: link.description || '',
                sourceOrigin: link.url,
                source: link.source || 'unknown',
              }
            });
            enqueued++;
          }
        }
      }

      if (enqueued > 0) {
        logger.info(`[ResearchOrchestrationService] Enqueued ${enqueued} citations from ${researcherCount} researchers for round ${round}`);
        await writer.drain();
      } else if (researcherCount > 0) {
        logger.warn(`[ResearchOrchestrationService] No valid citations found among ${researcherCount} researchers in round ${round}`);
      }
    } catch (err) {
      logger.warn('[ResearchOrchestrationService] Failed to store link descriptions (non-fatal):', err);
    }
  }


  /**
   * Run the infrastructure health check and log its status. Purely ADVISORY:
   * research never aborts on an unhealthy result. This is deliberate — the health
   * check has historically produced false negatives (e.g. a single-endpoint DDG
   * probe, or native deps unavailable on Intel macOS) and an abort-on-unhealthy
   * would needlessly kill runs that would otherwise succeed on cached/partial
   * data. The return type is `void` so a future edit can't quietly start
   * "honoring" a boolean and reintroduce that false-negative abort.
   * @param round - Current round number
   * @param ctx - Optional extension context for container isolation
   */
  async checkHealth(round: number, _researchId?: string, ctx?: any, signal?: AbortSignal): Promise<void> {
    // Round 1 is skipped because there is nothing to diagnose yet — the pool was
    // built moments earlier and no work has run through it. A consequence worth
    // stating: a complexity-1 run has exactly ONE research round, so it now never
    // runs this at all. That is correct rather than a gap. It used to run at the
    // phantom final round, which dispatched no researchers and on one measured run
    // spent 105 seconds probing infrastructure that the synthesis pass ahead of it
    // does not use. This check is advisory logging; a quick run loses nothing but
    // that cost.
    if (round <= 1) return;
    if (signal?.aborted) {
      logger.debug(`[ResearchOrchestrationService] Health check at Round ${round} skipped (run already aborted).`);
      return;
    }

    try {
      const container = tryGetServiceContainerFromCtx(ctx);
      let registry: IHealthRegistryService;
      try {
        registry = await getService<IHealthRegistryService>(ServiceNames.HEALTH_REGISTRY, ctx, container);
      } catch {
        registry = healthRegistry;
      }

      // Abort-aware: a user cancel landing inside a probe previously waited out
      // the FULL probe budget (105s observed) — the one await on this path that
      // ignored the run signal. The abandoned probe keeps draining in the
      // background (probes carry their own timeouts and are safe to leave
      // running); its dropped result costs nothing because the next abort-aware
      // await in the run loop raises the cancel anyway.
      const health = await raceWithSignal(registry.runAll(), signal);
      if (health === undefined) {
        logger.debug(`[ResearchOrchestrationService] Health check at Round ${round} abandoned (run signal fired).`);
        return;
      }

      if (health.status === 'healthy') {
        logger.debug(`[ResearchOrchestrationService] Health status at Round ${round}: [OK] All systems operational`);
      } else {
        // Degraded or unhealthy — log for visibility but never stop the run.
        const failed = health.components.filter(c => !c.healthy).map(c => c.component);
        const label = health.status === 'degraded' ? 'Degraded' : 'Unhealthy';
        logger.warn(`[ResearchOrchestrationService] Health status at Round ${round}: [WARN] ${label} (${failed.join(', ')}). Continuing.`);
      }
    } catch (err) {
      logger.warn('[ResearchOrchestrationService] Failed to check health status:', err);
    }
  }
}

/**
 * Deliver the "your run is queued behind other runs" notice to whichever observer
 * shape the caller supplied.
 *
 * This fires before the orchestrator normalizes the observer, so both forms are
 * live here: a {@link ResearchObserver} instance (SDK / pi extension) or the
 * {@link HeadlessObserverOptions} bag carrying only `onProgress` (the CLI and
 * agent skill). A queued run is otherwise completely silent for the whole acquire
 * wait, which is indistinguishable from a hang.
 *
 * Never throws: a front-end callback must not be able to fail the run it is
 * merely reporting on.
 */
function notifyRunQueued(observer: unknown, slots: number, maxWaitMs: number): void {
  try {
    const obs = observer as
      | { onRunQueued?: (s: number, w: number) => void; onProgress?: (e: string, d?: unknown) => void }
      | undefined;
    if (typeof obs?.onRunQueued === 'function') obs.onRunQueued(slots, maxWaitMs);
    else if (typeof obs?.onProgress === 'function') obs.onProgress('run_queued', { slots, maxWaitMs });
  } catch (err) {
    logger.debug(`[ResearchOrchestrationService] run_queued notification threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}
