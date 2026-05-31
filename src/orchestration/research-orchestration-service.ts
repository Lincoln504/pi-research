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

import type { ResearchPlan } from '../core/service-interfaces.ts';
import type { QueryResultWithError } from '../web-research/types.ts';
import type { RunResearchersOptions } from './orchestration-types.ts';
import { RESEARCHER_LAUNCH_DELAY_MS } from '../constants.ts';
import { search } from '../web-research/search.ts';
import { parseCitations } from '../utils/text-utils.ts';
import { logger } from '../logger.ts';
import { healthRegistry } from '../healthcheck/index.ts';
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IWriterQueue, IResearchOrchestration } from '../core/service-interfaces.ts';
import type { Config } from '../config.ts';
import { getCachedScrapedContent, normalizeUrl } from '../utils/shared-links.ts';
import { runResearcher } from './researcher-executor.ts';
import { ServiceLifecycle } from '../core/service-registry.ts';

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
  async runResearchers(options: RunResearchersOptions, researcherLinks?: Map<string, string[]>): Promise<void> {
    const { plan, options: orchestratorOptions, currentRound, signal } = options;
    const { sessionId, researchId, observer } = orchestratorOptions;

    // Obtain the planning service once for all researchers in this round
    let planningService: any;
    try {
      planningService = await getService<any>(ServiceNames.PLANNING);
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
    const maxConcurrent: number = (orchestratorOptions.config as any)?.MAX_CONCURRENT_RESEARCHERS ?? 3;

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
          const historicalUrls = configItem.historicalLinks || [];

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
          const { recordResearcherFailure } = await import('../utils/session-state.ts');
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

      const { shouldStopResearch } = await import('../utils/session-state.ts');
      if (shouldStopResearch(sessionId, researchId)) {
        const { getResearchSessionService } = await import('./research-session-manager.ts');
        const sessionService = await getResearchSessionService();
        // Abort sessions specifically for this researchId, not the whole piSessionId
        await sessionService.abortAllSessions(researchId);

        throw new Error('Research stopped due to excessive infrastructure failures. Multiple researchers failed.');
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
  async storeLinkDescriptions(sessionId: string, round: number, researchId: string, config: Config): Promise<void> {
    if (config.KNOWLEDGE_STORE_ENABLED !== true) {
      logger.debug('[ResearchOrchestrationService] Knowledge store disabled, skipping link descriptions');
      return;
    }

    try {
      const { getResearchSynthesisService } = await import('./research-session-manager.ts');
      const synthesisService = await getResearchSynthesisService();
      const writer = await getService<IWriterQueue>(ServiceNames.WRITER_QUEUE);
      
      if (!writer) {
        logger.warn('[ResearchOrchestrationService] Writer queue not available, skipping link descriptions');
        return;
      }
      
      const roundPrefix = `${round}.`;
      let enqueued = 0;
      let researcherCount = 0;

      const allReports = synthesisService.getAllReports(sessionId);
      if (allReports.size === 0) {
        logger.warn(`[ResearchOrchestrationService] No reports found in synthesis service for session ${sessionId} round ${round}`);
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
            writer.enqueue({
              url: normalizeUrl(link.url),
              markdown: link.description,
              metadata: {
                researchId,
                round,
                researcherId: key,
                description: link.description,
                sourceOrigin: link.url,
                fullContentSnippet: getCachedScrapedContent(researchId, link.url)?.substring(0, 5000)
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
