/**
 * Health Check Module
 *
 * Validates system capabilities using the central health registry.
 * This module is stateless and does not cache results.
 */

import { execFileSync } from 'node:child_process';
import { getConfig } from '../config.ts';
import { isBrowserAvailable, resolveHeadlessMode, getHealthCheckBudgetMs } from '../infrastructure/browser/config.ts';
import { runBrowserHealthCheck } from '../infrastructure/browser/task-execution-service.ts';
import { getService, tryGetServiceContainerFromCtx, getServiceContainer, ServiceLifecycle } from '../core/service-registry.ts';
import type { ServiceContainer } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IStateManager, IHealthRegistryService, IKnowledgeStoreService, ISchedulerService } from '../core/service-interfaces.ts';
import { healthRegistry as globalHealthRegistry } from './registry.ts';
import { isNativeStackUnavailableError } from '../knowledge/embedder-utils.ts';

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
    return { healthy: false, error: 'Camoufox (browser) not found. Run "npx camoufox-js fetch" to install the browser.' };
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
    // Honor the configured health timeout but keep a 150s floor: a cold browser
    // launch (camoufox download/spawn) can legitimately take minutes, so we never
    // go below that, but a user who raises HEALTH_CHECK_TIMEOUT_MS past it is
    // respected (same pattern as the KnowledgeStore check's Math.max floor).
    //
    // This must ALSO never be less than getHealthCheckBudgetMs(): that is the
    // deadline runBrowserHealthCheck's own scheduler call arms internally (derived
    // from SEARCH_TIMEOUT_MS/SCRAPE_TIMEOUT_MS/BROWSER_TASK_TIMEOUT_MS so it always
    // out-waits the longest a task can legitimately hold a worker slot). A fixed
    // 150s floor here can be smaller than that derived budget at raised timeouts,
    // which would abort this registry-level race before the inner check ever gets
    // to return — reporting a merely busy pool as unhealthy, the exact failure
    // class the derived budget exists to prevent, one call-frame further out.
  }, { timeoutMs: Math.max(healthTimeoutMs, 150000, getHealthCheckBudgetMs(config)), critical: true });

  // Register Knowledge Store Check — NON-critical: the store is the optional cache
  // research must run without (see the darwin-x64 comment below). A failure here
  // (e.g. a dead embedding server, ECONNREFUSED) must degrade health, not flip the
  // aggregate to unhealthy: as a critical check it aborted runs, and the raw store
  // error then fed the TUI's browser-oriented formatter, which misattributed it as
  // "the browser hit a network error / check your internet connection".
  registry.register('KnowledgeStore', async (options) => {
    // Idle fast-path — mirrors the BrowserRuntime check above. Read the ALREADY
    // resolved instance via tryGet(), which does NOT initialize the service;
    // getService() (below) would run the full LanceDB open + ONNX model load +
    // WebGPU probe, so a non-forced health check must never take that path on a
    // cold store. Only inspect for real when the store is already initialized OR an
    // explicit probe is requested (force).
    const existing = container.tryGet<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
    const alreadyInitialized = existing?.lifecycle === ServiceLifecycle.INITIALIZED;
    if (!alreadyInitialized && !options?.force) {
      const idleCwd = existing?.getCwd() ?? process.cwd();
      if (getConfig(idleCwd).KNOWLEDGE_STORE_MODE === 'none') {
        return { healthy: true, diagnostic: { status: 'disabled in config' } };
      }
      // A store that resolved-then-disabled reports WHY, accurately: 'native' is a
      // permanent platform capability gap; 'mode' is a revivable Knowledge-Mode=none
      // (which may have since been re-enabled — it re-initializes on next real use).
      // Never claim "native unavailable" for a mode-disable on a perfectly capable host.
      if (existing?.lifecycle === ServiceLifecycle.DISABLED) {
        const reason = existing.getDisabledReason();
        return { healthy: true, diagnostic: {
          status: reason === 'native'
            ? 'disabled (native embedding/vector stack unavailable on this platform)'
            : 'disabled',
        } };
      }
      // A DISPOSED/DISPOSING service is not "ready" — report it accurately without
      // initializing anything (it re-resolves lazily on next real use, so still healthy).
      const status = existing?.lifecycle === ServiceLifecycle.INITIALIZING
        ? 'initializing'
        : (existing?.lifecycle === ServiceLifecycle.DISPOSED || existing?.lifecycle === ServiceLifecycle.DISPOSING)
          ? 'disposed (not running)'
          : 'ready (idle)';
      return { healthy: true, diagnostic: { status } };
    }

    // Full inspection (already-initialized OR forced): resolve via getService —
    // cheap when warm (early-returns), full init only on a forced cold probe.
    // Resolve cwd from the live service (it captured ctx.cwd at init) so the
    // health check reads the SAME config the store actually uses. Reading
    // process.cwd() here silently ignored SDK/CLI cwd overrides.
    let service: IKnowledgeStoreService | null = null;
    let initError: unknown = null;
    try {
      service = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, { container }, container);
    } catch (e) {
      // service stays null; classify the failure below (native-unavailable vs real).
      initError = e;
    }
    const cwd = service?.getCwd() ?? process.cwd();
    const config = getConfig(cwd);
    if (config.KNOWLEDGE_STORE_MODE === 'none') {
      return { healthy: true, diagnostic: { status: 'disabled in config' } };
    }
    // The native ML/vector stack ships no prebuilt for some platforms (Intel macOS
    // / darwin-x64 has no onnxruntime-node binary nor @lancedb native binding). That
    // is a permanent capability gap, not a fault — report the store as DISABLED
    // (healthy) so research still runs without the optional cache. Otherwise this
    // critical component drags overall health to 'unhealthy' and quick (depth-0)
    // research aborts with "Research cannot start" for any fresh user on such a host.
    if (isNativeStackUnavailableError(initError)) {
      return { healthy: true, diagnostic: { status: 'disabled (native embedding/vector stack unavailable on this platform)' } };
    }
    // getService can SUCCEED on a native-unavailable platform: the service memoizes
    // the failure as DISABLED instead of throwing, so initError stays null and the
    // getStore()/getEmbedder() null checks below would report a false UNHEALTHY
    // ("Embedder service not available") on a forced check — contradicting the
    // non-forced path's correct "disabled" verdict above. Report the same verdict.
    if (service?.lifecycle === ServiceLifecycle.DISABLED) {
      const reason = service.getDisabledReason();
      return { healthy: true, diagnostic: {
        status: reason === 'native'
          ? 'disabled (native embedding/vector stack unavailable on this platform)'
          : 'disabled',
      } };
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
      // Same platform-capability gap as above, but surfacing only when the store
      // is touched lazily (getStore/getEmbedder load the native binding here).
      if (isNativeStackUnavailableError(e)) {
        return { healthy: true, diagnostic: { status: 'disabled (native embedding/vector stack unavailable on this platform)' } };
      }
      return { healthy: false, error: `Knowledge store healthcheck failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }, { timeoutMs: Math.max(healthTimeoutMs, 45000), critical: false });

  // Register State Manager Check
  registry.register('StateManager', async () => {
    try {
      const stateManager = await getService<IStateManager>(ServiceNames.STATE_MANAGER, { container }, container);
      const gpuOwner = await stateManager.getGpuOwner();

      // No `sessions` field here: the session-tracking API (addSession/
      // removeSession/updateHeartbeat) that would ever populate state.sessions
      // has no production caller anywhere in the codebase — stats.activeSessions
      // was always 0, permanently, presenting fake data as a live diagnostic.
      return {
          healthy: true,
          diagnostic: {
              status: 'operational',
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
