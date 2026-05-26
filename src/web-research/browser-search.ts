/**
 * Web Research Extension - Browser-based Search (DuckDuckGo Lite)
 * 
 * Orchestrates exhaustive search bursts across multiple worker processes.
 */

import { runWorkerSearch } from '../infrastructure/browser/task-execution-service.ts';
import { getMaxWorkers } from '../infrastructure/browser/config.ts';
import { logger } from '../logger.ts';
import type { SearchResult } from './types.ts';
import type { Config } from '../config.ts';
import { metrics } from '../utils/metrics.ts';

/**
 * Orchestrate high-fidelity search across multiple queries.
 * Uses true multithreaded worker processes for maximum burst performance.
 * Each worker maintains its own "warm" browser process.
 */
export async function performSearch(
    queries: string[], 
    config?: Config,
    signal?: AbortSignal,
    onProgress?: (links: number) => void
): Promise<Map<string, SearchResult[]>> {
    const startTime = Date.now();
    const resultMap = new Map<string, SearchResult[]>();
    const seenUrls = new Set<string>();
    const maxWorkers = getMaxWorkers(config);

    metrics.setGauge('browser_search_max_workers', maxWorkers);
    metrics.increment('browser_search_orchestrations_total', 1);
    metrics.increment('browser_search_queries_total', queries.length);

    logger.log(`[Search] Orchestrating ${queries.length} queries across ${maxWorkers} worker processes...`);

    const filteredQueries = queries.filter(q => q.trim());
    const searchTasks = filteredQueries.map(async (query) => {
        if (signal?.aborted) {
            resultMap.set(query, []);
            metrics.increment('browser_search_queries_total', 1, { status: 'aborted' });
            return;
        }
        const queryStartTime = Date.now();
        try {
            const results = await runWorkerSearch(query, config);
            const queryDuration = Date.now() - queryStartTime;
            metrics.observe('browser_search_query_duration_ms', queryDuration);
            metrics.increment('browser_search_queries_total', 1, { status: 'success' });
            
            if (results?.length > 0) {
                metrics.increment('browser_search_results_total', results.length);
                logger.debug(`[Search] ✓ Worker returned ${results.length} results for: ${query}`);
                
                // Deduplicate results across queries to prevent redundant scraping
                const uniqueResults = [];
                for (const r of results) {
                    if (r.url) {
                        if (!seenUrls.has(r.url)) {
                            seenUrls.add(r.url);
                            uniqueResults.push(r);
                        }
                    }
                }
                resultMap.set(query, uniqueResults);
                if (uniqueResults.length < results.length) {
                    logger.debug(`[Search] Deduplicated ${results.length - uniqueResults.length} redundant results for: ${query}`);
                }
            } else {
                metrics.increment('browser_search_queries_total', 1, { status: 'no_results' });
                resultMap.set(query, []);
            }
        } catch (error) {
            const queryDuration = Date.now() - queryStartTime;
            metrics.observe('browser_search_query_duration_ms', queryDuration, { status: 'error' });
            metrics.increment('browser_search_queries_total', 1, { status: 'error' });
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`[Search] Worker failed for "${query}": ${msg}`);
            resultMap.set(query, []);
        } finally {
            if (onProgress) onProgress(seenUrls.size);
        }
    });

    await Promise.all(searchTasks);

    // Detect total failure: if every valid query returned empty, the worker pool is likely dead.
    const totalResults = Array.from(resultMap.values()).reduce((sum, r) => sum + r.length, 0);
    if (totalResults === 0 && filteredQueries.length > 0) {
        metrics.increment('browser_search_total_failures_total', 1);
        throw new Error(
            `Search completely failed: all ${filteredQueries.length} queries returned no results. ` +
            `Browser workers may be unavailable or DuckDuckGo is unreachable.`
        );
    }

    const totalDuration = Date.now() - startTime;
    metrics.observe('browser_search_total_duration_ms', totalDuration);
    metrics.increment('browser_search_unique_urls_total', seenUrls.size);

    return resultMap;
}
