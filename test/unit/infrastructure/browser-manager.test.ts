import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runBrowserTask, stopBrowserManager, forceSchedulerRestart } from '../../../src/infrastructure/browser-manager.ts';
import { getConfig } from '../../../src/config.ts';

// Mock poolifier
const mockDestroy = vi.fn(async () => {});
vi.mock('poolifier', () => {
  class MockPool {
    execute = vi.fn(async (task) => {
        if (task.type === 'search') return { results: [] };
        if (task.type === 'scrape') return { html: '<html></html>' };
        if (task.type === 'healthcheck') return { success: true };
        return {};
    });
    destroy = mockDestroy;
  }
  return {
    FixedThreadPool: MockPool,
    FixedClusterPool: MockPool,
    WorkerChoiceStrategies: { LEAST_USED: 'LEAST_USED', ROUND_ROBIN: 'ROUND_ROBIN' },
  };
});

// Mock StateManager as a class
const mockClearBrowserServer = vi.fn(async () => {});
let _mockStateManagerInstance: any = null;
vi.mock('../../../src/infrastructure/state-manager.ts', () => {
  class MockStateManager {
    getBrowserServer = vi.fn(async () => null);
    updateState = vi.fn(async (fn: any) => {
        const state = { browserServer: null };
        return fn(state);
    });
    isPidAlive = vi.fn(async () => false);
    clearBrowserServer = mockClearBrowserServer;
    readState = vi.fn(async () => ({ sessions: {} }));
  }
  return {
    StateManager: MockStateManager,
    getSharedStateManager: () => {
      if (!_mockStateManagerInstance) _mockStateManagerInstance = new MockStateManager();
      return _mockStateManagerInstance;
    },
  };
});

// Mock Config
vi.mock('../../../src/config.ts', () => ({
    getConfig: vi.fn(() => ({
        WORKER_THREADS: 4,
        MAX_CONCURRENT_RESEARCHERS: 2,
        WORKER_CONCURRENCY: 1
    })),
}));

describe('BrowserManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).__PI_RESEARCH_SCHEDULER__ = null;
    (globalThis as any).__PI_RESEARCH_HEALTH_CHECK_PENDING__ = null;
  });

  afterEach(async () => {
    await stopBrowserManager();
  });

  it('should run a search task', async () => {
    const results = await runBrowserTask('test query', 'search');
    expect(results).toEqual([]);
  });

  it('should run a scrape task', async () => {
    const result = await runBrowserTask('https://example.com', 'scrape');
    expect(result).toEqual({ html: '<html></html>' });
  });

  it('should reuse scheduler when config is same', async () => {
    await runBrowserTask('q1', 'search');
    const firstScheduler = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
    
    await runBrowserTask('q2', 'search');
    const secondScheduler = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
    
    expect(firstScheduler).toBe(secondScheduler);
  });

  it('should restart scheduler when config changes', async () => {
    // First run with initial config (WORKER_THREADS: 4)
    await runBrowserTask('q1', 'search');
    const firstScheduler = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
    expect(firstScheduler).not.toBeNull();

    // Change config
    vi.mocked(getConfig).mockReturnValue({
        WORKER_THREADS: 8, // Changed from 4
        MAX_CONCURRENT_RESEARCHERS: 2,
        WORKER_CONCURRENCY: 1
    } as any);

    // Second run should detect change and restart
    await runBrowserTask('q2', 'search');
    const secondScheduler = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
    
    expect(secondScheduler).not.toBe(firstScheduler);
    expect(secondScheduler).not.toBeNull();
    
    // Should have called destroy on the old pool (via old scheduler shutdown)
    expect(mockDestroy).toHaveBeenCalled();
  });

  it('forceSchedulerRestart clears global state', async () => {
    await runBrowserTask('q1', 'search');
    expect((globalThis as any).__PI_RESEARCH_SCHEDULER__).not.toBeNull();
    
    await forceSchedulerRestart();
    
    expect((globalThis as any).__PI_RESEARCH_SCHEDULER__).toBeNull();
    expect(mockClearBrowserServer).toHaveBeenCalled();
  });

  describe('BrowserTaskScheduler Internals', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should lose leadership if schedulerId changes in state', async () => {
      await runBrowserTask('q1', 'search');
      const scheduler = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
      const shutdownSpy = vi.spyOn(scheduler, 'shutdown');
      
      const { StateManager } = await import('../../../src/infrastructure/state-manager.ts');
      const mockStateManager = (scheduler as any).stateManager;
      
      // Initially it has leadership
      vi.mocked(mockStateManager.getBrowserServer).mockResolvedValue({
          schedulerId: scheduler.schedulerId,
          pid: process.pid,
          url: 'http://localhost:1234'
      });
      
      // Advance timers for leadership check (60s)
      await vi.advanceTimersByTimeAsync(60001);
      expect(shutdownSpy).not.toHaveBeenCalled();
      
      // Change leadership in state
      vi.mocked(mockStateManager.getBrowserServer).mockResolvedValue({
          schedulerId: 'someone-else',
          pid: 9999,
          url: 'http://localhost:1234'
      });
      
      await vi.advanceTimersByTimeAsync(60001);
      expect(shutdownSpy).toHaveBeenCalled();
    });

    it('should shut down after idle timeout', async () => {
      await runBrowserTask('q1', 'search');
      const scheduler = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
      const shutdownSpy = vi.spyOn(scheduler, 'shutdown');
      
      const mockStateManager = (scheduler as any).stateManager;
      vi.mocked(mockStateManager.getBrowserServer).mockResolvedValue({
          schedulerId: scheduler.schedulerId,
          pid: process.pid,
          url: 'http://localhost:1234'
      });

      // IDLE_TIMEOUT_MS is 30 minutes
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
      expect(shutdownSpy).toHaveBeenCalled();
    });

    it('should reset idle timer on activity', async () => {
      await runBrowserTask('q1', 'search');
      const scheduler = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
      const shutdownSpy = vi.spyOn(scheduler, 'shutdown');
      
      const mockStateManager = (scheduler as any).stateManager;
      vi.mocked(mockStateManager.getBrowserServer).mockResolvedValue({
          schedulerId: scheduler.schedulerId,
          pid: process.pid,
          url: 'http://localhost:1234'
      });

      // Wait 20 minutes
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(shutdownSpy).not.toHaveBeenCalled();
      
      // Perform activity
      await runBrowserTask('q2', 'search');
      
      // Wait another 20 minutes (total 40 minutes, but only 20 since last activity)
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(shutdownSpy).not.toHaveBeenCalled();
      
      // Wait 15 more minutes -> should shut down
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(shutdownSpy).toHaveBeenCalled();
    });
  });
});

