import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHealthCheck, registerHealthChecks, isBusyPoolHealthFailure } from '../../../src/healthcheck/index.ts';
import { HealthCheckRegistry } from '../../../src/healthcheck/registry.ts';
import { isBrowserAvailable } from '../../../src/infrastructure/browser/config.ts';
import { runBrowserHealthCheck } from '../../../src/infrastructure/browser/task-execution-service.ts';
import { registerService, resetServiceContainer, ServiceLifecycle } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';
import { getConfig } from '../../../src/config.ts';

// Mock dependencies. getConfig is a vi.fn so individual tests can override the
// KNOWLEDGE_STORE_MODE to exercise the non-disabled health path.
vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({
    HEALTH_CHECK_TIMEOUT_MS: 25000,
    KNOWLEDGE_STORE_MODE: 'none'
  })),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../src/infrastructure/browser/config.ts', () => ({
  isBrowserAvailable: vi.fn(),
  // resolveHeadlessMode is called inside checkBrowserCapability() to decide whether
  // to gate on Xvfb. Default to returning true (non-virtual) so existing tests that
  // don't care about Xvfb checking are not affected.
  resolveHeadlessMode: vi.fn().mockReturnValue(true),
}));

vi.mock('../../../src/infrastructure/browser/task-execution-service.ts', () => ({
  runBrowserHealthCheck: vi.fn(),
}));

vi.mock('../../../src/infrastructure/knowledge-store-service.ts', () => ({
  KnowledgeStoreService: vi.fn().mockImplementation(() => ({
    name: 'knowledge-store',
    lifecycle: ServiceLifecycle.INITIALIZED,
    isReady: () => true,
    getCwd: () => process.cwd(),
    async initialize() {},
    async dispose() {},
    async getEmbedder() {
      return {
        isInitialized: () => false,
        getDevice: () => 'cpu',
        getOriginalDevice: () => 'cpu',
      };
    },
    async getStore() { 
        return {
            countScoped: async () => ({ local: 0, global: 0, projects: 0 })
        }; 
    },
  })),
}));

vi.mock('../../../src/infrastructure/state/state-manager.ts', () => ({
  StateManager: vi.fn().mockImplementation(() => ({
    name: 'state-manager',
    lifecycle: ServiceLifecycle.INITIALIZED,
    async initialize() {},
    async dispose() {},
    async getMetrics() {
      return { activeSessions: 0 };
    },
    async getGpuOwner() {
      return null;
    },
  })),
}));

describe('healthcheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks clears call history but not implementations set via
    // mockReturnValue, so restore the default 'none' config each test.
    vi.mocked(getConfig).mockReturnValue({
      HEALTH_CHECK_TIMEOUT_MS: 25000,
      KNOWLEDGE_STORE_MODE: 'none',
    } as any);

    // Register mock services
    registerService(
      ServiceNames.SCHEDULER,
      () => ({
        name: 'scheduler',
        lifecycle: ServiceLifecycle.INITIALIZED,
        async initialize() {},
        async dispose() {},
        async runSearch() { return []; },
        async runScrape() { return { html: '' }; },
        async runHealthCheck() { return { success: true }; },
        async shutdown() {},
        getSchedulerInstance() { return { name: 'test-scheduler' }; },
        getSchedulerVersion() { return '1.0.0'; },
        getSchedulerInitializationPromise() { return null; },
        setSchedulerVersion() {},
        setSchedulerInitializationPromise() {},
        isSchedulerRestartInProgress() { return false; },
        setSchedulerRestartInProgress() {},
        setSchedulerInstance() {},
        isReady() { return true; },
        schedulerId: 'test',
      }),
      { lazyInitialization: false, allowOverwrite: true, enableLogging: false }
    );

    registerService(
      ServiceNames.HEALTH_REGISTRY,
      async () => {
        const registry = new HealthCheckRegistry();
        await registry.initialize();
        registerHealthChecks(registry);
        return registry;
      },
      { lazyInitialization: false, allowOverwrite: true, enableLogging: false }
    );

    registerService(
      ServiceNames.KNOWLEDGE_STORE,
      () => ({
        name: 'knowledge-store',
        lifecycle: ServiceLifecycle.INITIALIZED,
        isReady: () => true,
        getCwd: () => process.cwd(),
        async initialize() {},
        async dispose() {},
        async getEmbedder() {
          return {
            isInitialized: () => false,
            getDevice: () => 'cpu',
            getOriginalDevice: () => 'cpu',
          };
        },
        async getStore() { return {}; },
      }),
      { lazyInitialization: false, allowOverwrite: true, enableLogging: false }
    );

    registerService(
      ServiceNames.STATE_MANAGER,
      () => ({
        name: 'state-manager',
        lifecycle: ServiceLifecycle.INITIALIZED,
        async initialize() {},
        async dispose() {},
        async getMetrics() {
          return { activeSessions: 0 };
        },
        async getGpuOwner() {
          return null;
        },
      }),
      { lazyInitialization: false, allowOverwrite: true, enableLogging: false }
    );
  });

  afterEach(() => {
    resetServiceContainer();
  });

  it('should pass health check when browser pool reports success', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });

    const result = await runHealthCheck();

    expect(result.success).toBe(true);
    expect(result.status).toBe('healthy');
  });

  it('should fail when browser is not available and not in mock mode', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(false);
    // Ensure mock env vars are absent so mock-mode bypass doesn't fire.
    delete process.env['PI_RESEARCH_MOCK_SEARCH'];
    delete process.env['PI_RESEARCH_MOCK_SCRAPE'];

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.status).toBe('unhealthy');
    expect(result.error).toContain('browser');
  });

  it('should pass BrowserCapability in full mock mode even when isBrowserAvailable returns false', async () => {
    // In mock mode (both MOCK vars set), the browser pool is replaced by mocks —
    // it IS "available", just not backed by a real Camoufox binary.
    vi.mocked(isBrowserAvailable).mockReturnValue(false);
    process.env['PI_RESEARCH_MOCK_SEARCH'] = 'true';
    process.env['PI_RESEARCH_MOCK_SCRAPE'] = 'true';
    try {
      const result = await runHealthCheck();
      expect(result.success).toBe(true);
      const browserCap = result.components?.find(c => c.component === 'BrowserCapability');
      expect(browserCap?.healthy).toBe(true);
      expect(browserCap?.diagnostic?.['status']).toBe('mocked');
    } finally {
      delete process.env['PI_RESEARCH_MOCK_SEARCH'];
      delete process.env['PI_RESEARCH_MOCK_SCRAPE'];
    }
  });

  it('reports the knowledge store UNHEALTHY when the embedding server is unreachable', async () => {
    // A remote embedding-server client reports isInitialized()===true even when the
    // server is dead. With the store enabled, the health check must probe the
    // server's liveness (fetchHealth) and surface a failure rather than a false ready.
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });
    vi.mocked(getConfig).mockReturnValue({
      HEALTH_CHECK_TIMEOUT_MS: 25000,
      KNOWLEDGE_STORE_MODE: 'project',
      EMBEDDING_MODEL: 'test-model',
    } as any);
    registerService(
      ServiceNames.KNOWLEDGE_STORE,
      () => ({
        name: 'knowledge-store',
        lifecycle: ServiceLifecycle.INITIALIZED,
        isReady: () => true,
        getCwd: () => process.cwd(),
        async initialize() {},
        async dispose() {},
        async getEmbedder() {
          return {
            isInitialized: () => true, // client always claims ready...
            getDevice: () => 'cpu',
            getOriginalDevice: () => 'cpu',
            // ...but the liveness probe fails because the server is down.
            fetchHealth: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:7070'); },
          };
        },
        async getStore() {
          return { countScoped: async () => ({ local: 0, global: 0, projects: 0 }) };
        },
      }),
      { lazyInitialization: false, allowOverwrite: true, enableLogging: false }
    );

    const result = await runHealthCheck();

    const ks = result.components?.find(c => c.component === 'KnowledgeStore');
    expect(ks?.healthy).toBe(false);
    expect(ks?.error).toMatch(/unreachable|ECONNREFUSED/i);
  });

  it('should fail when browser pool health check fails', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: false });

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.status).toBe('unhealthy');
    expect(result.error).toContain('Browser healthcheck failed');
  });

  it('should fail when browser pool health check throws', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockRejectedValue(new Error('connection refused'));

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.status).toBe('unhealthy');
    expect(result.error).toContain('connection refused');
  });
});

describe('isBusyPoolHealthFailure', () => {
  const busyRuntime = { component: 'BrowserRuntime', healthy: false, error: 'Browser healthcheck failed: Health check timed out after 105000ms (including queue wait)' };
  const okCapability = { component: 'BrowserCapability', healthy: true };

  it('returns true when capability is healthy and only BrowserRuntime timed out (pool busy)', () => {
    expect(isBusyPoolHealthFailure({ components: [okCapability, busyRuntime] })).toBe(true);
  });

  it('returns true when capability entry is absent but the only failure is a runtime timeout', () => {
    expect(isBusyPoolHealthFailure({ components: [busyRuntime] })).toBe(true);
  });

  it('returns false when BrowserCapability itself is unhealthy (browser not installed)', () => {
    expect(isBusyPoolHealthFailure({ components: [
      { component: 'BrowserCapability', healthy: false, error: 'Camoufox not found' },
      busyRuntime,
    ] })).toBe(false);
  });

  it('returns false when BrowserRuntime failed for a non-timeout reason (real failure)', () => {
    expect(isBusyPoolHealthFailure({ components: [
      okCapability,
      { component: 'BrowserRuntime', healthy: false, error: 'worker reported failure or page failed to load' },
    ] })).toBe(false);
  });

  it('returns true when runtime AND state-manager both time out under load (capability healthy)', () => {
    // The dominant real-world pattern: sustained pool/GPU contention queues out the
    // runtime probe and a second probe together. Both are timeouts → still "busy".
    expect(isBusyPoolHealthFailure({ components: [
      okCapability,
      busyRuntime,
      { component: 'StateManager', healthy: false, error: 'Health check timed out after 25000ms' },
    ] })).toBe(true);
  });

  it('returns false when a co-failing component has a NON-timeout error (real fault)', () => {
    expect(isBusyPoolHealthFailure({ components: [
      okCapability,
      busyRuntime,
      { component: 'KnowledgeStore', healthy: false, error: 'Embedder service not available' },
    ] })).toBe(false);
  });

  it('returns false when there are no unhealthy components', () => {
    expect(isBusyPoolHealthFailure({ components: [okCapability, { component: 'BrowserRuntime', healthy: true }] })).toBe(false);
  });

  it('returns false on an empty/missing components list', () => {
    expect(isBusyPoolHealthFailure({})).toBe(false);
    expect(isBusyPoolHealthFailure({ components: [] })).toBe(false);
  });
});
