/**
 * Web Research Extension - Type Definitions
 *
 * All TypeScript interfaces and types for the web research functionality
 */

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

// Search result type
export interface SearchResult {
  title: string;
  url: string;
  content: string;
  engine?: string;
  score?: number;
}

// Timeouts
/** Timeout for the lightweight fetch layer only (not the full playwright scraper path). */
export const FETCH_LAYER_TIMEOUT = 10000;

