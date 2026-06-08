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

import type { QueryResultWithError } from '../web-research/types.ts';
import type { RunResearchersOptions } from './orchestration-types.ts';
import { RESEARCHER_LAUNCH_DELAY_MS } from '../constants.ts';
import { search } from '../web-research/search.ts';
import { parseCitations } from '../utils/text-utils.ts';
import { logger } from '../logger.ts';
import { healthRegistry } from '../healthcheck/index.ts';
import { getService, ServiceLifecycle, tryGetService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type {
  IWriterQueue,
  IKnowledgeStoreService,
  IResearchOrchestration,
  ResearchOptions,
  ResearchPlan,
  IPlanningService,
  IResearchSynthesisService,
} from '../core/service-interfaces.ts';
import type { Config } from '../config.ts';
import { getConfig } from '../config.ts';
import { getCachedScrapedContent, normalizeUrl, cleanupSharedLinks } from '../utils/shared-links.ts';
import { runResearcher } from './researcher-executor.ts';
import { recordResearcherFailure, shouldStopResearch, getResearchStopMessage } from '../utils/session-state.ts';
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
   * Run a research task (Quick or Deep)
   */
  async runResearch(options: ResearchOptions, signal?: AbortSignal): Promise<string> {
    const { ctx, query, depth = 0, model, observer, onUpdate, sessionId, researchId, config, excludeTools } = options;
    const selectedModel = model || ctx.model;

    if (!selectedModel) {
      throw new Error('No model provided for research.');
    }

    const researchStart = Date.now();

    const researchConfig = config || getConfig();

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
          excludeTools,
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
          excludeTools,
          orchestrationService: this,
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
   */
  async cleanupResearchServices(sessionId?: string, researchId?: string): Promise<void> {
    // Cleanup session service
    try {
      const sessionService = await getService<ResearchSessionService>(ServiceNames.RESEARCH_SESSION_SERVICE);
      if (sessionService) {
        await sessionService.cleanup(sessionId);
      }
    } catch (_err) {
      logger.debug('[ResearchOrchestrationService] ResearchSessionService not available for cleanup');
    }
    
    // Clear synthesis reports
    try {
      const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE);
      if (synthesisService) {
        synthesisService.clearReports(researchId || sessionId);
      }
    } catch (_err) {
      logger.debug('[ResearchOrchestrationService] ResearchSynthesisService not available for cleanup');
    }
    
    // Clear planning state
    const planningService = tryGetService<IPlanningService>(ServiceNames.PLANNING);
    if (planningService) {
      planningService.clearPlanningState(researchId || sessionId);
      logger.debug('[ResearchOrchestrationService] Cleared planning state');
    }
    
    if (researchId || sessionId) {
      cleanupSharedLinks(researchId || sessionId || '');
    }

    logger.debug('[ResearchOrchestrationService] Cleaned up research services');
  }

  /**
   * Distribute search results to researchers based on query matching
   * @param plan - Research plan with researchers and queries
   * @param results - Search results from queries
   * @returns Map of researcher ID -> array of URLs
   */
  async distributeSearchResults(plan: ResearchPlan, results: QueryResultWithError[]): Promise<Map<string, string[]>> {
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
   */
  async runResearchers(options: RunResearchersOptions, researcherLinks?: Map<string, string[]>, storeLinks?: Map<string, { url: string; description: string }[]>): Promise<void> {
    const { plan, options: orchestratorOptions, currentRound, signal } = options;
    const { sessionId, researchId, observer } = orchestratorOptions;

    // Obtain the planning service once for all researchers in this round
    let planningService: IPlanningService;
    try {
      planningService = await getService<IPlanningService>(ServiceNames.PLANNING);
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
    const maxConcurrent: number = (orchestratorOptions.config as Config)?.MAX_CONCURRENT_RESEARCHERS ?? 3;

    for (const configItem of researchers) {
      if (signal?.aborted) break;

      // Enforce the concurrency cap before launching the next researcher.
      // Wait for one slot to free up when we're at capacity, or abort immediately if signalled.
      if (active.size >= maxConcurrent) {
        if (signal?.aborted) break;
        await Promise.race([
          ...active,
          ...(signal ? [new Promise<void>((_, reject) => {
            const onAbort = () => reject(new Error('Aborted'));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          })] : [])
        ]).catch(err => {
          if (err.message !== 'Aborted') throw err;
        });
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
            researchConfig: orchestratorOptions.config,
            round: currentRound,
            planningService,
            initialLinks,
            historicalUrls,
            signal,
            excludeTools: orchestratorOptions.excludeTools,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`[ResearchOrchestrationService] Researcher ${id} failed: ${errMsg}`);

          // Record failure for stopping logic
          recordResearcherFailure(sessionId, researchId, id);

          // Notify observer
          observer?.onResearcherFailure?.(id, errMsg);
        }
      })();

      // Prune the promise from the active set when it settles so Promise.race works
      // correctly and active.size stays accurate for the concurrency cap.
      promise.finally(() => active.delete(promise));
      active.add(promise);

      // Throttled launch to prevent resource spikes (stagger by RESEARCHER_LAUNCH_DELAY_MS, skip after last)
      if (RESEARCHER_LAUNCH_DELAY_MS > 0 && researchers.indexOf(configItem) < researchers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, RESEARCHER_LAUNCH_DELAY_MS));
      }

      if (shouldStopResearch(sessionId, researchId)) {
        const sessionService = await getService<ResearchSessionService>(ServiceNames.RESEARCH_SESSION_SERVICE);
        // Abort sessions specifically for this researchId, not the whole piSessionId
        await sessionService.abortAllSessions(researchId);

        const stopMessage = getResearchStopMessage(sessionId, researchId);
        throw new Error(stopMessage);
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
   * @returns Search results
   */
  async runSearchBurst(
    queries: string[],
    config: any,
    signal?: AbortSignal,
    onProgress?: (links: number) => void
  ): Promise<QueryResultWithError[]> {
    const results = await search(queries, config, signal, onProgress);
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
   */
  async storeLinkDescriptions(_sessionId: string, round: number, researchId: string, config: Config): Promise<void> {
    if (!config.LOCAL_KNOWLEDGE_STORE_ENABLED && !config.GLOBAL_KNOWLEDGE_STORE_ENABLED) {
      logger.debug('[ResearchOrchestrationService] Knowledge store disabled, skipping link descriptions');
      return;
    }

    try {
      const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE);
      const writer = await getService<IWriterQueue>(ServiceNames.WRITER_QUEUE);
      
      if (!writer) {
        logger.warn('[ResearchOrchestrationService] Writer queue not available, skipping link descriptions');
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
          if (link.url && link.description) {
            const cachedContent = getCachedScrapedContent(researchId, link.url) ?? undefined;
            writer.enqueue({
              url: normalizeUrl(link.url),
              markdown: link.description,
              content: cachedContent,
              metadata: {
                researchId,
                round,
                researcherId: key,
                description: link.description,
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
        const ksService = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
        if (ksService.isReady()) {
          const store = await ksService.getStore();
          store.rebuildFtsIndex().catch(err => {
            logger.warn('[ResearchOrchestrationService] FTS index rebuild failed (non-fatal):', err);
          });
        }
      } else if (researcherCount > 0) {
        logger.warn(`[ResearchOrchestrationService] No valid citations found among ${researcherCount} researchers in round ${round}`);
      }
    } catch (err) {
      logger.warn('[ResearchOrchestrationService] Failed to store link descriptions (non-fatal):', err);
    }
  }

  /**
   * Run health check and log status
   * @param round - Current round number
   * @param _researchId - Research ID (optional)
   * @returns Promise<boolean> - True if healthy or degraded, false if unhealthy
   */
  async checkHealth(round: number, _researchId?: string): Promise<boolean> {
    if (round <= 1) return true;

    try {
      const health = await healthRegistry.runAll();
      if (health.status === 'healthy') {
        logger.debug(`[ResearchOrchestrationService] Health status at Round ${round}: [OK] All systems operational`);
        return true;
      } else if (health.status === 'degraded') {
        const degraded = health.components.filter(c => !c.healthy).map(c => c.component);
        logger.warn(`[ResearchOrchestrationService] Health status at Round ${round}: [WARN] Degraded (${degraded.join(', ')})`);
        return true;
      } else {
        const failed = health.components.filter(c => !c.healthy).map(c => c.component);
        logger.error(`[ResearchOrchestrationService] Health status at Round ${round}: [ERROR] Unhealthy (${failed.join(', ')})`);
        return false;
      }
    } catch (err) {
      logger.warn('[ResearchOrchestrationService] Failed to check health status:', err);
      return true; // Don't stop research on health check error
    }
  }
}
