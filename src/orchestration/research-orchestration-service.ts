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
import { search } from '../web-research/search.ts';
import { parseCitations } from '../utils/text-utils.ts';
import { logger } from '../logger.ts';
import { healthRegistry } from '../healthcheck/index.ts';
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IWriterQueue, IResearchOrchestration } from '../core/service-interfaces.ts';
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

    const researchers = plan.researchers || [];
    const active = new Set<Promise<void>>();

    for (const configItem of researchers) {
      if (signal?.aborted) break;

      const promise = (async () => {
        const id = String(configItem.id);
        try {
          const initialLinks = researcherLinks?.get(id) || [];
          const historicalUrls = configItem.historicalLinks || [];

          await runResearcher({
            ...orchestratorOptions,
            configItem,
            initialLinks,
            historicalUrls,
            currentRound,
            signal
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

      active.add(promise);

      // Throttled launch to prevent resource spikes
      const RESEARCHER_LAUNCH_DELAY_MS = orchestratorOptions.config?.RESEARCHER_LAUNCH_DELAY_MS ?? 1000;
      if (RESEARCHER_LAUNCH_DELAY_MS > 0 && researchers.indexOf(configItem) < researchers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, RESEARCHER_LAUNCH_DELAY_MS));
      }

      if (active.size > 0) {
        // We use Promise.race to keep concurrency controlled if we had a limit here,
        // but currently we launch all with a delay. 
        // We still check if we should stop after each launch.
        
        const { shouldStopResearch } = await import('../utils/session-state.ts');
        if (shouldStopResearch(sessionId, researchId)) {
          const { getResearchSessionService } = await import('./research-session-manager.ts');
          const sessionService = await getResearchSessionService();
          await sessionService.abortAllSessions();

          throw new Error('Research stopped due to excessive infrastructure failures. Multiple researchers failed.');
        }
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
   * @param round - Round number
   * @param researchId - Research ID
   * @param config - Research configuration
   */
  async storeLinkDescriptions(round: number, researchId: string, config: any): Promise<void> {
    if (!config.KNOWLEDGE_STORE_ENABLED) return;

    try {
      const { getResearchSynthesisService } = await import('./research-session-manager.ts');
      const synthesisService = await getResearchSynthesisService();
      const writer = await getService<IWriterQueue>(ServiceNames.WRITER_QUEUE);
      const roundPrefix = `${round}.`;
      let enqueued = 0;

      for (const [key, report] of synthesisService.getAllReports().entries()) {
        if (!key.startsWith(roundPrefix)) continue;

        const links = parseCitations(report);
        if (links.length === 0) {
          logger.warn(`[ResearchOrchestrationService] Researcher ${key} produced no parseable CITED LINKS - no descriptions stored`);
          continue;
        }

        for (const link of links) {
          const content = getCachedScrapedContent(researchId, link.url);
          if (content) {
            await writer.enqueue({
              url: normalizeUrl(link.url),
              text: content,
              metadata: {
                researchId,
                round,
                researcherId: key,
                description: link.description,
                sourceOrigin: link.url,
              }
            });
            enqueued++;
          }
        }
      }

      if (enqueued > 0) {
        await writer.drain();
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
        logger.debug(`[ResearchOrchestrationService] Health status at Round ${round}: ✅ All systems operational`);
        return true;
      } else if (health.status === 'degraded') {
        const degraded = health.components.filter(c => !c.healthy).map(c => c.component);
        logger.warn(`[ResearchOrchestrationService] Health status at Round ${round}: ⚠️ Degraded (${degraded.join(', ')})`);
        return true;
      } else {
        const failed = health.components.filter(c => !c.healthy).map(c => c.component);
        logger.error(`[ResearchOrchestrationService] Health status at Round ${round}: ❌ Unhealthy (${failed.join(', ')})`);
        return false;
      }
    } catch (err) {
      logger.warn('[ResearchOrchestrationService] Failed to check health status:', err);
      return true; // Don't stop research on health check error
    }
  }
}
