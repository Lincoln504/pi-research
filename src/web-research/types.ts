/**
 * Web Research Extension - Type Definitions
 *
 * All TypeScript interfaces and types for the web research functionality
 */

// Search filter options passed through to SearXNG
export type SearchFreshness = 'any' | 'day' | 'week' | 'month' | 'year';
export type SearchSourceType = 'general' | 'news' | 'github';

export interface SearxngSearchOptions {
  freshness?: SearchFreshness;
  sourceType?: SearchSourceType;
}

// Search result with per-query error context.
export interface QueryResultWithError {
  query: string;
  results: SearXNGResult[];
  error?: {
    type: 'empty_results' | 'service_unavailable' | 'timeout' | 'network_error' | 'unknown';
    message: string;
  };
}

// Scraper types
export type Layer = 'fetch' | 'playwright+chromium';

export interface ScrapeLayerResult {
  markdown: string;
  source: string;
  layer: Layer;
}

// SearXNG types
export interface SearXNGResult {
  title: string;
  url: string;
  content: string;
  engine?: string;
  score?: number;
}

// Timeouts
export const PRIMARY_SCRAPER_TIMEOUT = 15000;  // fetch layer
export const FALLBACK_SCRAPER_TIMEOUT = 20000; // Chromium layer

