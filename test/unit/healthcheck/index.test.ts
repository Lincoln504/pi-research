
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

describe('healthcheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Register mock scheduler service
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
        schedulerId: 'test',
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
    expect(result.searchOk).toBe(true);
    expect(result.scrapeOk).toBe(true);
  });

  it('should fail when browser is not available', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(false);

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.searchOk).toBe(false);
    expect(result.error).toContain('Browser binaries');
  });

  it('should fail when browser pool health check fails', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: false });

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.searchOk).toBe(false);
    expect(result.error).toContain('Browser healthcheck failed');
  });

  it('should fail when browser pool health check throws', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockRejectedValue(new Error('connection refused'));

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.searchOk).toBe(false);
    expect(result.error).toContain('connection refused');
  });
});
