/**
 * Health Check Module
 *
 * Validates system capabilities using the central health registry.
 * This module is stateless and does not cache results.
 */

import { getConfig } from '../config.ts';
import { isBrowserAvailable } from '../infrastructure/browser/config.ts';
import { runBrowserHealthCheck } from '../infrastructure/browser/task-execution-service.ts';
import { getService } from '../core/service-registry.ts';
import { ServiceNames, IStateManager } from '../core/service-interfaces.ts';
import { SchedulerService } from '../core/scheduler-service.ts';
import type { IKnowledgeStoreService } from '../core/service-interfaces.ts';
import { healthRegistry } from './registry.ts';

// Register Browser Capability Check
healthRegistry.register('BrowserCapability', async () => {
  const mockMode = process.env['PI_RESEARCH_MOCK_SEARCH'] === 'true' &&
                   process.env['PI_RESEARCH_MOCK_SCRAPE'] === 'true';
  if (isBrowserAvailable() || mockMode) {
    return { healthy: true, diagnostic: { status: mockMode ? 'mocked' : 'available' } };
  } else {
    return { healthy: false, error: 'Camoufox (browser) not found. Run "npm run setup" to install browser binaries.' };
  }
}, { critical: true });

// Register Browser Runtime Check
healthRegistry.register('BrowserRuntime', async (options) => {
  try {
    const scheduler = await getService<SchedulerService>(ServiceNames.SCHEDULER);
    
    // Check if initialized but idle (unless forced)
    if (!scheduler.isInitialized() && !options?.force) {
      return { healthy: true, diagnostic: { status: 'ready (idle)' } };
    }
    
    // Perform a real test
    const searchResult = await runBrowserHealthCheck();
    if (searchResult.success) {
      return { healthy: true, diagnostic: { status: options?.force && !scheduler.isInitialized() ? 'initialized & active' : 'active' } };
    } else {
      return { healthy: false, error: 'Browser healthcheck failed: worker reported failure or page failed to load.' };
    }
  } catch (e) {
    return { healthy: false, error: `Browser healthcheck failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}, { timeoutMs: 105000, critical: true });

// Register Knowledge Store Check
healthRegistry.register('KnowledgeStore', async (options) => {
  if (!getConfig().KNOWLEDGE_STORE_ENABLED) {
    return { healthy: true, diagnostic: { status: 'disabled in config' } };
  }
  try {
    const service = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
    const embedder = await service.getEmbedder();
    
    // Lazy-aware health check: if not initialized, we check if the store is open
    // but don't force a model load to GPU just for the health check (unless forced).
    if (!embedder.isInitialized() && !options?.force) {
        return { 
            healthy: true, 
            diagnostic: { 
                status: 'ready (idle)',
                device: embedder.getOriginalDevice()
            } 
        };
    }

    // Force initialization if requested
    if (options?.force && !embedder.isInitialized()) {
        await embedder.embed(' ');
    }

    const device = embedder.getDevice();
    return { 
        healthy: true, 
        diagnostic: { 
            status: 'initialized',
            device,
            model: getConfig().EMBEDDING_MODEL 
        } 
    };
  } catch (e) {
    return { healthy: false, error: `Knowledge store healthcheck failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}, { timeoutMs: 45000 });

// Register State Manager Check
healthRegistry.register('StateManager', async () => {
  try {
    const stateManager = await getService<IStateManager>(ServiceNames.STATE_MANAGER);
    const metrics = await stateManager.getMetrics();
    const gpuOwner = await stateManager.getGpuOwner();
    
    return { 
        healthy: true, 
        diagnostic: { 
            status: 'operational',
            sessions: metrics.activeSessions,
            gpuLocked: !!gpuOwner,
            gpuOwner: gpuOwner?.sessionId || 'none'
        } 
    };
  } catch (e) {
    return { healthy: false, error: `State manager healthcheck failed: ${e instanceof Error ? e.message : String(e)}` };
  }
});

/**
 * Perform a full system health check
 */
export async function runHealthCheck(options?: { force?: boolean }) {
  const result = await healthRegistry.runAll(options);
  return {
    success: result.status !== 'unhealthy',
    status: result.status,
    components: result.components,
    error: result.status === 'unhealthy' 
      ? result.components.find(c => !c.healthy && healthRegistry.isCritical(c.component))?.error
      : undefined
  };
}

/**
 * Export health registry for external use
 */
export { healthRegistry };
