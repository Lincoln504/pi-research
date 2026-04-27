/**
 * Health Check Module
 *
 * Exclusively validates browser-based research capabilities.
 */

import { logger } from '../logger.ts';
import { getConfig } from '../config.ts';
import { isBrowserAvailable, runBrowserHealthCheck } from '../infrastructure/browser-manager.ts';
import { scrapeSingle } from '../web-research/scrapers.ts';

export interface HealthCheckResult {
  success: boolean;
  searchOk: boolean;
  scrapeOk: boolean;
  error?: string;
  timestamp: string;
}

let cachedHealthCheck: Promise<HealthCheckResult> | null = null;

/**
 * Execute a simplified health check verifying browser-based research readiness.
 */
export async function runHealthCheck(): Promise<HealthCheckResult> {
  if (cachedHealthCheck) return cachedHealthCheck;

  cachedHealthCheck = (async () => {
    const timeoutMs = getConfig().HEALTH_CHECK_TIMEOUT_MS ?? 25000;

    const check = async (): Promise<HealthCheckResult> => {
      const result: HealthCheckResult = {
        success: false,
        searchOk: false,
        scrapeOk: false,
        timestamp: new Date().toISOString(),
      };

      logger.log('[healthcheck] Starting Browser-based Research Health Check...');

      // PHASE 1: Verify Browser Availability
      if (!isBrowserAvailable()) {
        result.error = 'Browser binaries (Camoufox) not found or not installed.';
        logger.error('[healthcheck] Search validation failed:', result.error);
        return result;
      }

      // PHASE 2: Test Search Capability via dedicated worker healthcheck path
      logger.log('[healthcheck] Testing search capability via pool...');
      try {
        const searchResult = await runBrowserHealthCheck();
        if (searchResult.success) {
          logger.log('[healthcheck] ✓ Search verified.');
          result.searchOk = true;
        } else {
          result.error = 'Search validation failed: Worker reported failure or page failed to load.';
          logger.error('[healthcheck] Search validation failed:', result.error);
          return result;
        }
      } catch (e) {
        result.error = `Search validation failed with error: ${e instanceof Error ? e.message : String(e)}`;
        logger.error('[healthcheck] Search validation failed:', result.error);
        return result;
      }

      // PHASE 3: Test basic scrape capability (first-success across canaries)
      const canaries = [
        'https://en.wikipedia.org/wiki/Main_Page',
        'https://github.com/trending',
      ];

      logger.log('[healthcheck] Testing basic scrape capability...');
      for (const url of canaries) {
        try {
          const scrapeRes = await scrapeSingle(url);
          if (scrapeRes.success && scrapeRes.markdown.length > 500) {
            logger.log(`[healthcheck] ✓ Scrape verified via ${url}`);
            result.scrapeOk = true;
            break;
          }
        } catch (_e) {
          logger.debug(`[healthcheck] Canary ${url} failed, trying next...`);
        }
      }

      if (!result.scrapeOk) {
        result.error = 'Scrape verification failed for all canaries. Network may be unreachable.';
        logger.error('[healthcheck] Scrape validation failed:', result.error);
        return result;
      }

      result.success = true;
      logger.log('[healthcheck] 🎉 ALL SYSTEMS GO. Ready for research.');
      return result;
    };

    const timeout = new Promise<HealthCheckResult>((_, reject) =>
      setTimeout(() => reject(new Error(`Health check timed out after ${timeoutMs}ms`)), timeoutMs)
    );

    let result: HealthCheckResult;
    try {
      result = await Promise.race([check(), timeout]);
    } catch (e) {
      result = {
        success: false,
        searchOk: false,
        scrapeOk: false,
        error: e instanceof Error ? e.message : String(e),
        timestamp: new Date().toISOString(),
      };
    }

    // Clear cache on failure so the next call can retry
    if (!result.success) {
      cachedHealthCheck = null;
    }

    return result;
  })();

  return cachedHealthCheck;
}

export function clearHealthCheckCache(): void {
  cachedHealthCheck = null;
  logger.log('[healthcheck] Health check cache cleared');
}
