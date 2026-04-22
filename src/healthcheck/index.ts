/**
 * Health Check Module
 *
 * Exclusively validates browser-based research capabilities.
 */

import { logger } from '../logger.ts';
import { isBrowserAvailable } from '../infrastructure/browser-manager.ts';
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
    const result: HealthCheckResult = {
      success: false,
      searchOk: false,
      scrapeOk: false,
      timestamp: new Date().toISOString(),
    };

    logger.log('[healthcheck] Starting Browser-based Research Health Check...');

    // PHASE 1: Verify Browser Availability
    if (isBrowserAvailable()) {
      logger.log('[healthcheck] ✓ Browser Manager verified.');
      result.searchOk = true;
    } else {
      result.error = 'Browser binaries (Camoufox) not found or not installed.';
      logger.error('[healthcheck] Search validation failed:', result.error);
      return result;
    }

    // PHASE 2: Test basic scrape capability (first-success across canaries)
    const canaries = [
      'https://en.wikipedia.org/wiki/Main_Page',
      'https://github.com/trending'
    ];

    logger.log('[healthcheck] Testing basic scrape capability...');
    for (const url of canaries) {
      try {
        const scrapeRes = await scrapeSingle(url);
        // ScrapeUrlResult has markdown, error, layer, etc. 
        // Success is implied if markdown length > 500 and no error property.
        if (!scrapeRes.error && scrapeRes.markdown.length > 500) {
          logger.log(`[healthcheck] ✓ Scrape verified via ${url}`);
          result.scrapeOk = true;
          break;
        }
      } catch (e) {
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
  })();

  return cachedHealthCheck;
}

export function clearHealthCheckCache(): void {
  cachedHealthCheck = null;
  logger.log('[healthcheck] Health check cache cleared');
}
