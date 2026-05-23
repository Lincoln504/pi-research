/**
 * Chaos Engineering Tests: Browser Manager
 *
 * Tests chaotic scenarios for the browser manager including:
 * - Worker process death during queries
 * - Leadership election disruption
 * - Concurrent leadership contention
 * - State corruption during leader election
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  simulateProcessCrash,
  simulateConnectionReset,
  simulateConnectionRefused,
  withRandomDelay,
  withRandomError,
  executeBurst,
  measureTime,
} from '../../utils/chaos-helpers.ts';
import { CircuitBreaker } from '../../../src/utils/circuit-breaker.ts';

// Mock the poolifier module
const mockExecuteFn = vi.fn();
const mockDestroy = vi.fn(async () => {});
const mockExecuteWithError = vi.fn();

vi.mock('poolifier', () => {
  class MockPool {
    execute = mockExecuteFn;
    destroy = mockDestroy;
  }
  class MockFailingPool {
    execute = mockExecuteWithError;
    destroy = mockDestroy;
  }
  return {
    FixedClusterPool: MockPool,
    WorkerChoiceStrategies: { ROUND_ROBIN: 'ROUND_ROBIN' },
  };
});

// Mock StateManager
vi.mock('../../../src/infrastructure/state-manager.ts', () => {
  let _instance: any = null;
  let _serverInfo: any = null;
  let _electionAttempts = 0;
  let _shouldFailElection = false;

  class MockStateManager {
    getBrowserServer = vi.fn(async () => _serverInfo);
    updateState = vi.fn(async (fn: any) => {
      _electionAttempts++;
      const state = _serverInfo ? { browserServer: _serverInfo } : {};
      
      if (_shouldFailElection && _electionAttempts < 3) {
        // Simulate election failure by not updating state
        return state;
      }
      
      const newState = await fn(state);
      if (newState.browserServer) {
        _serverInfo = newState.browserServer;
      }
      return newState;
    });
    isPidAlive = vi.fn(async (pid: number) => pid === process.pid);
    clearBrowserServer = vi.fn(async () => {
      _serverInfo = null;
      _electionAttempts = 0;
    });
    readState = vi.fn(async () => ({ sessions: {} }));
    acquireGpuLock = vi.fn(async () => true);
    releaseGpuLock = vi.fn(async () => {});
    getGpuOwner = vi.fn(async () => null);
  }
  return {
    StateManager: MockStateManager,
    getSharedStateManager: () => {
      if (!_instance) _instance = new MockStateManager();
      return _instance;
    },
    // Test helpers
    _setServerInfo: (info: any) => { _serverInfo = info; },
    _clearServerInfo: () => { _serverInfo = null; },
    _shouldFailElection: (fail: boolean) => { _shouldFailElection = fail; },
    _getElectionAttempts: () => _electionAttempts,
    _resetElectionAttempts: () => { _electionAttempts = 0; },
  };
});

// Mock config
vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({
    WORKER_THREADS: 2,
    MAX_CONCURRENT_RESEARCHERS: 1,
    WORKER_CONCURRENCY: 1,
  })),
}));

import { 
  runBrowserTask, 
  stopBrowserManager,
  browserCircuitBreaker,
  isTransientSocketError,
} from '../../../src/infrastructure/browser-manager.ts';
import { getSharedStateManager } from '../../../src/infrastructure/state-manager.ts';

describe('Browser Manager Chaos Tests', () => {
  let stateManager: any;
  let _setServerInfo: any;
  let _clearServerInfo: any;
  let _shouldFailElection: any;
  let _getElectionAttempts: any;
  let _resetElectionAttempts: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as any).__PI_RESEARCH_SCHEDULER__ = null;
    (globalThis as any).__PI_RESEARCH_HEALTH_CHECK_PENDING__ = null;
    
    // Get test helpers from mocked StateManager
    const stateModule = await import('../../../src/infrastructure/state-manager.ts');
    _setServerInfo = (stateModule as any)._setServerInfo;
    _clearServerInfo = (stateModule as any)._clearServerInfo;
    _shouldFailElection = (stateModule as any)._shouldFailElection;
    _getElectionAttempts = (stateModule as any)._getElectionAttempts;
    _resetElectionAttempts = (stateModule as any)._resetElectionAttempts;
    
    stateManager = getSharedStateManager();
    await stateManager.clearBrowserServer();
    browserCircuitBreaker.reset();
    _resetElectionAttempts();
  });

  afterEach(async () => {
    await stopBrowserManager().catch(() => {});
    mockExecuteFn.mockReset();
    mockExecuteWithError.mockReset();
    mockDestroy.mockReset();
  });

  describe('Worker Process Death During Queries', () => {
    it('should recover from worker death mid-query and retry successfully', async () => {
      // First call simulates worker crash, second succeeds
      mockExecuteFn
        .mockRejectedValueOnce(simulateProcessCrash('Worker process died'))
        .mockResolvedValueOnce({ html: '<html>recovered</html>' });

      const { result, durationMs } = await measureTime(async () => {
        return await runBrowserTask('https://example.com', 'scrape');
      });

      expect(result).toEqual({ html: '<html>recovered' });
      expect(mockExecuteFn).toHaveBeenCalledTimes(2);
      // Should retry and recover within reasonable time
      expect(durationMs).toBeLessThan(10000);
    });

    it('should handle multiple consecutive worker deaths', async () => {
      const crashCount = 3;
      for (let i = 0; i < crashCount; i++) {
        mockExecuteFn.mockRejectedValueOnce(simulateProcessCrash(`Worker crash ${i + 1}`));
      }
      mockExecuteFn.mockResolvedValueOnce({ html: '<html>final</html>' });

      const result = await runBrowserTask('https://example.com', 'scrape');

      expect(result).toEqual({ html: '<html>final' });
      expect(mockExecuteFn).toHaveBeenCalledTimes(crashCount + 1);
    });

    it('should eventually give up after too many worker deaths', async () => {
      // Always simulate worker crash
      mockExecuteFn.mockRejectedValue(simulateProcessCrash('Persistent worker crash'));

      await expect(runBrowserTask('https://example.com', 'scrape'))
        .rejects.toThrow();

      // Should attempt retries but eventually fail
      expect(mockExecuteFn).toHaveBeenCalledTimes(2); // initial + 1 retry
    });

    it('should handle worker death during concurrent operations', async () => {
      // Setup: some workers die, some succeed
      mockExecuteFn
        .mockRejectedValueOnce(simulateProcessCrash('Worker 1 died'))
        .mockResolvedValueOnce({ results: [{ title: 'Result 1' }] })
        .mockRejectedValueOnce(simulateProcessCrash('Worker 3 died'))
        .mockResolvedValueOnce({ results: [{ title: 'Result 2' }] });

      const results = await Promise.allSettled([
        runBrowserTask({ query: 'test1' }, 'search'),
        runBrowserTask({ query: 'test2' }, 'search'),
        runBrowserTask({ query: 'test3' }, 'search'),
        runBrowserTask({ query: 'test4' }, 'search'),
      ]);

      // At least some should succeed
      const successful = results.filter(r => r.status === 'fulfilled');
      expect(successful.length).toBeGreaterThan(0);
    });
  });

  describe('Leadership Election Disruption', () => {
    it('should handle leadership loss gracefully during operation', async () => {
      // Simulate existing leader
      _setServerInfo({
        pid: 99999, // Different PID
        port: 8080,
        schedulerId: 'other-scheduler'
      });

      // Mock that the "other" process is alive
      stateManager.isPidAlive.mockResolvedValueOnce(true);

      // Should connect as client
      mockExecuteFn.mockResolvedValueOnce({ html: '<html>via-leader</html>' });

      const result = await runBrowserTask('https://example.com', 'scrape');

      expect(result).toEqual({ html: '<html>via-leader</html>' });
    });

    it('should take over leadership when previous leader dies', async () => {
      // Simulate dead leader
      _setServerInfo({
        pid: 99999,
        port: 8080,
        schedulerId: 'dead-scheduler'
      });

      // First check says dead, so we should take over
      stateManager.isPidAlive.mockResolvedValueOnce(false);

      mockExecuteFn.mockResolvedValueOnce({ html: '<html>new-leader</html>' });

      const result = await runBrowserTask('https://example.com', 'scrape');

      expect(result).toEqual({ html: '<html>new-leader</html>' });
      
      // Should have attempted to acquire leadership
      expect(stateManager.updateState).toHaveBeenCalled();
    });

    it('should retry leadership election on transient failure', async () => {
      _clearServerInfo();
      
      // Simulate transient election failure
      _shouldFailElection(true);
      
      // After attempts, succeed
      mockExecuteFn.mockResolvedValueOnce({ html: '<html>elected</html>' });

      const result = await runBrowserTask('https://example.com', 'scrape');

      expect(result).toEqual({ html: '<html>elected</html>' });
      
      // Should have retried
      expect(_getElectionAttempts()).toBeGreaterThan(1);
    });

    it('should handle concurrent leadership attempts', async () => {
      _clearServerInfo();

      const tasks = Array.from({ length: 5 }, (_, i) =>
        runBrowserTask({ query: `concurrent-${i}` }, 'search')
          .catch(err => ({ error: err.message }))
      );

      mockExecuteFn.mockResolvedValue({ results: [{ title: 'Success' }] });

      const results = await Promise.all(tasks);

      // All should complete, either as leader or client
      expect(results.length).toBe(5);
      
      // At least one should have succeeded
      const successful = results.filter((r: any) => !r.error);
      expect(successful.length).toBeGreaterThan(0);
    });

    it('should maintain operation across leadership transition', async () => {
      // Start as leader
      mockExecuteFn.mockResolvedValueOnce({ html: '<html>as-leader</html>' });

      const result1 = await runBrowserTask('https://example.com', 'scrape');
      expect(result1).toEqual({ html: '<html>as-leader</html>' });

      // Simulate leadership loss
      _setServerInfo({
        pid: 88888,
        port: 8081,
        schedulerId: 'new-leader'
      });
      stateManager.isPidAlive.mockResolvedValueOnce(true);

      // Next operation should still work (as client)
      mockExecuteFn.mockResolvedValueOnce({ html: '<html>as-client</html>' });

      const result2 = await runBrowserTask('https://example.com', 'scrape');
      expect(result2).toEqual({ html: '<html>as-client</html>' });
    });
  });

  describe('Network Failure Injection', () => {
    it('should retry on transient network errors', async () => {
      mockExecuteFn
        .mockRejectedValueOnce(simulateConnectionReset())
        .mockResolvedValueOnce({ html: '<html>recovered</html>' });

      const result = await runBrowserTask('https://example.com', 'scrape');

      expect(result).toEqual({ html: '<html>recovered' });
      expect(mockExecuteFn).toHaveBeenCalledTimes(2);
    });

    it('should retry on connection refused', async () => {
      mockExecuteFn
        .mockRejectedValueOnce(simulateConnectionRefused())
        .mockResolvedValueOnce({ html: '<html>connected</html>' });

      const result = await runBrowserTask('https://example.com', 'scrape');

      expect(result).toEqual({ html: '<html>connected' });
      expect(mockExecuteFn).toHaveBeenCalledTimes(2);
    });

    it('should identify transient socket errors correctly', () => {
      expect(isTransientSocketError(new Error('ECONNRESET: socket hang up'))).toBe(true);
      expect(isTransientSocketError(new Error('ECONNREFUSED: connection refused'))).toBe(true);
      expect(isTransientSocketError(new Error('ETIMEDOUT: operation timed out'))).toBe(true);
      expect(isTransientSocketError(new Error('socket hang up'))).toBe(true);
      expect(isTransientSocketError(new Error('unreachable'))).toBe(true);
      expect(isTransientSocketError(new Error('Fatal parse error'))).toBe(false);
      expect(isTransientSocketError(new Error('Validation failed'))).toBe(false);
    });

    it('should not retry on non-transient errors', async () => {
      mockExecuteFn.mockRejectedValue(new Error('Fatal parse error: invalid JSON'));

      await expect(runBrowserTask('https://example.com', 'scrape'))
        .rejects.toThrow('Fatal parse error');

      expect(mockExecuteFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('Circuit Breaker Integration', () => {
    it('should open circuit after consecutive failures', async () => {
      // Fill the circuit breaker with failures
      for (let i = 0; i < 5; i++) {
        mockExecuteFn.mockRejectedValueOnce(simulateConnectionReset());
      }

      // All should fail
      for (let i = 0; i < 5; i++) {
        await expect(runBrowserTask('https://example.com', 'scrape'))
          .rejects.toThrow();
      }

      // Circuit should be open now
      expect(browserCircuitBreaker.getState()).toBe('OPEN');

      // Next call should fast-fail
      await expect(runBrowserTask('https://example.com', 'scrape'))
        .rejects.toThrow('CircuitBreaker');
    });

    it('should recover circuit after timeout and success', async () => {
      // Open the circuit first
      for (let i = 0; i < 5; i++) {
        mockExecuteFn.mockRejectedValueOnce(simulateConnectionReset());
      }

      for (let i = 0; i < 5; i++) {
        await expect(runBrowserTask('https://example.com', 'scrape'))
          .rejects.toThrow();
      }

      expect(browserCircuitBreaker.getState()).toBe('OPEN');

      // Manually set a short reset timeout for test
      const privateBreaker = browserCircuitBreaker as any;
      privateBreaker.options.resetTimeoutMs = 100;
      privateBreaker.nextAttemptTime = Date.now() - 200; // Make it expired

      // Now a success should close the circuit
      mockExecuteFn.mockResolvedValueOnce({ html: '<html>success</html>' });

      const result = await runBrowserTask('https://example.com', 'scrape');
      expect(result).toEqual({ html: '<html>success</html>' });

      // Circuit should be closed now
      expect(browserCircuitBreaker.getState()).toBe('CLOSED');
    });
  });

  describe('Concurrent Chaos Scenarios', () => {
    it('should handle burst of requests with mixed failures', async () => {
      const burstSize = 10;
      let callCount = 0;

      mockExecuteFn.mockImplementation(() => {
        callCount++;
        // Fail first 3, then succeed
        if (callCount <= 3) {
          return Promise.reject(simulateConnectionReset());
        }
        return Promise.resolve({ results: [{ title: `Result ${callCount}` }] });
      });

      const results = await executeBurst(
        Array.from({ length: burstSize }, (_, i) =>
          () => runBrowserTask({ query: `test-${i}` }, 'search')
        ),
        5 // burst in batches of 5
      );

      expect(results.length).toBe(burstSize);
    });

    it('should handle concurrent operations with random delays', async () => {
      let callCount = 0;
      
      mockExecuteFn.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          results: [{ title: `Result ${callCount}` }],
          timestamp: Date.now()
        });
      });

      const tasks = Array.from({ length: 8 }, (_, i) =>
        withRandomDelay(
          () => runBrowserTask({ query: `delayed-${i}` }, 'search'),
          { min: 10, max: 50 }
        )()
      );

      const results = await Promise.all(tasks);
      expect(results.length).toBe(8);
    });

    it('should maintain consistency under high contention', async () => {
      const taskCount = 20;
      const operations: Array<() => Promise<any>> = [];

      // Mix of search and scrape operations
      for (let i = 0; i < taskCount; i++) {
        if (i % 2 === 0) {
          operations.push(() => 
            runBrowserTask({ query: `contention-${i}` }, 'search')
          );
        } else {
          operations.push(() => 
            runBrowserTask(`https://example.com/${i}`, 'scrape')
          );
        }
      }

      mockExecuteFn.mockResolvedValue({
        results: [{ title: 'Success' }],
        html: '<html>Success</html>'
      });

      const results = await Promise.allSettled(
        operations.map(op => op())
      );

      // Count successes and failures
      const successes = results.filter(r => r.status === 'fulfilled');
      const failures = results.filter(r => r.status === 'rejected');

      // With proper resource management, most should succeed
      expect(successes.length).toBeGreaterThan(taskCount * 0.8);
    });
  });

  describe('Resource Exhaustion Scenarios', () => {
    it('should handle scheduler restart under load', async () => {
      // Start some tasks
      mockExecuteFn.mockResolvedValue({ html: '<html>initial</html>' });

      const initialTasks = await Promise.all([
        runBrowserTask({ query: 'task1' }, 'search'),
        runBrowserTask({ query: 'task2' }, 'search'),
      ]);

      expect(initialTasks).toHaveLength(2);

      // Force restart (simulated)
      await stopBrowserManager();
      
      // Small delay for cleanup
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should be able to start new tasks after restart
      mockExecuteFn.mockResolvedValue({ html: '<html>after-restart</html>' });

      const result = await runBrowserTask({ query: 'after-restart' }, 'search');
      expect(result).toEqual({ html: '<html>after-restart</html>' });
    });

    it('should handle timeout under heavy load', async () => {
      // Simulate slow responses
      mockExecuteFn.mockImplementation(() => 
        new Promise(resolve => 
          setTimeout(() => resolve({ html: '<html>slow</html>' }), 20000)
        )
      );

      // This should timeout and potentially retry
      const startTime = Date.now();
      
      await expect(
        runBrowserTask('https://example.com', 'scrape')
      ).rejects.toThrow();

      // Should fail fast, not wait forever
      expect(Date.now() - startTime).toBeLessThan(35000);
    });
  });
});