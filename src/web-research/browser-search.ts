/**
 * Web Research Extension - Browser-based Search (DuckDuckGo Lite)
 * 
 * Orchestrates exhaustive search bursts across multiple worker processes.
 */

import { runWorkerSearch } from '../infrastructure/browser-manager.ts';
import { logger } from '../logger.ts';
import type { SearXNGResult } from './types.ts';

/**
 * Orchestrate high-fidelity search across multiple queries.
 * Uses true multithreaded worker processes for maximum burst performance.
 * Each worker maintains its own "warm" browser process.
 */
export async function performSearch(queries: string[], signal?: AbortSignal): Promise<Map<string, SearXNGResult[]>> {
    const resultMap = new Map<string, SearXNGResult[]>();
    
    logger.log(`[Search] Queuing ${queries.length} queries across worker processes...`);

    const searchPromises = queries.map(async (query) => {
        if (signal?.aborted || !query) return;
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
    });

    await Promise.all(searchPromises);
    return resultMap;
}
