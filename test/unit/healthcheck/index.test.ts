import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHealthCheck, registerHealthChecks } from '../../../src/healthcheck/index.ts';
import { HealthCheckRegistry } from '../../../src/healthcheck/registry.ts';
import { isBrowserAvailable } from '../../../src/infrastructure/browser/config.ts';
import { runBrowserHealthCheck } from '../../../src/infrastructure/browser/task-execution-service.ts';
import { registerService, resetServiceContainer, ServiceLifecycle } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';

// Mock dependencies
vi.mock('../../../src/config.ts', () => ({
  getConfig: () => ({ 
    HEALTH_CHECK_TIMEOUT_MS: 25000,
    KNOWLEDGE_STORE_MODE: 'none' 
  }),
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
}));

vi.mock('../../../src/infrastructure/browser/task-execution-service.ts', () => ({
  runBrowserHealthCheck: vi.fn(),
}));

vi.mock('../../../src/infrastructure/knowledge-store-service.ts', () => ({
  KnowledgeStoreService: vi.fn().mockImplementation(() => ({
    name: 'knowledge-store',
    lifecycle: ServiceLifecycle.INITIALIZED,
    isReady: () => true,
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
