/**
 * Health Check Module
 *
 * Validates system capabilities using the central health registry.
 * This module is stateless and does not cache results.
 */

import { execFileSync } from 'node:child_process';
import { getConfig } from '../config.ts';
import { isBrowserAvailable } from '../infrastructure/browser/config.ts';
import { runBrowserHealthCheck } from '../infrastructure/browser/task-execution-service.ts';
import { getService, tryGetServiceContainerFromCtx, getServiceContainer } from '../core/service-registry.ts';
import type { ServiceContainer } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IStateManager, IHealthRegistryService, IKnowledgeStoreService, ISchedulerService } from '../core/service-interfaces.ts';
import { healthRegistry as globalHealthRegistry } from './registry.ts';

/**
 * Standalone BrowserCapability check, exported so tests can call it directly
 * without going through the full registry.
 */
export async function checkBrowserCapability(): Promise<{ healthy: boolean; error?: string; diagnostic?: Record<string, any> }> {
  const mockMode = process.env['PI_RESEARCH_MOCK_SEARCH'] === 'true' &&
                   process.env['PI_RESEARCH_MOCK_SCRAPE'] === 'true';
  if (isBrowserAvailable() || mockMode) {
    // On Linux without a display server, camoufox uses Xvfb for the virtual framebuffer.
    // Fail early (before research starts) if Xvfb is missing in that scenario.
    if (!mockMode && process.platform === 'linux' && !process.env['DISPLAY']) {
      try {
        execFileSync('which', ['Xvfb'], { stdio: 'ignore' });
      } catch {
        return {
          healthy: false,
          error: 'No display server found on Linux (DISPLAY not set) and Xvfb is not installed. Run: sudo apt install xvfb',
        };
      }
    }
    return { healthy: true, diagnostic: { status: mockMode ? 'mocked' : 'available' } };
  } else {
    return { healthy: false, error: 'Camoufox (browser) not found. Run "npm run setup" to install browser binaries.' };
  }
}

/**
 * Register all health checks with a registry
 */
export function registerHealthChecks(registry: IHealthRegistryService, container: ServiceContainer = getServiceContainer()): void {
  const config = getConfig();
  const healthTimeoutMs = config.HEALTH_CHECK_TIMEOUT_MS;

  // Register Browser Capability Check
  registry.register('BrowserCapability', checkBrowserCapability, { timeoutMs: healthTimeoutMs, critical: true });

  // Register Browser Runtime Check
  registry.register('BrowserRuntime', async (options) => {
    try {
      const scheduler = await getService<ISchedulerService>(ServiceNames.SCHEDULER, { container }, container);
      
      // Check if initialized but idle (unless forced)
      if (!scheduler.isReady() && !options?.force) {
        return { healthy: true, diagnostic: { status: 'ready (idle)' } };
      }
      
      // Perform a real test
      const searchResult = await runBrowserHealthCheck(undefined, 1, undefined, container);
      if (searchResult.success) {
        return { healthy: true, diagnostic: { status: options?.force && !scheduler.isReady() ? 'initialized & active' : 'active' } };
      } else {
        return { healthy: false, error: 'Browser healthcheck failed: worker reported failure or page failed to load.' };
      }
    } catch (e) {
      return { healthy: false, error: `Browser healthcheck failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }, { timeoutMs: 150000, critical: true });

  // Register Knowledge Store Check
  registry.register('KnowledgeStore', async (options) => {
    const cwd = (container as any)._cwd || process.cwd();
    const config = getConfig(cwd);
    if (config.KNOWLEDGE_STORE_MODE === 'none') {
      return { healthy: true, diagnostic: { status: 'disabled in config' } };
    }
    try {
      const service = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, { container }, container);
      const store = await service.getStore();
      const counts = store ? await store.countScoped() : { local: 0, global: 0, projects: 0 };
      const embedder = await service.getEmbedder();
      
      if (!embedder) {
        return { healthy: false, error: 'Embedder service not available' };
      }

      // Lazy-aware health check: if not initialized, we check if the store is open
      // but don't force a model load to GPU just for the health check (unless forced).
      if (!embedder.isInitialized() && !options?.force) {
          return { 
              healthy: true, 
              diagnostic: { 
                  status: 'ready (idle)',
                  device: embedder.getOriginalDevice(),
                  localEntries: counts.local,
                  globalEntries: counts.global
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
              model: config.EMBEDDING_MODEL,
              localEntries: counts.local,
              globalEntries: counts.global,
              totalProjects: counts.projects
          } 
      };
    } catch (e) {
      return { healthy: false, error: `Knowledge store healthcheck failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }, { timeoutMs: Math.max(healthTimeoutMs, 45000) });

  // Register State Manager Check
  registry.register('StateManager', async () => {
    try {
      const stateManager = await getService<IStateManager>(ServiceNames.STATE_MANAGER, { container }, container);
      const stats = await stateManager.getMetrics();
      const gpuOwner = await stateManager.getGpuOwner();
      
      return { 
          healthy: true, 
          diagnostic: { 
              status: 'operational',
              sessions: stats.activeSessions,
              gpuLocked: !!gpuOwner,
              gpuOwner: gpuOwner?.sessionId || 'none'
          } 
      };
    } catch (e) {
      return { healthy: false, error: `State manager healthcheck failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }, { timeoutMs: healthTimeoutMs });
}

// Ensure global registry is populated
registerHealthChecks(globalHealthRegistry);

/**
 * Perform a full system health check
 */
export async function runHealthCheck(options?: { force?: boolean; ctx?: any }) {
  const container = tryGetServiceContainerFromCtx(options?.ctx);
  
  let registry: IHealthRegistryService;
  try {
    registry = await getService<IHealthRegistryService>(ServiceNames.HEALTH_REGISTRY, options?.ctx, container);
  } catch {
    // Fallback to global registry if service not found (CLI/Legacy)
    registry = globalHealthRegistry;
  }

  const result = await registry.runAll(options);
  return {
    success: result.status !== 'unhealthy',
    status: result.status,
    components: result.components,
    error: result.status === 'unhealthy' 
      ? result.components.find(c => !c.healthy && registry.isCritical(c.component))?.error
      : undefined
  };
}

/**
 * Export health registry for external use
 */
export { globalHealthRegistry as healthRegistry };
