/**
 * Health Check Module
 *
 * Validates system capabilities using the central health registry.
 * This module is stateless and does not cache results.
 */

import { logger } from '../logger.ts';
import { getConfig } from '../config.ts';
import { isBrowserAvailable, runBrowserHealthCheck } from '../infrastructure/browser-manager.ts';
import { getSharedStateManager } from '../infrastructure/state-manager.ts';
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import { SchedulerService } from '../core/scheduler-service.ts';
import { getEmbedder } from '../knowledge/index.ts';
import { healthRegistry } from './registry.ts';

export { healthRegistry } from './registry.ts';

/**
 * Result of a high-level system health check
 */
export interface HealthCheckResult {
  success: boolean;
  searchOk: boolean;
  scrapeOk: boolean;
  error?: string;
  timestamp: string;
}

// ============================================================================
// Component Registration
// ============================================================================

// Register Browser Pool Check
healthRegistry.register('BrowserPool', async () => {
  if (!isBrowserAvailable()) {
    return { healthy: false, error: 'Browser binaries (Camoufox) not found or not installed.' };
  }
  
  try {
    // Lazy-aware health check: if pool not active, just report binary is OK
    const schedulerService = await getService<SchedulerService>(ServiceNames.SCHEDULER);
    const activeScheduler = schedulerService.getSchedulerInstance();
    
    if (!activeScheduler) {
        return { healthy: true, diagnostic: { status: 'ready (idle)' } };
    }

    // If already active, perform a real test
    const searchResult = await runBrowserHealthCheck();
    if (searchResult.success) {
      return { healthy: true, diagnostic: { status: 'active' } };
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
    
    // Lazy-aware health check: if not initialized, we check if the store is open
    // but don't force a model load to GPU just for the health check.
    if (!embedder.isInitialized()) {
        return { 
            healthy: true, 
            diagnostic: { 
                status: 'ready (idle)',
                device: embedder.getOriginalDevice()
            } 
        };
    }

    // If already initialized (e.g. active research), perform a real test
    const testVector = await embedder.embed("health check test");
    if (testVector && testVector.length > 0) {
        return { healthy: true, diagnostic: { dimension: testVector.length, status: 'active' } };
    }
    
    return { healthy: false, error: 'Embedder test embedding failed' };
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

// ============================================================================
// High-level Actions
// ============================================================================

/**
 * Execute all registered health checks and return a unified result.
 * This is stateless and does not cache results.
 */
export async function runHealthCheck(): Promise<HealthCheckResult> {
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
      const failedCritical = systemHealth.components.find(c => !c.healthy && healthRegistry.isCritical(c.component));
      logger.error('[healthcheck] System validation failed:', failedCritical?.error);
  } else {
      logger.log('[healthcheck] ALL SYSTEMS GO. Ready for research.');
  }

  return result;
}

/**
 * Returns true if the critical system components are healthy.
 */
export async function isHealthCheckSuccessful(): Promise<boolean> {
  try {
    const health = await runHealthCheck();
    return health.success;
  } catch {
    return false;
  }
}
