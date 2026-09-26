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
  error?: QueryFailure;
}

/**
 * Why one query yielded nothing.
 *
 * The distinction matters to the *researcher agent*, which reads these messages
 * and decides what to do next: `empty_results` is genuine feedback about the
 * query (rewrite it, broaden it), while a timeout or a dead worker says nothing
 * at all about the query and should prompt a retry instead. Collapsing the two —
 * reporting every zero-result query as "the query may be too narrow" — sent the
 * agent off rewriting perfectly good queries whenever the browser pool was the
 * thing that failed. `all_duplicates` is the third case: the query SUCCEEDED,
 * but every result deduplicated away against URLs earlier queries in the batch
 * already returned — coverage feedback, not query-quality feedback.
 */
export interface QueryFailure {
  type: 'empty_results' | 'all_duplicates' | 'service_unavailable' | 'timeout' | 'network_error' | 'unknown';
  message: string;
}

// Scraper types
export type Layer = 'fetch' | 'playwright+camoufox';

export interface ScrapeLayerResult {
  source: 'fetch' | 'playwright';
  layer: 'fetch' | 'playwright' | 'playwright+camoufox';
  markdown: string;
  error?: string;
  finalUrl?: string;
  redirects?: string[];
  contentType?: string;
  raw?: boolean;
  html?: string;
}

/**
 * Opt-in behaviours for {@link scrapeSingle}. Every field defaults to the
 * historical behaviour, so research scrapes (which pass nothing) are unchanged.
 */
export interface ScrapeOptions {
  /**
   * Refuse non-https documents: the requested URL, any fetch-layer redirect hop,
   * and the browser layer's final main-frame URL. A refusal does not fall back to
   * the browser (it would follow the same redirect).
   */
  httpsOnly?: boolean;
  /** Also return the pre-conversion HTML (HTML documents only). */
  keepHtml?: boolean;
  /**
   * Return text-like bodies (plain text, Markdown, JSON, CSV, XML, YAML) as the
   * decoded body instead of running them through the HTML→Markdown converter,
   * which collapses JSON indentation and parses Markdown's embedded HTML. JSON is
   * pretty-printed. Raw bodies skip the stub check (short data is legitimate).
   */
  rawText?: boolean;
  /** Set to false to disable the stealth-browser fallback. Default: true. */
  browserFallback?: boolean;
}

/** Timeout for the lightweight fetch layer only (not the full playwright scraper path). */
export const FETCH_LAYER_TIMEOUT = 10000;
