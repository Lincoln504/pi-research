/**
 * Health Check Module
 *
 * QUICK connectivity validation for search and scrape tools.
 * Makes real requests to verify network is alive.
 * Fast timeouts, simple checks (just verify tools respond with content).
 */

import { logger } from '../logger.ts';
import { getConfig } from '../config.ts';
import { getManager } from '../infrastructure/searxng-lifecycle.ts';
import { search } from '../web-research/search.ts';
import { scrapeSingle } from '../web-research/scrapers.ts';
import { setSearxngManager } from '../web-research/utils.ts';
import { getActiveSearxngEngines } from '../utils/searxng-config.ts';
import type { SearXNGResult } from '../web-research/types.ts';

// Get timeout from config or use defaults
const config = getConfig();
const SEARCH_TIMEOUT_MS = config.HEALTH_CHECK_TIMEOUT_MS || 15000;  // 15s max for search
const SCRAPE_TIMEOUT_MS = config.HEALTH_CHECK_TIMEOUT_MS ? config.HEALTH_CHECK_TIMEOUT_MS + 5000 : 20000; // 5s longer than search

export interface HealthCheckResult {
  success: boolean;
  searchOk: boolean;
  scrapeOk: boolean;
  error?: string;
  details: {
    searchQuery?: string;
    searchResultCount?: number;
    searchDurationMs?: number;
    scrapedUrl?: string;
    scrapedContentLength?: number;
    scrapedDurationMs?: number;
  };
}

/**
 * Wrap operation with timeout enforcement
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}


/**
 * QUICK scrape validation: just check content exists and is readable
 */
function validateScrapeOutput(markdown: string): { valid: boolean; error?: string } {
  if (typeof markdown !== 'string') {
    return { valid: false, error: 'Content not a string' };
  }

  const trimmed = markdown.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Content is empty' };
  }

  // Just check it has some readable text (not garbage)
  if (!/[a-zA-Z0-9]{10,}/.test(markdown)) {
    return { valid: false, error: 'Content not readable' };
  }

  return { valid: true };
}

/**
 * Healthcheck uses the same web-research search/scrape helpers as the main tool.
 * Ensure they are wired to the current lifecycle manager instead of relying on
 * an external caller to have registered it beforehand.
 */
function ensureHealthcheckManager(): void {
  const manager = getManager();
  if (!manager) {
    throw new Error('SearXNG manager not initialized. Call initLifecycle() before runHealthCheck().');
  }

  setSearxngManager(manager);
}

/**
 * Run health check: test search and scrape functionality with deterministic URLs
 * Uses hardcoded queries and URLs to ensure reproducible results
 */
export async function runHealthCheck(): Promise<HealthCheckResult> {
  logger.log('[healthcheck] Starting network connectivity health check...');

  const result: HealthCheckResult = {
    success: false,
    searchOk: false,
    scrapeOk: false,
    error: undefined,
    details: {},
  };

  try {
    ensureHealthcheckManager();

    // PHASE 1: Test general web search engines (Bing, DuckDuckGo, Brave — NOT Wikipedia)
    logger.log('[healthcheck] Phase 1: Testing general web search engines (timeout: ' + SEARCH_TIMEOUT_MS + 'ms)...');
    const searchQuery = 'open source software';
    const searchStartTime = Date.now();

    let queryResults;
    try {
      queryResults = await withTimeout(
        search([searchQuery]),
        SEARCH_TIMEOUT_MS,
        'Search'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.error = `Search request failed: ${msg}. Network may be unreachable or SearXNG not responding.`;
      logger.error('[healthcheck] Search error:', result.error);
      return result;
    }

    const searchDurationMs = Date.now() - searchStartTime;

    if (queryResults.length === 0 || !queryResults[0]) {
      result.error = 'Search returned empty result object (SearXNG not initialized?)';
      logger.error('[healthcheck]', result.error);
      return result;
    }

    const qr = queryResults[0];
    if (qr.error) {
      const errMsg = qr.error.message || String(qr.error);
      result.error = `Search request failed: ${errMsg}. SearXNG or engines are not responding.`;
      logger.error('[healthcheck]', result.error);
      return result;
    }

    // Check for at least one result from a GENERAL WEB search engine (not Wikipedia)
    // Wikipedia is an encyclopedic engine, not suitable for general web research
    // Load the list of active engines from the actual SearXNG config (not hardcoded)
    const generalEngines = getActiveSearxngEngines();
    if (generalEngines.length === 0) {
      result.error = 'No active general search engines found in SearXNG configuration';
      logger.error('[healthcheck]', result.error);
      return result;
    }
    logger.log(`[healthcheck] Checking for results from engines: [${generalEngines.join(', ')}]`);

    const generalResults = qr.results.filter((r: SearXNGResult) =>
      generalEngines.includes((r.engine || '').toLowerCase())
    );

    if (generalResults.length === 0) {
      // No results from general web engines — report which engines responded vs which didn't
      const engineCounts = new Map<string, number>();
      generalEngines.forEach(e => engineCounts.set(e, 0));
      qr.results.forEach((r: SearXNGResult) => {
        const engine = (r.engine || '').toLowerCase();
        if (engineCounts.has(engine)) {
          engineCounts.set(engine, (engineCounts.get(engine) || 0) + 1);
        }
      });
      const engineReport = Array.from(engineCounts.entries())
        .map(([e, c]) => `${e}: ${c}`)
        .join(', ');
      const allEngines = qr.results.map((r: SearXNGResult) => r.engine || 'unknown').join(', ');
      result.error = `All general web search engines failed (${engineReport}). Only these engines responded: ${allEngines}. Real web research will fail.`;
      logger.error('[healthcheck] Search validation failed:', result.error);
      return result;
    }

    result.searchOk = true;
    result.details.searchQuery = searchQuery;
    result.details.searchResultCount = generalResults.length;
    result.details.searchDurationMs = searchDurationMs;
    logger.log(`[healthcheck] ✓ Search OK: ${generalResults.length} results from general web engines in ${searchDurationMs}ms`);

    // PHASE 2: Test scrape with timeout enforcement
    logger.log('[healthcheck] Phase 2: Testing scrape tool (timeout: ' + SCRAPE_TIMEOUT_MS + 'ms)...');
    const scrapeUrl = 'https://en.wikipedia.org/wiki/Python_(programming_language)';
    const scrapeStartTime = Date.now();

    let scrapeResult;
    try {
      scrapeResult = await withTimeout(
        scrapeSingle(scrapeUrl),
        SCRAPE_TIMEOUT_MS,
        'Scrape'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.error = `Scrape request failed: ${msg}. Network timeout or target unreachable.`;
      logger.error('[healthcheck]', result.error);
      return result;
    }

    const scrapeDurationMs = Date.now() - scrapeStartTime;

    if (!scrapeResult) {
      result.error = 'Scrape returned null result (scraper crashed?)';
      logger.error('[healthcheck]', result.error);
      return result;
    }

    if (scrapeResult.source === 'failed') {
      result.error = `Scrape failed: ${scrapeResult.error || 'unknown error'}. Check if target URL is accessible.`;
      logger.error('[healthcheck]', result.error);
      return result;
    }

    // ROBUST validation of scraped content
    const markdown = scrapeResult.markdown || '';
    const scrapeValidation = validateScrapeOutput(markdown);
    if (!scrapeValidation.valid) {
      result.error = `Scrape validation failed: ${scrapeValidation.error}`;
      logger.error('[healthcheck]', result.error);
      return result;
    }

    result.scrapeOk = true;
    result.details.scrapedUrl = scrapeUrl;
    result.details.scrapedContentLength = markdown.length;
    result.details.scrapedDurationMs = scrapeDurationMs;
    logger.log(`[healthcheck] ✓ Scrape OK: ${markdown.length} bytes in ${scrapeDurationMs}ms`);

    // All checks passed
    result.success = true;
    const totalMs = searchDurationMs + scrapeDurationMs;
    logger.log(`[healthcheck] ✓ HEALTH CHECK PASSED in ${totalMs}ms - all systems ready`);
    return result;
  } catch (err) {
    result.error = `Unexpected error during health check: ${err instanceof Error ? err.message : String(err)}`;
    logger.error('[healthcheck] Unexpected error:', err);
    return result;
  }
}
