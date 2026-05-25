
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHealthCheck } from '../../../src/healthcheck/index.ts';
import { isBrowserAvailable } from '../../../src/infrastructure/browser/browser-configuration.ts';
import { runBrowserHealthCheck } from '../../../src/infrastructure/browser/task-execution-service.ts';
import { registerService, resetServiceContainer } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';

// Mock dependencies
vi.mock('../../../src/config.ts', () => ({
  getConfig: () => ({ HEALTH_CHECK_TIMEOUT_MS: 25000 }),
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

vi.mock('../../../src/infrastructure/browser/browser-configuration.ts', () => ({
  isBrowserAvailable: vi.fn(),
}));

vi.mock('../../../src/infrastructure/browser/task-execution-service.ts', () => ({
  runBrowserHealthCheck: vi.fn(),
}));

vi.mock('../../../src/core/internal-state.ts', () => ({
  getSchedulerInstance: vi.fn(),
}));

vi.mock('../../../src/infrastructure/knowledge-store-service.ts', () => ({
  KnowledgeStoreService: vi.fn().mockImplementation(() => ({
    name: 'knowledge-store',
    lifecycle: 'initialized',
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
  })),
}));

vi.mock('../../../src/infrastructure/state-manager.ts', () => ({
  StateManager: vi.fn().mockImplementation(() => ({
    name: 'state-manager',
    lifecycle: 'initialized',
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
        lifecycle: 'initialized',
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
        isInitialized() { return true; },
        schedulerId: 'test',
      }),
      { lazyInitialization: false, allowOverwrite: true, enableLogging: false }
    );

    registerService(
      ServiceNames.KNOWLEDGE_STORE,
      () => ({
        name: 'knowledge-store',
        lifecycle: 'initialized',
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
        lifecycle: 'initialized',
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

  it('should fail when browser is not available', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(false);

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.status).toBe('unhealthy');
    expect(result.error).toContain('browser');
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
