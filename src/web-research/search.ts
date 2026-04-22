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
 * @param _options - (Ignored) Legacy SearXNG filter options
 * @param signal - Optional AbortSignal
 * @returns Promise<QueryResultWithError[]> - Array of search results with error information
 */
export async function search(queries: string[], _options?: any, signal?: AbortSignal): Promise<QueryResultWithError[]> {
  if (queries.length === 0) return [];
  
  logger.log(`[Search] Orchestrating ${queries.length} queries via Browser Queue...`);
  
  try {
    const resultMap = await performSearch(queries, signal);
    
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
