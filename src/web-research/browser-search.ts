/**
 * Web Research Extension - Browser-based Search (DuckDuckGo Lite)
 * 
 * Orchestrates exhaustive search bursts across multiple worker processes.
 */

import { runWorkerSearch, getMaxWorkers } from '../infrastructure/browser-manager.ts';
import { logger } from '../logger.ts';
import type { SearchResult } from './types.ts';
import type { Config } from '../config.ts';

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
    const resultMap = new Map<string, SearchResult[]>();
    const seenUrls = new Set<string>();
    const maxWorkers = getMaxWorkers(config);

    logger.log(`[Search] Orchestrating ${queries.length} queries across ${maxWorkers} worker threads...`);

    // Fire all queries concurrently - the FixedThreadPool manages concurrency via task queue
    const searchTasks = queries.filter(q => q).map(async (query) => {
        if (signal?.aborted) {
            resultMap.set(query, []);
            return;
        }
        try {
            const results = await runWorkerSearch(query, config);
            resultMap.set(query, results || []);
...
            if (results?.length > 0) {
                logger.debug(`[Search] ✓ Worker returned ${results.length} results for: ${query}`);
                for (const r of results) { if (r.url) seenUrls.add(r.url); }
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`[Search] Worker failed for "${query}": ${msg}`);
            resultMap.set(query, []);
        } finally {
            if (onProgress) onProgress(seenUrls.size);
        }
    });

    await Promise.all(searchTasks);

    // Detect total failure: if every query returned empty, the worker pool is likely dead.
    const totalResults = Array.from(resultMap.values()).reduce((sum, r) => sum + r.length, 0);
    if (totalResults === 0 && queries.length > 0) {
        throw new Error(
            `Search completely failed: all ${queries.length} queries returned no results. ` +
            `Browser workers may be unavailable or DuckDuckGo is unreachable.`
        );
    }

    return resultMap;
}
