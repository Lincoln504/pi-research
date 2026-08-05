/**
 * Web Research Extension - Search Orchestrator
 *
 * Exclusively uses browser-based search (DuckDuckGo Lite) via a managed pool.
 */

import { logger } from '../logger.ts';
import { performSearch } from './browser-search.ts';
import type { QueryResultWithError, QueryFailure } from './types.ts';
import type { Config } from '../config.ts';
import { metrics } from '../utils/metrics.ts';
import { getServiceContainer } from '../core/service-registry.ts';
import type { ServiceContainer } from '../core/service-registry.ts';

// ============================================================================
// Multiple Query Search
// ============================================================================

/**
 * Search multiple queries via the Browser-based Search Queue.
 *
 * @param queries - Array of search query strings
 * @param config - Optional configuration override
 * @param signal - Optional AbortSignal
 * @param onProgress - Optional callback with cumulative link count across completed queries
 * @returns Promise<QueryResultWithError[]> - Array of search results with error information
 */
export async function search(
  queries: string[],
  config?: Config,
  signal?: AbortSignal,
  onProgress?: (links: number) => void,
  container: ServiceContainer = getServiceContainer()
): Promise<QueryResultWithError[]> {
  if (queries.length === 0) return [];
  
  logger.log(`[Search] Orchestrating ${queries.length} queries via Browser Queue...`);
  metrics.observe('search_query_count_per_request', queries.length);
  const searchStart = Date.now();
  
  try {
    // Per-query failures (timeout / dead worker) come back separately from the
    // results so an empty result set can be attributed correctly below.
    const failures = new Map<string, QueryFailure>();
    const resultMap = await performSearch(queries, config, signal, onProgress, container, failures);
    const searchDuration = Date.now() - searchStart;
    metrics.observe('search_latency_ms', searchDuration);
    
    let totalResults = 0;
    let successfulQueries = 0;
    let failedQueries = 0;
    
    const results = queries.map(q => {
      const qResults = resultMap.get(q) || [];
      const result: QueryResultWithError = { query: q, results: qResults };
      
      if (qResults.length > 0) {
        totalResults += qResults.length;
        successfulQueries++;
        metrics.observe('search_results_per_query', qResults.length);
      } else {
        // Only call it an empty result when the search actually completed and
        // returned nothing. A recorded failure (timeout, dead worker, breaker
        // fast-fail) carries its own message — telling the researcher "the query
        // may be too narrow" for an infrastructure fault makes it rewrite a
        // perfectly good query instead of retrying.
        result.error = failures.get(q) ?? {
          type: 'empty_results',
          message: 'Browser-based search returned no relevant results for this query (the query may be too narrow, or the site returned nothing usable).'
        };
        failedQueries++;
      }
      return result;
    });
    
    metrics.observe('search_results_total', totalResults);
    metrics.increment('search_queries_total', successfulQueries, { status: 'success' });
    metrics.increment('search_queries_total', failedQueries, { status: 'failed' });
    metrics.observe('search_success_ratio', successfulQueries / queries.length);
    
    return results;
  } catch (error) {
    const searchDuration = Date.now() - searchStart;
    metrics.observe('search_latency_ms', searchDuration, { status: 'error' });
    metrics.increment('search_queries_total', queries.length, { status: 'error' });
    metrics.increment('search_errors_total', 1, { error_type: 'search_failed' });
    
    const message = error instanceof Error ? error.message : String(error);
    // A cancelled run must propagate as a cancellation. Swallowing it into
    // per-query `unknown` errors would let the orchestrator carry on and
    // synthesize from nothing, then report a failure the user never had.
    if (signal?.aborted || message === 'Aborted') {
      throw error;
    }
    // Re-throw total search failure so the orchestrator can surface a clear error
    // rather than silently producing an empty synthesis with zero links.
    if (message.includes('Search completely failed')) {
      metrics.increment('search_errors_total', 1, { error_type: 'total_search_failure' });
      throw error;
    }
    logger.error(`[Search] Orchestration failed:`, error);
    metrics.increment('search_errors_total', 1, { error_type: 'orchestration_error' });
    return queries.map(q => ({
      query: q,
      results: [],
      error: { type: 'unknown', message }
    }));
  }
}