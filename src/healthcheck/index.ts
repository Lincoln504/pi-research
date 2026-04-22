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
import { withTimeout } from '../web-research/retry-utils.ts';
import type { SearXNGResult } from '../web-research/types.ts';

// Health check cache to avoid running multiple health checks concurrently
interface CachedHealthCheck {
  result: HealthCheckResult;
  timestamp: number;
}

let cachedHealthCheck: CachedHealthCheck | null = null;
const HEALTH_CHECK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let healthCheckPromise: Promise<HealthCheckResult> | null = null;

// Get timeout from config or use defaults
const config = getConfig();
const SEARCH_TIMEOUT_MS = config.HEALTH_CHECK_TIMEOUT_MS!;
const SCRAPE_TIMEOUT_MS = config.HEALTH_CHECK_TIMEOUT_MS! + 5000;

export interface HealthCheckResult {
  success: boolean;
  searchOk: boolean;
  scrapeOk: boolean;
  error?: string;
  details: {
    searchQuery?: string;
    searchResultCount?: number;
    searchDurationMs?: number;
    workingEngines?: string[];
    workingEngineCount?: number;
    scrapedUrl?: string;
    scrapedContentLength?: number;
    scrapedDurationMs?: number;
  };
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
 * Internal health check implementation
 * Runs the actual health check tests
 */
async function performHealthCheck(): Promise<HealthCheckResult> {
  logger.log('[healthcheck] Starting network connectivity health check...');

  const result: HealthCheckResult = {
    success: false,
    searchOk: false,
    scrapeOk: false,
    error: undefined,
    details: {},
  };

  try {
    // Skip health check if explicitly requested via env
    if (process.env['PI_RESEARCH_SKIP_HEALTHCHECK'] === '1') {
      logger.log('[healthcheck] Skipping health check (PI_RESEARCH_SKIP_HEALTHCHECK=1)');
      result.success = true;
      result.searchOk = true;
      result.scrapeOk = true;
      return result;
    }

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

    // Load the list of active engines from the actual SearXNG config
    const generalEngines = getActiveSearxngEngines();
    let workingEngineCount = 0;
    let generalResults: SearXNGResult[] = [];
    const engineCounts = new Map<string, number>();

    if (generalEngines.length > 0) {
      logger.log(`[healthcheck] Checking for results from engines: [${generalEngines.join(', ')}]`);

      generalResults = qr.results.filter((r: SearXNGResult) =>
        generalEngines.includes((r.engine || '').toLowerCase())
      );

      // RELEVANCE GUARD: Verify top results are actually relevant to "open source software"
      // This catches "junk results" returned by engines (like Bing) when they detect bots.
      const { filterRelevantResults } = await import('../web-research/utils.ts');
      const relevantResults = filterRelevantResults(searchQuery, generalResults);

      if (generalResults.length > 0 && relevantResults.length === 0) {
        logger.warn('[healthcheck] Junk results detected from SearXNG. These will be ignored.');
        // Don't return error yet, let fallback search try
        generalResults = [];
      } else {
        // Use the relevant ones
        generalResults = relevantResults;
      }

      // Count how many engines returned at least one result
      generalEngines.forEach(e => engineCounts.set(e, 0));
      generalResults.forEach((r: SearXNGResult) => {
        const engine = (r.engine || '').toLowerCase();
        if (engineCounts.has(engine)) {
          engineCounts.set(engine, (engineCounts.get(engine) || 0) + 1);
        }
      });

      const workingEngines = Array.from(engineCounts.entries()).filter(([_, count]) => count > 0);
      workingEngineCount = workingEngines.length;

      if (workingEngineCount > 0) {
        result.searchOk = true;
        result.details.searchQuery = searchQuery;
        result.details.searchResultCount = generalResults.length;
        result.details.searchDurationMs = searchDurationMs;
        result.details.workingEngines = workingEngines.map(([e, _]) => e);
        result.details.workingEngineCount = workingEngineCount;
        const workingEnginesList = workingEngines.map(([e, _]) => e).join(', ');
        logger.log(`[healthcheck] ✓ Search OK: ${generalResults.length} results from ${workingEngineCount} engines [${workingEnginesList}] in ${searchDurationMs}ms`);
      }
    } else {
      logger.warn('[healthcheck] No active general search engines found in SearXNG configuration. Skipping primary search phase.');
    }

    // FALLBACK SEARCH: Try if primary search didn't yield results
    if (!result.searchOk) {
      const searxngSummary = generalEngines.length === 0 
        ? 'No SearXNG engines enabled'
        : `SearXNG found no working engines (${workingEngineCount}/${generalEngines.length})`;
      
      logger.warn(`[healthcheck] ${searxngSummary}. Enabling fallback search mode (Playwright/DDG Lite)...`);
      
      try {
        const { setFallbackSearchEnabled } = await import('../web-research/utils.ts');
        
        // Check if camoufox is available without doing a real search
        let camoufoxInstalled = false;
        try {
          // Dynamic check for dependency
          const { createRequire } = await import('module');
          const requireMod = createRequire(import.meta.url);
          requireMod.resolve('camoufox-js');
          camoufoxInstalled = true;
        } catch {
          camoufoxInstalled = false;
        }

        if (camoufoxInstalled) {
          logger.log('[healthcheck] ✓ Fallback dependencies verified. Enabling fallback mode for research.');
          setFallbackSearchEnabled(true);
          result.searchOk = true;
          // Continue to scrape test
        } else {
          result.error = `${searxngSummary}. Fallback search is not available because camoufox-js is not installed.`;
          logger.error('[healthcheck] Search validation failed:', result.error);
          return result;
        }
      } catch (fallbackErr) {
        result.error = `${searxngSummary}. Error enabling fallback mode: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`;
        logger.error('[healthcheck] Search validation failed:', result.error);
        return result;
      }
    }

    // PHASE 2: Test scrape with timeout enforcement (first-success across canary URLs)
    const scrapeCanaries = [
      'https://en.wikipedia.org/wiki/Python_(programming_language)',
      'https://example.com',
      'https://developer.mozilla.org/en-US/docs/Web/HTTP',
    ];
    logger.log('[healthcheck] Phase 2: Testing scrape tool (timeout: ' + SCRAPE_TIMEOUT_MS + 'ms)...');
    const scrapeStartTime = Date.now();

    let scrapeResult;
    let scrapeUrl = '';
    let lastScrapeError = '';
    for (const canary of scrapeCanaries) {
      try {
        const candidate = await withTimeout(
          scrapeSingle(canary),
          SCRAPE_TIMEOUT_MS,
          'Scrape'
        );
        if (!candidate || candidate.source === 'failed') {
          lastScrapeError = candidate?.error || 'scraper returned failed';
          logger.log(`[healthcheck] Scrape canary ${canary} failed (${lastScrapeError}), trying next...`);
          continue;
        }
        const validation = validateScrapeOutput(candidate.markdown || '');
        if (!validation.valid) {
          lastScrapeError = validation.error || 'content invalid';
          logger.log(`[healthcheck] Scrape canary ${canary} content invalid (${lastScrapeError}), trying next...`);
          continue;
        }
        scrapeResult = candidate;
        scrapeUrl = canary;
        break;
      } catch (err) {
        lastScrapeError = err instanceof Error ? err.message : String(err);
        logger.log(`[healthcheck] Scrape canary ${canary} threw (${lastScrapeError}), trying next...`);
      }
    }

    const scrapeDurationMs = Date.now() - scrapeStartTime;

    if (!scrapeResult) {
      result.error = `Scrape failed on all canary URLs: ${lastScrapeError}`;
      logger.error('[healthcheck]', result.error);
      return result;
    }

    const markdown = scrapeResult.markdown || '';
    result.scrapeOk = true;
    result.details.scrapedUrl = scrapeUrl;
    result.details.scrapedContentLength = markdown.length;
    result.details.scrapedDurationMs = scrapeDurationMs;
    logger.log(`[healthcheck] ✓ Scrape OK: ${markdown.length} bytes from ${scrapeUrl} in ${scrapeDurationMs}ms`);

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

/**
 * Run health check with caching to avoid concurrent executions
 * If a health check is already in progress, returns the same promise
 * If a recent successful health check is cached, returns the cached result
 */
export async function runHealthCheck(): Promise<HealthCheckResult> {
  const now = Date.now();

  // Check cache FIRST before checking for in-progress promise
  // This ensures we use cached results even if a promise exists
  if (cachedHealthCheck) {
    const age = now - cachedHealthCheck.timestamp;
    if (age < HEALTH_CHECK_CACHE_TTL_MS) {
      logger.log(`[healthcheck] Using cached health check result (${Math.round(age / 1000)}s old)`);
      return cachedHealthCheck.result;
    } else {
      logger.log(`[healthcheck] Cached health check result expired (${Math.round(age / 1000)}s old)`);
      cachedHealthCheck = null; // Clear expired cache
    }
  }

  // NOW check if a health check is already running
  // This check must happen AFTER the cache check to avoid race conditions
  if (healthCheckPromise) {
    logger.log('[healthcheck] Health check already in progress, reusing existing promise');
    return healthCheckPromise;
  }

  // Only now set the promise and start a new health check
  healthCheckPromise = (async () => {
    try {
      const result = await performHealthCheck();
      // Cache only successful results
      if (result.success) {
        cachedHealthCheck = {
          result,
          timestamp: now,
        };
      }
      return result;
    } finally {
      // Clear the promise so a new health check can be started
      healthCheckPromise = null;
    }
  })();

  return healthCheckPromise;
}

/**
 * Clear the health check cache
 * Useful for testing or forcing a recheck
 */
export function clearHealthCheckCache(): void {
  cachedHealthCheck = null;
  logger.log('[healthcheck] Health check cache cleared');
}
