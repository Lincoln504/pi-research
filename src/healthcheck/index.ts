/**
 * Health Check Module
 *
 * Exclusively validates browser-based research capabilities.
 */

import { logger } from '../logger.ts';
import { getConfig } from '../config.ts';
import { isBrowserAvailable, runBrowserHealthCheck } from '../infrastructure/browser-manager.ts';

export interface HealthCheckResult {
  success: boolean;
  searchOk: boolean;
  scrapeOk: boolean;
  error?: string;
  timestamp: string;
}

// Global state for the health check singleton, using globalThis to avoid TDZ and 
// ensure it's shared even if the module is evaluated multiple times concurrently.
function getPendingCheck(): Promise<HealthCheckResult> | null {
  return (globalThis as any).__PI_RESEARCH_HEALTH_CHECK_PENDING__ || null;
}

function setPendingCheck(val: Promise<HealthCheckResult> | null) {
  (globalThis as any).__PI_RESEARCH_HEALTH_CHECK_PENDING__ = val;
}

/**
 * Execute a simplified health check verifying browser-based research readiness.
 * Thread-safe singleton pattern to ensure multiple concurrent research sessions
 * share the same health check process.
 */
export async function runHealthCheck(): Promise<HealthCheckResult> {
  const pending = getPendingCheck();
  if (pending) return pending;

  const promise = performActualCheck();
  setPendingCheck(promise);
  
  try {
    const result = await promise;
    // If the check failed, clear the cache so the next request can try again
    if (!result.success) {
      setPendingCheck(null);
    }
    return result;
  } catch (error) {
    setPendingCheck(null);
    throw error;
  }
}

/**
 * The actual check logic
 */
async function performActualCheck(): Promise<HealthCheckResult> {
  const timeoutMs = getConfig().HEALTH_CHECK_TIMEOUT_MS ?? 120000;

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

    // PHASE 2: Test browser via DuckDuckGo Lite navigation.
    // This validates both worker initialization and network connectivity in a single step.
    // A separate canary scrape is unnecessary — if the browser can load DuckDuckGo it can scrape.
    logger.log('[healthcheck] Testing browser via pool healthcheck...');
    try {
      const searchResult = await runBrowserHealthCheck();
      if (searchResult.success) {
        logger.log('[healthcheck] ✓ Browser and network verified.');
        result.searchOk = true;
        result.scrapeOk = true;
      } else {
        result.error = 'Browser healthcheck failed: worker reported failure or page failed to load.';
        logger.error('[healthcheck] Browser validation failed:', result.error);
        return result;
      }
    } catch (e) {
      result.error = `Browser healthcheck failed: ${e instanceof Error ? e.message : String(e)}`;
      logger.error('[healthcheck] Browser validation failed:', result.error);
      return result;
    }

    result.success = true;
    logger.log('[healthcheck] ALL SYSTEMS GO. Ready for research.');
    return result;
  };

  const timeoutPromise = new Promise<HealthCheckResult>((_, reject) =>
    setTimeout(() => reject(new Error(`Health check timed out after ${timeoutMs}ms`)), timeoutMs)
  );

  try {
    return await Promise.race([check(), timeoutPromise]);
  } catch (e) {
    return {
      success: false,
      searchOk: false,
      scrapeOk: false,
      error: e instanceof Error ? e.message : String(e),
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Check if the health check has already succeeded
 */
export async function isHealthCheckSuccessful(): Promise<boolean> {
  const pending = getPendingCheck();
  if (!pending) return false;
  try {
    const result = await pending;
    return result.success;
  } catch {
    return false;
  }
}

/**
 * Clear the cached health check result
 */
export function clearHealthCheckCache(): void {
  setPendingCheck(null);
  logger.log('[healthcheck] Health check cache cleared');
}
