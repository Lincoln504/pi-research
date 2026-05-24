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
import type { ResearchObserver } from './research-observer.ts';
import type { RunResearchersOptions } from './orchestration-types.ts';
import { search } from '../web-research/search.ts';
import { parseCitations } from '../utils/text-utils.ts';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import { healthRegistry } from '../healthcheck/index.ts';
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IWriterQueue } from '../core/service-interfaces.ts';
import { getCachedScrapedContent, normalizeUrl } from '../utils/shared-links.ts';
import {
  RESEARCHER_LAUNCH_DELAY_MS,
} from '../constants.ts';
import { shouldStopResearch } from '../utils/session-state.ts';
import { runResearcher } from './researcher-executor.ts';

/**
 * Research Orchestration Service
 *
 * Handles core orchestration logic for multi-round research.
 */
export class ResearchOrchestrationService {
  /**
   * Distribute search results to researchers based on query matching
   * @param plan - Research plan with researchers and queries
   * @param results - Search results from queries
   * @returns Map of researcher ID -> array of URLs
   */
  distributeResults(plan: ResearchPlan, results: QueryResultWithError[]): Map<string, string[]> {
    const startTime = Date.now();
    const linkMap = new Map<string, string[]>();
    if (!plan.researchers) return linkMap;

    plan.researchers.forEach((r) => {
      const ownedLinks: string[] = [];
      const rQueries = new Set(
        r.queries
          .map((q: string) => q.toLowerCase().trim())
          .filter(q => q.length > 0)
      );

      const rQueriesArr = Array.from(rQueries);

      results.forEach((res) => {
        const resQuery = String(res.query ?? '').toLowerCase().trim();
        if (resQuery.length === 0) return;

        let matched = rQueries.has(resQuery);

        if (!matched) {
          for (let i = 0; i < rQueriesArr.length; i++) {
            const rq = rQueriesArr[i] as string;
            if (resQuery.includes(rq) || rq.includes(resQuery)) {
              matched = true;
              break;
            }
          }
        }

        if (matched) {
          const items = res.results ?? [];
          for (let i = 0; i < items.length; i++) {
            const url = items[i]?.url;
            if (url) ownedLinks.push(url);
          }
        }
      });
      linkMap.set(String(r.id), Array.from(new Set(ownedLinks)));
    });

    logger.debug(`[ResearchOrchestrationService] Distributed ${results.length} results in ${Date.now() - startTime}ms`);
    return linkMap;
  }

  /**
   * Run multiple researchers in parallel with concurrency control
   * @param options - Options for running researchers
   */
  async runResearchersParallel(options: RunResearchersOptions): Promise<void> {
    const {
      configs,
      linksMap,
      sessionId,
      researchId,
      round,
      query,
      complexity,
      ctx,
      model,
      researchConfig: config,
      planningService,
      observer,
      signal,
      sessionStart,
    } = options;

    const queue = [...configs];
    const active = new Set<Promise<void>>();
    const { MAX_CONCURRENT_RESEARCHERS } = config;
    let lastLaunchTime = 0;

    while (queue.length > 0 || active.size > 0) {
      if (signal?.aborted) throw new Error('Research aborted.');

      while (active.size < MAX_CONCURRENT_RESEARCHERS && queue.length > 0) {
        const now = Date.now();
        const timeSinceLastLaunch = now - lastLaunchTime;
        if (lastLaunchTime > 0 && timeSinceLastLaunch < RESEARCHER_LAUNCH_DELAY_MS) {
          await new Promise(resolve => setTimeout(resolve, RESEARCHER_LAUNCH_DELAY_MS - timeSinceLastLaunch));
        }

        const configItem = queue.shift()!;
        lastLaunchTime = Date.now();
        const links = linksMap.get(String(configItem.id)) || [];
        const histLinks = configItem.historicalLinks || [];

        const p = runResearcher({
          config: configItem,
          initialLinks: links,
          historicalUrls: histLinks,
          sessionId,
          researchId,
          round,
          query,
          complexity,
          ctx,
          model,
          researchConfig: config,
          planningService,
          observer,
          signal,
          sessionStart,
        }).catch((err) => {
          const errMsg = err.message || String(err);
          logger.error(`[ResearchOrchestrationService] Researcher ${configItem.id} failed: ${errMsg}`);
          observer?.onResearcherFailure?.(String(configItem.id), errMsg);
          import('../utils/session-state.ts').then(({ recordResearcherFailure }) => {
            recordResearcherFailure(sessionId, researchId, String(configItem.id));
          });
        }).finally(() => {
          active.delete(p);
        });

        active.add(p);
      }

      if (active.size > 0) {
        await Promise.race(active);

        if (shouldStopResearch(sessionId, researchId)) {
          const sessionService = (await import('./research-session-manager.ts')).getResearchSessionService();
          await sessionService.abortAllSessions();

          throw new Error('Research stopped due to excessive infrastructure failures. Multiple researchers failed.');
        }
      }
    }
  }

  /**
   * Run a search burst for the given queries
   * @param queries - Array of search queries
   * @param config - Research configuration
   * @param observer - Optional observer for progress callbacks
   * @param signal - Optional abort signal
   * @returns Search results
   */
  async runSearchBurst(
    queries: string[],
    config: any,
    complexity: 1 | 2 | 3,
    observer?: ResearchObserver,
    signal?: AbortSignal
  ): Promise<QueryResultWithError[]> {
    observer?.onSearchStart?.(queries);
    const searchStartMs = Date.now();
    const searchResults = await search(queries, config, signal, (links) => {
      observer?.onSearchProgress?.(links);
    });
    const searchDuration = Date.now() - searchStartMs;
    metrics.observe('research_search_latency_ms', searchDuration, { mode: 'deep', complexity: String(complexity) });
    const totalResults = searchResults.reduce((acc, r) => acc + (r.results?.length || 0), 0);
    metrics.observe('research_search_results_total', totalResults, { mode: 'deep', complexity: String(complexity) });
    observer?.onSearchComplete?.(totalResults);
    logger.info(`[ResearchOrchestrationService] Search burst completed. Total results: ${totalResults}`);
    return searchResults;
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
      const synthesisService = (await import('./research-session-manager.ts')).getResearchSynthesisService();
      const writer = await getService<IWriterQueue>(ServiceNames.WRITER_QUEUE);
      const roundPrefix = `${round}.`;
      let enqueued = 0;

      for (const [key, report] of synthesisService.getAllReports().entries()) {
        if (!key.startsWith(roundPrefix)) continue;
        const citations = parseCitations(report);
        if (citations.length === 0) {
          logger.warn(`[ResearchOrchestrationService] Researcher ${key} produced no parseable CITED LINKS - no descriptions stored`);
        }
        for (const cit of citations) {
          if (cit.url && cit.description) {
            writer.enqueue({
              url: normalizeUrl(cit.url),
              markdown: cit.description,
              content: getCachedScrapedContent(researchId, cit.url),
              metadata: {
                ingestionType: 'synthesis-description',
                source: 'researcher',
                sourceOrigin: cit.source,
                synthesizedAt: new Date().toISOString(),
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
   */
  async runHealthCheck(round: number): Promise<void> {
    if (round <= 1) return;

    try {
      const health = await healthRegistry.runAll();
      if (health.status === 'healthy') {
        logger.debug(`[ResearchOrchestrationService] Health status at Round ${round}: ✅ All systems operational`);
      } else if (health.status === 'degraded') {
        const degraded = health.components.filter(c => !c.healthy).map(c => c.component);
        logger.warn(`[ResearchOrchestrationService] Health status at Round ${round}: ⚠️ Degraded (${degraded.join(', ')})`);
      } else {
        const failed = health.components.filter(c => !c.healthy).map(c => c.component);
        logger.error(`[ResearchOrchestrationService] Health status at Round ${round}: ❌ Unhealthy (${failed.join(', ')})`);
      }
    } catch (err) {
      logger.warn('[ResearchOrchestrationService] Failed to check health status:', err);
    }
  }

  /**
   * Get elapsed time since start
   * @param startTime - Start time in milliseconds
   * @returns Formatted elapsed time string
   */
  getElapsedTime(startTime: number): string {
    const s = Math.round((Date.now() - startTime) / 1000);
    return `+${s}s`;
  }
}