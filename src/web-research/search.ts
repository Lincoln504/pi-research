/**
 * Web Research Extension - Search Orchestrator
 *
 * Exclusively uses browser-based search (DuckDuckGo Lite) via a managed pool.
 */

import { logger } from '../logger.ts';
import { performSearch } from './browser-search.ts';
import type { QueryResultWithError } from './types.ts';

// ============================================================================
// Multiple Query Search
// ============================================================================

/**
 * Search multiple queries via the Browser-based Search Queue.
 *
 * @param queries - Array of search query strings
 * @param _options - (Ignored) Legacy options
 * @param signal - Optional AbortSignal
 * @param onProgress - Optional callback with cumulative link count across completed queries
 * @returns Promise<QueryResultWithError[]> - Array of search results with error information
 */
export async function search(
  queries: string[],
  _options?: any,
  signal?: AbortSignal,
  onProgress?: (links: number) => void
): Promise<QueryResultWithError[]> {
  if (queries.length === 0) return [];
  
  logger.log(`[Search] Orchestrating ${queries.length} queries via Browser Queue...`);
  
  try {
    const resultMap = await performSearch(queries, signal, onProgress);
    
    return queries.map(q => {
      const results = resultMap.get(q) || [];
      const result: QueryResultWithError = { query: q, results };
      
      if (results.length === 0) {
        result.error = { 
          type: 'empty_results', 
          message: 'Browser-based search returned no results. This may indicate an IP block or lack of relevant data.' 
        };
      }
      return result;
    });
  } catch (error) {
    logger.error(`[Search] Orchestration failed:`, error);
    return queries.map(q => ({
      query: q,
      results: [],
      error: { 
        type: 'unknown', 
        message: error instanceof Error ? error.message : String(error) 
      }
    }));
  }
}
