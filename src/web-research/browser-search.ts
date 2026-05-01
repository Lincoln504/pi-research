/**
 * Web Research Extension - Browser-based Search (DuckDuckGo Lite)
 * 
 * Orchestrates exhaustive search bursts across multiple worker processes.
 */

import { runWorkerSearch, MAX_WORKERS } from '../infrastructure/browser-manager.ts';
import { logger } from '../logger.ts';
import type { SearchResult } from './types.ts';

/**
 * Orchestrate high-fidelity search across multiple queries.
 * Uses true multithreaded worker processes for maximum burst performance.
 * Each worker maintains its own "warm" browser process.
 */
export async function performSearch(queries: string[], signal?: AbortSignal): Promise<Map<string, SearchResult[]>> {
    const resultMap = new Map<string, SearchResult[]>();
    
    logger.log(`[Search] Orchestrating ${queries.length} queries across ${MAX_WORKERS} worker threads...`);

    const activePromises = new Set<Promise<void>>();

    for (const query of queries) {
        if (signal?.aborted) break;
        if (!query) continue;

        const promise = (async () => {
            try {
                // Offload search to Poolifier worker
                const results = await runWorkerSearch(query);
                resultMap.set(query, results || []);
                
                if (results?.length > 0) {
                    logger.debug(`[Search] ✓ Worker returned ${results.length} results for: ${query}`);
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error(`[Search] Worker failed for "${query}": ${msg}`);
                resultMap.set(query, []);
            }
        })();

        activePromises.add(promise);
        promise.finally(() => activePromises.delete(promise));

        // Maintain strict concurrency limit to prevent system overload
        if (activePromises.size >= MAX_WORKERS) {
            await Promise.race(activePromises);
        }
    }

    await Promise.all(activePromises);

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
