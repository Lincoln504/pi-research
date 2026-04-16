/**
 * Web Research Extension - Search Only (search)
 *
 * Search via SearXNG and return URLs, titles, and snippets.
 */

import { getSearxngUrl } from './utils.ts';
import { createTimeoutSignal } from './retry-utils.ts';
import type { SearXNGResult, QueryResultWithError, SearxngSearchOptions } from './types.ts';
import { logger } from '../logger.ts';
import { getConfig } from '../config.ts';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Type for SearXNG API response
 */
interface SearxngApiResponse {
  results?: SearXNGResult[];
  query: string;
  total: number;
}

/**
 * Error with cause property
 */
interface ErrorWithCause extends Error {
  cause?: unknown;
}

// Re-export search options type for consumers that import from this module
export type { SearxngSearchOptions } from './types.ts';

// ============================================================================
// SearXNG Search Functions
// ============================================================================

/**
 * Map our sourceType to the SearXNG categories parameter value.
 * SearXNG category names: general, news, it (tech/GitHub), images, videos, etc.
 * 'docs' has no SearXNG equivalent so we leave it as general.
 */
function sourceTypeToCategory(sourceType: SearxngSearchOptions['sourceType']): string {
  switch (sourceType) {
    case 'news':   return 'news';
    case 'github': return 'it';
    default:       return 'general';
  }
}

/**
 * Map our freshness value to the SearXNG time_range parameter value.
 * Returns undefined when no filter should be applied.
 */
function freshnessToTimeRange(freshness: SearxngSearchOptions['freshness']): string | undefined {
  switch (freshness) {
    case 'day':   return 'day';
    case 'week':  return 'week';
    case 'month': return 'month';
    case 'year':  return 'year';
    default:      return undefined;
  }
}

/**
 * Search SearXNG API for a single query
 *
 * @param query - The search query string
 * @param options - Optional freshness and sourceType filters
 * @returns Promise<SearXNGResult[]> - Array of search results
 * @throws {Error} When network error, timeout, or API error occurs
 */
async function searchSearxng(query: string, options?: SearxngSearchOptions, signal?: AbortSignal): Promise<SearXNGResult[]> {
  const baseUrl = getSearxngUrl();

  // Build URL with query parameters
  const url = new URL(`${baseUrl}/search`);
  url.searchParams.append('q', query);
  url.searchParams.append('format', 'json');
  // Restrict to the configured language. Without this, SearXNG uses its instance
  // defaults which can return mixed-language results.
  url.searchParams.append('language', getConfig().SEARCH_LANGUAGE);
  url.searchParams.append('categories', sourceTypeToCategory(options?.sourceType));
  // Apply time filter when requested (omit param entirely for 'any' / undefined)
  const timeRange = freshnessToTimeRange(options?.freshness);
  if (timeRange !== undefined) {
    url.searchParams.append('time_range', timeRange);
  }

  // Make GET request
  let response: Response;
  const fetch = globalThis.fetch;

  try {
    // createTimeoutSignal combines the 45s timeout with any caller-provided signal,
    // so Ctrl+C during a search aborts the fetch immediately rather than waiting for timeout.
    response = await fetch(url.toString(), {
      signal: createTimeoutSignal(45000, signal),
    });
  } catch (error) {
    // Handle network errors, DNS failures, connection refused, etc.
    if (error instanceof Error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'DOMException') {
        const timeoutError = new Error(
          `SearXNG request timed out: ${error.message}`,
        ) as ErrorWithCause;
        timeoutError.cause = error;
        throw timeoutError;
      }
      const networkError = new Error(
        `SearXNG network error: ${error.message}`,
      ) as ErrorWithCause;
      networkError.cause = error;
      throw networkError;
    }
    const unknownError = new Error(
      `SearXNG network error: ${String(error)}`,
    ) as ErrorWithCause;
    unknownError.cause = error;
    throw unknownError;
  }

  if (!response.ok) {
    const apiError = new Error(
      `SearXNG request failed: ${response.status} ${response.statusText}`,
    ) as ErrorWithCause;
    apiError.cause = { status: response.status, statusText: response.statusText };
    throw apiError;
  }

  const data = await response.json() as SearxngApiResponse;

  // Return results or empty array using nullish coalescing
  return data.results ?? [];
}

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Classify error type for better error reporting
 *
 * @param error - The unknown error to classify
 * @returns QueryResultWithError['error'] - Classified error object
 */
function classifyError(error: unknown): QueryResultWithError['error'] {
  const errorStr = String(error);

  // Timeout errors — check BEFORE network errors because "SearXNG network error: ...timeout" messages
  // contain "network" and would otherwise be misclassified as network_error.
  if (errorStr.includes('timed out') || errorStr.includes('timeout') ||
      errorStr.includes('AbortError') || errorStr.includes('TimeoutError')) {
    return { type: 'timeout', message: 'Search request timed out' };
  }

  // Network-related errors: connection refused, DNS failures, network unreachable, etc.
  if (errorStr.includes('fetch failed') ||
      errorStr.includes('ECONNREFUSED') ||
      errorStr.includes('ENOTFOUND') ||
      errorStr.includes('ECONNRESET') ||
      errorStr.includes('ETIMEDOUT') ||
      errorStr.includes('EHOSTUNREACH') ||
      errorStr.includes('ENETUNREACH') ||
      errorStr.includes('network') ||
      errorStr.includes('Network error')) {
    return { type: 'network_error', message: 'Network error - unable to connect to SearXNG service' };
  }

  if (errorStr.includes('SearXNG request failed')) {
    // Check status code for more specific info
    const match = errorStr.match(/(\d{3})/);
    if (match !== null) {
      const status = parseInt(match[1] ?? '0', 10);
      if (status >= 500) {
        return { type: 'service_unavailable', message: `SearXNG server error (${status})` };
      }
      if (status >= 400) {
        return { type: 'service_unavailable', message: `SearXNG client error (${status})` };
      }
    }
  }

  return { type: 'unknown', message: errorStr.length > 0 ? errorStr : 'Unknown error' };
}

// ============================================================================
// Multiple Query Search
// ============================================================================

/**
 * Search multiple queries via SearXNG
 *
 * @param queries - Array of search query strings
 * @param options - Optional freshness and sourceType filters applied uniformly to all queries
 * @param signal - Optional AbortSignal; combined with the per-request timeout
 * @returns Promise<QueryResultWithError[]> - Array of search results with error information
 */
export function search(queries: string[], options?: SearxngSearchOptions, signal?: AbortSignal): Promise<QueryResultWithError[]> {
  const searchPromises = queries.map((query: string): Promise<QueryResultWithError> => {
    return searchSearxng(query, options, signal)
      .then((results: SearXNGResult[]): QueryResultWithError => {
        const result: QueryResultWithError = { query, results };
        // Explicitly mark as empty results if no results returned
        if (results.length === 0) {
          result.error = { type: 'empty_results', message: 'No results found for this query' };
        }
        return result;
      })
      .catch((error: unknown): QueryResultWithError => {
        logger.warn(`[Web Research] Search failed for "${query}":`, error);
        const result: QueryResultWithError = { query, results: [] };
        result.error = classifyError(error);
        return result;
      });
  });

  return Promise.all(searchPromises);
}
