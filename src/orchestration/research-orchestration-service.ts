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
import { RESEARCHER_LAUNCH_DELAY_MS } from '../constants.ts';
import { search } from '../web-research/search.ts';
import { parseCitations } from '../utils/text-utils.ts';
import { logger, resetLogger } from '../logger.ts';
import { healthRegistry } from '../healthcheck/index.ts';
import { clearSessionCircuitBreaker } from '../infrastructure/browser/browser-error-utils.ts';
import { getService, ServiceLifecycle, tryGetService, tryGetServiceContainerFromCtx } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type {
  IWriterQueue,
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
import { recordResearcherFailure, shouldStopResearch, createResearchStopError } from './session-state.ts';
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
    const mergedExcludeTools = configDisabledTools.length > 0
      ? [...new Set([...(excludeTools ?? []), ...configDisabledTools])]
      : excludeTools;

    // Resolve model using centralized priority logic
    const selectedModel = await this.resolveResearchModel(options);
    logger.info(`[ResearchOrchestrationService] Using model: ${selectedModel.provider}/${selectedModel.id}`);

    const researchStart = Date.now();

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
      metrics.observe('research_manager_latency_ms', researchDuration, { depth: String(depth), status: 'error', source: 'extension' });
      metrics.increment('research_manager_requests_total', 1, { depth: String(depth), status: 'error', source: 'extension' });
      throw error;
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
        const sessionService = await getService<ResearchSessionService>(ServiceNames.RESEARCH_SESSION_SERVICE, ctx, container);
        await sessionService.abortAllSessions(researchId);
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
            .catch(err => { if (err.message !== 'Aborted') throw err; });
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
          // A user cancellation (quit mid-run) surfaces here as an 'Aborted' throw.
          // That is a clean stop, not a researcher failure: don't log it at ERROR,
          // don't count it toward the fast-stop threshold, and don't paint the TUI
          // researcher slice red. Mirrors the guard in researcher-executor.ts.
          if (signal?.aborted || errMsg === 'Aborted') {
            logger.debug(`[ResearchOrchestrationService] Researcher ${id} cancelled (aborted).`);
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
        const sessionService = await getService<ResearchSessionService>(ServiceNames.RESEARCH_SESSION_SERVICE, ctx, container);
        // Abort sessions specifically for this researchId, not the whole piSessionId
        await sessionService.abortAllSessions(researchId);

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
      const writer = await getService<IWriterQueue>(ServiceNames.WRITER_QUEUE, ctx, container);
      
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
  async checkHealth(round: number, _researchId?: string, ctx?: any): Promise<void> {
    if (round <= 1) return;

    try {
      const container = tryGetServiceContainerFromCtx(ctx);
      let registry: IHealthRegistryService;
      try {
        registry = await getService<IHealthRegistryService>(ServiceNames.HEALTH_REGISTRY, ctx, container);
      } catch {
        registry = healthRegistry;
      }

      const health = await registry.runAll();

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
