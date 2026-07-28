/**
 * Web Research Extension - Browser-based Search (DuckDuckGo Lite)
 * 
 * Orchestrates exhaustive search bursts across multiple worker processes.
 */

import { runWorkerSearch } from '../infrastructure/browser/task-execution-service.ts';
import { getMaxWorkers } from '../infrastructure/browser/config.ts';
import { logger } from '../logger.ts';
import { safeUnref } from '../utils/safe-unref.ts';
import { normalizeUrl } from '../utils/url-utils.ts';
import type { SearchResult } from './types.ts';
import type { Config } from '../config.ts';
import { metrics } from '../utils/metrics.ts';
import { getServiceContainer } from '../core/service-registry.ts';
import type { ServiceContainer } from '../core/service-registry.ts';

/**
 * Orchestrate high-fidelity search across multiple queries.
 * Uses true multithreaded worker processes for maximum burst performance.
 * Each worker maintains its own "warm" browser process.
 */
export async function performSearch(
    queries: string[], 
    config?: Config,
    signal?: AbortSignal,
    onProgress?: (links: number) => void,
    container: ServiceContainer = getServiceContainer()
): Promise<Map<string, SearchResult[]>> {
    const startTime = Date.now();
    const resultMap = new Map<string, SearchResult[]>();
    const seenUrls = new Set<string>();

    // FULL_MOCK_MODE: When both PI_RESEARCH_MOCK_SEARCH and PI_RESEARCH_MOCK_SCRAPE
    // are true, return deterministic mock results without spawning any worker processes.
    // This gate keeps CI tests deterministic and fast, and prevents real worker pool
    // failures from cascading into test flakiness.
    const fullMockMode = process.env['PI_RESEARCH_MOCK_SEARCH'] === 'true' &&
                         process.env['PI_RESEARCH_MOCK_SCRAPE'] === 'true';
    if (fullMockMode) {
      logger.log('[Search] FULL_MOCK_MODE enabled — returning mock results without worker pool');
      for (const q of queries) {
        const domain = q.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().slice(0, 30);
        resultMap.set(q, [{
          title: `Mock result for: ${q}`,
          url: `https://mock.example.com/${domain}`,
          content: `This is a mock search result for query "${q}".`,
        }]);
      }
      return resultMap;
    }

    const maxWorkers = getMaxWorkers(config);

    metrics.setGauge('browser_search_max_workers', maxWorkers);
    metrics.increment('browser_search_orchestrations_total', 1);

    logger.log(`[Search] Orchestrating ${queries.length} queries across ${maxWorkers} worker processes...`);

    // Call onProgress(0) immediately to clear any 'searching' placeholder in the UI
    if (onProgress) onProgress(0);

    // Hard cap per query so a single Cloudflare block or hung browser worker
    // cannot stall the entire Promise.all burst.
    //
    // The budget is the worker's nav budget (SEARCH_TIMEOUT_MS) PLUS the
    // queue-wait/overhead margin (BROWSER_TASK_TIMEOUT_MS), mirroring the
    // scheduler's own task-timeout ceiling in BrowserTaskScheduler.runSearch
    // (= SEARCH_TIMEOUT_MS + BROWSER_TASK_TIMEOUT_MS). This clock starts at
    // ENQUEUE (before runWorkerSearch queues onto the shared browser pool), so
    // a budget of only SEARCH_TIMEOUT_MS would let a query that sat in the
    // saturated worker queue burn its ENTIRE nav budget waiting for a slot and
    // abort with zero actual search work — exactly the "Query timed out after
    // 45000ms (likely blocked or slow startup)" cascade observed under
    // concurrent load. Including the margin lets a queued query still use its
    // full nav budget once a worker picks it up, and keeps this layer's hard
    // cap coherent with the scheduler's so it never preempts the worker's own
    // (post-dequeue) deadline.
    const QUERY_TIMEOUT_MS = (config?.SEARCH_TIMEOUT_MS ?? 45_000) + (config?.BROWSER_TASK_TIMEOUT_MS ?? 10_000);

    const filteredQueries = queries.filter(q => q.trim());
    let timeoutCount = 0;
    let errorCount = 0;
    // Keep one representative worker error so total-failure surfaces the real
    // cause (e.g. a worker that cannot load its module) instead of a generic
    // timeout guess that misdirects to the network or system load.
    let sampleWorkerError = '';

    const searchTasks = filteredQueries.map(async (query) => {
        const queryStartTime = Date.now();
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), QUERY_TIMEOUT_MS);
        safeUnref(timeoutId);

        try {
            if (signal?.aborted) {
                resultMap.set(query, []);
                return;
            }

            const querySignal = signal
              ? AbortSignal.any([signal, timeoutController.signal])
              : timeoutController.signal;

            const results = await runWorkerSearch(query, config, querySignal, 1, undefined, container);
            const queryDuration = Date.now() - queryStartTime;
            metrics.observe('browser_search_query_duration_ms', queryDuration);

            if (results?.length > 0) {
                metrics.increment('browser_search_queries_total', 1, { status: 'success' });
                metrics.increment('browser_search_results_total', results.length);
                logger.debug(`[Search] Worker returned ${results.length} results for: ${query}`);

                const uniqueResults: SearchResult[] = [];
                for (const r of results) {
                    // Dedup across ALL queries (seenUrls), not just within this query.
                    // The same URL surfacing for several queries would otherwise repeat
                    // its snippet in the combined output, wasting context tokens; this
                    // also makes seenUrls.size a true cross-query unique count for the
                    // progress callback and the unique-URLs metric.
                    // Dedup on the NORMALIZED url (consistent with shared-links / knowledge store),
                    // so http/https, trailing-slash, and tracking-param variants of the same page
                    // collapse to one — otherwise snippets repeat across queries (wasting context)
                    // and seenUrls.size over-counts uniques for the progress callback / metric.
                    const key = r.url ? normalizeUrl(r.url) : '';
                    if (key && !seenUrls.has(key)) {
                        seenUrls.add(key);
                        uniqueResults.push(r);
                    }
                }
                resultMap.set(query, uniqueResults);
            } else {
                metrics.increment('browser_search_queries_total', 1, { status: 'no_results' });
                resultMap.set(query, []);
            }
        } catch (error) {
            const queryDuration = Date.now() - queryStartTime;
            const isTimeout = timeoutController.signal.aborted && !signal?.aborted;
            const status = isTimeout ? 'timeout' : 'error';
            
            if (isTimeout) timeoutCount++;
            else errorCount++;

            metrics.observe('browser_search_query_duration_ms', queryDuration, { status });
            metrics.increment('browser_search_queries_total', 1, { status });
            
            if (isTimeout) {
                logger.warn(`[Search] Query timed out after ${QUERY_TIMEOUT_MS}ms — likely starved waiting for a free browser worker under concurrent load, or a slow/blocked search provider: "${query}"`);
            } else {
                const msg = error instanceof Error ? error.message : String(error);
                if (msg !== 'Aborted') {
                    if (!sampleWorkerError) sampleWorkerError = msg;
                    logger.error(`[Search] Worker failed for "${query}": ${msg}`);
                }
            }
            resultMap.set(query, []);
        } finally {
            clearTimeout(timeoutId);
            if (onProgress) onProgress(seenUrls.size);
        }
    });

    await Promise.all(searchTasks);

    // Detect total failure: if every valid query returned empty, the worker pool is likely dead.
    const totalResults = Array.from(resultMap.values()).reduce((sum, r) => sum + r.length, 0);
    if (totalResults === 0 && filteredQueries.length > 0) {
        metrics.increment('browser_search_total_failures_total', 1);
        
        let reason = `all ${filteredQueries.length} queries returned no results`;
        if (timeoutCount === filteredQueries.length) {
            reason = `all ${filteredQueries.length} queries timed out after ${QUERY_TIMEOUT_MS}ms`;
        } else if (errorCount === filteredQueries.length) {
            reason = `all ${filteredQueries.length} queries encountered worker errors`;
        } else if (timeoutCount + errorCount === filteredQueries.length) {
            reason = `${timeoutCount} queries timed out and ${errorCount} queries failed`;
        }

        throw new Error(
            `Search completely failed: ${reason}. ` +
            `Browser workers may be unavailable, DuckDuckGo is unreachable, or the system is under extreme load.` +
            (sampleWorkerError ? ` Last worker error: ${sampleWorkerError}` : '')
        );
    }

    const totalDuration = Date.now() - startTime;
    metrics.observe('browser_search_total_duration_ms', totalDuration);
    metrics.increment('browser_search_unique_urls_total', seenUrls.size);

    return resultMap;
}
