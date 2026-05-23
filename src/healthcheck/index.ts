/**
 * Health Check Module
 *
 * Validates system capabilities using the central health registry.
 */

import { logger } from '../logger.ts';
import { getConfig } from '../config.ts';
import { isBrowserAvailable, runBrowserHealthCheck } from '../infrastructure/browser-manager.ts';
import { getSharedStateManager } from '../infrastructure/state-manager.ts';
import { getEmbedder } from '../knowledge/index.ts';
import { healthRegistry } from './registry.ts';

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
    const lockInfo = await stateManager.getGpuLockInfo();
    return { 
      healthy: true, 
      diagnostic: { 
        locked: lockInfo.locked, 
        stale: lockInfo.locked && (Date.now() - lockInfo.timestamp > 120_000) 
      } 
    };
  } catch (e) {
    return { healthy: false, error: `GPU Lock check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}, { timeoutMs: 5000, critical: false });

// Global state for the health check singleton
function getPendingCheck(): Promise<HealthCheckResult> | null {
  return (globalThis as any).__PI_RESEARCH_HEALTH_CHECK_PENDING__ || null;
}

function setPendingCheck(val: Promise<HealthCheckResult> | null) {
  (globalThis as any).__PI_RESEARCH_HEALTH_CHECK_PENDING__ = val;
}

let healthCheckFailureCount = 0;
let healthCheckBackoffUntil = 0;

export function clearHealthCheckCache() {
  setPendingCheck(null);
  healthCheckFailureCount = 0;
  healthCheckBackoffUntil = 0;
}

export async function runHealthCheck(): Promise<HealthCheckResult> {
  const pending = getPendingCheck();
  if (pending) return pending;

  const promise = performActualCheck();
  setPendingCheck(promise);
  
  try {
    const result = await promise;
    if (!result.success) {
      setPendingCheck(null);
      healthCheckFailureCount++;
      healthCheckBackoffUntil = Date.now() + Math.min(30000, 2000 * Math.pow(2, healthCheckFailureCount - 1));
      logger.warn(`[healthcheck] Check failed, backoff set for ${healthCheckBackoffUntil - Date.now()}ms (failure #${healthCheckFailureCount})`);
    } else {
      if (healthCheckFailureCount > 0) {
        logger.log(`[healthcheck] Check succeeded after ${healthCheckFailureCount} failures, resetting backoff`);
      }
      healthCheckFailureCount = 0;
      healthCheckBackoffUntil = 0;
    }
    return result;
  } catch (error) {
    setPendingCheck(null);
    throw error;
  }
}

async function performActualCheck(): Promise<HealthCheckResult> {
  const now = Date.now();
  if (now < healthCheckBackoffUntil) {
    const waitMs = healthCheckBackoffUntil - now;
    logger.warn(`[healthcheck] Backing off for ${waitMs}ms due to previous failure(s)`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }

  logger.log('[healthcheck] Starting System Health Checks...');
  
  const systemHealth = await healthRegistry.runAll();
  
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