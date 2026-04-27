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
  markdown: string;
  source: string;
  layer: Layer;
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
export const PRIMARY_SCRAPER_TIMEOUT = 15000;  // fetch layer
export const FALLBACK_SCRAPER_TIMEOUT = 30000; // Camoufox layer (increased for stealth rendering)

