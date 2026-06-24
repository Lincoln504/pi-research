/**
 * Health Check Module
 *
 * Validates system capabilities using the central health registry.
 * This module is stateless and does not cache results.
 */

import { execFileSync } from 'node:child_process';
import { getConfig } from '../config.ts';
import { isBrowserAvailable, resolveHeadlessMode } from '../infrastructure/browser/config.ts';
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
    // resolveHeadlessMode() selects 'virtual' (Xvfb) only under the explicit
    // PI_RESEARCH_USE_XVFB=true opt-in on a bare Linux TTY. In that case camoufox
    // spawns Xvfb internally, so fail early (before research starts) if it is not
    // installed. The default path is headless:true, which needs no Xvfb.
    if (!mockMode && resolveHeadlessMode() === 'virtual') {
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
    // Resolve cwd from the live service (it captured ctx.cwd at init) so the
    // health check reads the SAME config the store actually uses. Reading
    // process.cwd() here silently ignored SDK/openclaw cwd overrides.
    let service: IKnowledgeStoreService | null = null;
    try {
      service = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, { container }, container);
    } catch {
      // service stays null; the guard below reports it unavailable.
    }
    const cwd = service?.getCwd() ?? process.cwd();
    const config = getConfig(cwd);
    if (config.KNOWLEDGE_STORE_MODE === 'none') {
      return { healthy: true, diagnostic: { status: 'disabled in config' } };
    }
    try {
      if (!service) {
        return { healthy: false, error: 'Knowledge store service not available' };
      }
      const store = await service.getStore();
      const counts = store ? await store.countScoped() : { local: 0, global: 0, projects: 0 };
      const embedder = await service.getEmbedder();

      if (!embedder) {
        return { healthy: false, error: 'Embedder service not available' };
      }

      // A remote embedding-server client reports isInitialized()===true
      // unconditionally (the server, not the client, owns the model), so trusting
      // it would mask a dead server. When the embedder exposes a liveness probe
      // (fetchHealth on the HTTP client), ping it so a down server is reported
      // unhealthy instead of a false "ready". This does NOT warm a local GPU model.
      const probe = (embedder as { fetchHealth?: () => Promise<void> }).fetchHealth;
      if (typeof probe === 'function') {
        try {
          await probe.call(embedder);
        } catch (e) {
          return { healthy: false, error: `Embedding server unreachable: ${e instanceof Error ? e.message : String(e)}` };
        }
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
 * Decide whether a FAILED health check is a transient "pool busy" condition (research
 * should proceed) rather than a genuine failure (research must abort).
 *
 * Returns true when the browser is installed/constructible — BrowserCapability is healthy
 * (it never touches the worker pool) — AND every unhealthy component failed with a TIMEOUT,
 * i.e. its probe queued out behind in-flight scrapes on the shared fixed-size worker pool
 * under load. Under sustained concurrency the runtime probe and the StateManager/KnowledgeStore
 * probes (which share the same congested pool/GPU) frequently time out together, so any
 * combination of timed-out probes is treated as "busy", not "dead". The pool is operational
 * and the per-task search/scrape timeouts already bound the real work, so aborting the whole
 * session on this signal needlessly discards a research category. A non-timeout failure
 * (browser not installed, "connection refused", embedder missing) returns false → caller
 * must abort.
 */
export function isBusyPoolHealthFailure(
  health: { components?: Array<{ component?: string; healthy?: boolean; error?: string }> },
): boolean {
  const components = health.components || [];
  const capability = components.find(c => c.component === 'BrowserCapability');
  // BrowserCapability is the liveness signal: it only checks the browser is installed
  // and constructible, never touching the worker pool. If it is healthy (or absent),
  // the browser CAN run — so any failures elsewhere are about throughput, not death.
  const capabilityOk = !capability || capability.healthy !== false;
  const unhealthy = components.filter(c => c.healthy === false);
  // Proceed only when EVERY unhealthy component failed with a TIMEOUT. Under sustained
  // concurrent load the BrowserRuntime probe — and often the StateManager/KnowledgeStore
  // probes sharing the same congested pool/GPU — all queue out together; requiring the
  // runtime probe to be the SOLE failure was too strict and let a second co-timed-out
  // probe abort an otherwise-operational session. A non-timeout error (browser not
  // installed, "connection refused", embedder missing) is a real fault → returns false.
  const isTimeout = (c: { error?: string }) => /tim(e|ed)\s*out|timeout/i.test(String(c.error || ''));
  return capabilityOk && unhealthy.length > 0 && unhealthy.every(isTimeout);
}

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
