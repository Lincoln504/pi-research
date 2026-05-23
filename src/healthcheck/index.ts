/**
 * Health Check Module
 *
 * Validates system capabilities using the central health registry.
 */

import { logger } from '../logger.ts';
import { errorTracker } from '../utils/error-tracker.ts';
import { getConfig } from '../config.ts';
import { isBrowserAvailable, runBrowserHealthCheck } from '../infrastructure/browser-manager.ts';
import { getSharedStateManager } from '../infrastructure/state-manager.ts';
import { getEmbedder } from '../knowledge/index.ts';
import { healthRegistry } from './registry.ts';
export { healthRegistry } from './registry.ts';
import { recordHealthCheck, getHealthSummary } from './persistence.ts';
import {
  getHealthCheckPending,
  setHealthCheckPending,
  getHealthCheckFailureCount,
  incrementHealthCheckFailureCount,
  resetHealthCheckFailureCount,
  isHealthCheckBackoffActive,
  getHealthCheckBackoffRemainingMs,
} from '../core/health-cache-manager.ts';

export interface HealthCheckResult {
  success: boolean;
  searchOk: boolean;
  scrapeOk: boolean;
  error?: string;
  timestamp: string;
}

// Register Browser Pool Check
healthRegistry.register('BrowserPool', async () => {
  if (!isBrowserAvailable()) {
    return { healthy: false, error: 'Browser binaries (Camoufox) not found or not installed.' };
  }
  
  try {
    const searchResult = await runBrowserHealthCheck();
    if (searchResult.success) {
      return { healthy: true };
    } else {
      return { healthy: false, error: 'Browser healthcheck failed: worker reported failure or page failed to load.' };
    }
  } catch (e) {
    return { healthy: false, error: `Browser healthcheck failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}, { timeoutMs: 30000, critical: true });

// Register Knowledge Store Check
healthRegistry.register('KnowledgeStore', async () => {
  if (!getConfig().KNOWLEDGE_STORE_ENABLED) {
    return { healthy: true, diagnostic: { status: 'disabled in config' } };
  }
  try {
    const embedder = await getEmbedder();
    if (embedder.isInitialized()) {
        const testVector = await embedder.embed("health check test");
        if (testVector && testVector.length > 0) {
            return { healthy: true, diagnostic: { dimension: testVector.length } };
        }
    }
    return { healthy: false, error: 'Embedder not initialized or test embedding failed' };
  } catch (e) {
    return { healthy: false, error: `Knowledge Store check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}, { timeoutMs: 15000, critical: false }); // Not critical for pure web research

// Register GPU Lock Check
healthRegistry.register('GPULock', async () => {
  try {
    const stateManager = getSharedStateManager();
    const gpuOwner = await stateManager.getGpuOwner();
    const locked = gpuOwner !== null;
    const stale = locked && gpuOwner !== undefined && (Date.now() - gpuOwner.startedAt > 120_000);
    return {
      healthy: true,
      diagnostic: {
        locked,
        stale,
        ownerPid: gpuOwner?.pid,
        ownerSessionId: gpuOwner?.sessionId,
      }
    };
  } catch (e) {
    return { healthy: false, error: `GPU Lock check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}, { timeoutMs: 5000, critical: false });

// Register ErrorTracker Check
healthRegistry.register('ErrorTracker', async () => {
  try {
    const report = errorTracker.getReport();
    // Consider unhealthy if there are more than 100 errors
    const isErrorCountHigh = report.totalErrors > 100;
    return {
      healthy: !isErrorCountHigh,
      error: isErrorCountHigh ? `High error count: ${report.totalErrors} errors across ${report.uniquePatterns} patterns` : undefined,
      diagnostic: {
        totalErrors: report.totalErrors,
        uniquePatterns: report.uniquePatterns,
        topPattern: report.patterns[0]?.signature || 'none',
        topPatternCount: report.patterns[0]?.count || 0,
      }
    };
  } catch (e) {
    return { healthy: false, error: `ErrorTracker check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}, { timeoutMs: 1000, critical: false }); // Not critical - errors are informational





export async function runHealthCheck(): Promise<HealthCheckResult> {
  const pending = getHealthCheckPending();
  if (pending) return pending;

  const promise = performActualCheck();
  setHealthCheckPending(promise);
  
  try {
    const result = await promise;
    if (!result.success) {
      setHealthCheckPending(null);
      incrementHealthCheckFailureCount();
    } else {
      const failureCount = getHealthCheckFailureCount();
      if (failureCount > 0) {
        logger.log(`[healthcheck] Check succeeded after ${failureCount} failures, resetting backoff`);
      }
      resetHealthCheckFailureCount();
    }
    return result;
  } catch (error) {
    setHealthCheckPending(null);
    throw error;
  }
}

async function performActualCheck(): Promise<HealthCheckResult> {
  // Wait for backoff if active
  if (isHealthCheckBackoffActive()) {
    const waitMs = getHealthCheckBackoffRemainingMs();
    logger.warn(`[healthcheck] Backing off for ${waitMs}ms due to previous failure(s)`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }

  logger.log('[healthcheck] Starting System Health Checks...');

  const systemHealth = await healthRegistry.runAll();

  // Record health check for monitoring
  recordHealthCheck(systemHealth);
  
  const result: HealthCheckResult = {
    success: systemHealth.status === 'healthy' || systemHealth.status === 'degraded',
    searchOk: false,
    scrapeOk: false,
    timestamp: systemHealth.timestamp,
  };

  const browserCheck = systemHealth.components.find(c => c.component === 'BrowserPool');
  if (browserCheck?.healthy) {
    result.searchOk = true;
    result.scrapeOk = true;
  } else {
    result.error = browserCheck?.error;
    result.success = false; // Browser is critical
  }

  if (systemHealth.status === 'unhealthy') {
      const failedCritical = systemHealth.components.find(c => !c.healthy && c.component === 'BrowserPool'); // Currently only BrowserPool is critical
      logger.error('[healthcheck] System validation failed:', failedCritical?.error);

      // Log health summary for diagnostics
      const summary = getHealthSummary();
      logger.info(`[healthcheck] Health summary: ${summary.healthy}/${summary.total} healthy, ${summary.degraded} degraded, ${summary.unhealthy} unhealthy`);
  } else {
      logger.log('[healthcheck] ALL SYSTEMS GO. Ready for research.');
  }

  return result;
}

export async function isHealthCheckSuccessful(): Promise<boolean> {
  try {
    const health = await runHealthCheck();
    return health.success;
  } catch {
    return false;
  }
}

/**
 * Clear the health check cache
 * This resets all backoff state and pending checks
 */
export function clearHealthCheckCache(): void {
  // Import the health cache manager to avoid circular dependency
  // We use a dynamic import here to ensure the module is loaded when needed
  import('../core/health-cache-manager.ts').then(mod => {
    mod.clearHealthCheckCache();
    logger.debug('[healthcheck] Cache cleared');
  }).catch(err => {
    logger.error('[healthcheck] Failed to clear health check cache:', err);
  });
}