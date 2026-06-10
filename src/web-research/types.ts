/**
 * Web Research Extension - Type Definitions
 *
 * All TypeScript interfaces and types for the web research functionality
 */

import type { SearchResult, ScrapeResult } from '../core/interfaces/scheduler-interfaces.ts';

export type { SearchResult, ScrapeResult };

// Search result with per-query error context.
export interface QueryResultWithError {
  query: string;
  results: SearchResult[];
  error?: {
    type: 'empty_results' | 'service_unavailable' | 'timeout' | 'network_error' | 'unknown';
    message: string;
  };
}

// Scraper types
export type Layer = 'fetch' | 'playwright+camoufox';

export interface ScrapeLayerResult {
  source: 'fetch' | 'playwright';
  layer: 'fetch' | 'playwright' | 'playwright+camoufox';
  markdown: string;
  error?: string;
}

/** Timeout for the lightweight fetch layer only (not the full playwright scraper path). */
export const FETCH_LAYER_TIMEOUT = 10000;
