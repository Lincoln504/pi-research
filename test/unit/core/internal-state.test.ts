/**
 * Tests for Internal State Management
 *
 * These tests verify that the internal state management correctly replaces
 * globalThis usage while maintaining thread safety and proper cleanup.
 * Focus on meaningful behavior tests rather than simple getter/setter tests.
 *
 * Note: Health check state management has been moved to health-cache-manager.ts
 * to avoid circular dependencies between healthcheck and knowledge modules.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getSchedulerInstance,
  setScheduler,
  getSchedulerVersionState,
  setSchedulerVersion,
  getSchedulerInitializationPromise,
  setSchedulerInitializationPromise,
  isSchedulerRestartInProgress,
  setSchedulerRestartInProgress,
  clearSchedulerState,
  resetAllInternalState,
} from '../../../src/core/internal-state.ts';
import {
  getHealthCheckPending,
  setHealthCheckPending,
  getHealthCheckFailureCount,
  incrementHealthCheckFailureCount,
  resetHealthCheckFailureCount,
  isHealthCheckBackoffActive,
  getHealthCheckBackoffRemainingMs,
  clearHealthCheckCache,
} from '../../../src/core/health-cache-manager.ts';
import type { IScheduler } from '../../../src/core/service-interfaces.ts';

// Mock scheduler for testing
const mockScheduler: IScheduler = {
  name: 'mock-scheduler',
  lifecycle: 'initialized' as any,
  runSearch: vi.fn(),
  runScrape: vi.fn(),
  runHealthCheck: vi.fn(),
  shutdown: vi.fn(),
};

describe('Internal State Management - Scheduler', () => {
  beforeEach(() => {
    resetAllInternalState();
  });

  afterEach(() => {
    resetAllInternalState();
  });

  describe('Scheduler State Persistence', () => {
    it('maintains scheduler state across operations', () => {
      setScheduler(mockScheduler);
      setSchedulerVersion('v1.0.0');

      expect(getSchedulerInstance()).toBe(mockScheduler);
      expect(getSchedulerVersionState()).toBe('v1.0.0');

      // Perform multiple operations
      const scheduler = getSchedulerInstance();
      expect(scheduler).toBe(mockScheduler);
      expect(scheduler.name).toBe('mock-scheduler');
      expect(getSchedulerVersionState()).toBe('v1.0.0');
    });

    it('allows updating scheduler instance independently of version', () => {
      setScheduler(mockScheduler);
      setSchedulerVersion('v1.0.0');

      const newScheduler = { ...mockScheduler, name: 'new-scheduler' };
      setScheduler(newScheduler);

      expect(getSchedulerInstance()).toBe(newScheduler);
      expect(getSchedulerInstance().name).toBe('new-scheduler');
      expect(getSchedulerVersionState()).toBe('v1.0.0'); // Version unchanged
    });
  });

  describe('Scheduler Initialization Lifecycle', () => {
    it('tracks initialization promise and resolves correctly', async () => {
      const promise = Promise.resolve(mockScheduler);
      setSchedulerInitializationPromise(promise);

      const retrievedPromise = getSchedulerInitializationPromise();
      expect(retrievedPromise).toBe(promise);

      const result = await retrievedPromise;
      expect(result).toBe(mockScheduler);
    });

    it('handles initialization failure', async () => {
      const error = new Error('Initialization failed');
      const promise = Promise.reject(error);
      setSchedulerInitializationPromise(promise);

      const retrievedPromise = getSchedulerInitializationPromise();
      expect(retrievedPromise).toBe(promise);

      await expect(retrievedPromise).rejects.toThrow('Initialization failed');
    });

    it('clears initialization promise on state reset', () => {
      const promise = Promise.resolve(mockScheduler);
      setSchedulerInitializationPromise(promise);
      expect(getSchedulerInitializationPromise()).toBe(promise);

      clearSchedulerState();
      expect(getSchedulerInitializationPromise()).toBeNull();
    });
  });

  describe('Scheduler Restart Coordination', () => {
    it('tracks restart state to prevent concurrent restarts', () => {
      expect(isSchedulerRestartInProgress()).toBe(false);

      setSchedulerRestartInProgress(true);
      expect(isSchedulerRestartInProgress()).toBe(true);

      // Attempting to set restart again should not change state
      setSchedulerRestartInProgress(true);
      expect(isSchedulerRestartInProgress()).toBe(true);

      setSchedulerRestartInProgress(false);
      expect(isSchedulerRestartInProgress()).toBe(false);
    });

    it('resets restart state when clearing scheduler state', () => {
      setSchedulerRestartInProgress(true);
      expect(isSchedulerRestartInProgress()).toBe(true);

      clearSchedulerState();
      expect(isSchedulerRestartInProgress()).toBe(false);
    });
  });

  describe('State Cleanup Completeness', () => {
    it('clears all scheduler-related state', () => {
      // Set all scheduler state
      setScheduler(mockScheduler);
      setSchedulerVersion('v2.5.0');
      setSchedulerInitializationPromise(Promise.resolve(mockScheduler));
      setSchedulerRestartInProgress(true);

      // Verify all state is set
      expect(getSchedulerInstance()).toBe(mockScheduler);
      expect(getSchedulerVersionState()).toBe('v2.5.0');
      expect(getSchedulerInitializationPromise()).not.toBeNull();
      expect(isSchedulerRestartInProgress()).toBe(true);

      // Clear all state
      clearSchedulerState();

      // Verify all state is cleared
      expect(getSchedulerInstance()).toBeNull();
      expect(getSchedulerVersionState()).toBeNull();
      expect(getSchedulerInitializationPromise()).toBeNull();
      expect(isSchedulerRestartInProgress()).toBe(false);
    });
  });
});

describe('Health Check Cache Management', () => {
  beforeEach(() => {
    clearHealthCheckCache();
  });

  afterEach(() => {
    clearHealthCheckCache();
  });

  describe('Health Check Failure Tracking', () => {
    it('tracks failure count and calculates exponential backoff', () => {
      expect(getHealthCheckFailureCount()).toBe(0);
      expect(isHealthCheckBackoffActive()).toBe(false);

      // First failure - minimal backoff
      incrementHealthCheckFailureCount();
      expect(getHealthCheckFailureCount()).toBe(1);
      const backoff1 = getHealthCheckBackoffRemainingMs();
      expect(backoff1).toBeGreaterThan(0);
      expect(backoff1).toBeLessThanOrEqual(2000);
      expect(isHealthCheckBackoffActive()).toBe(true);

      // Second failure - increased backoff
      incrementHealthCheckFailureCount();
      expect(getHealthCheckFailureCount()).toBe(2);
      const backoff2 = getHealthCheckBackoffRemainingMs();
      expect(backoff2).toBeGreaterThan(backoff1);
    });

    it('caps backoff at maximum threshold', () => {
      // Simulate many failures
      for (let i = 0; i < 20; i++) {
        incrementHealthCheckFailureCount();
      }

      const backoff = getHealthCheckBackoffRemainingMs();
      expect(backoff).toBeLessThanOrEqual(30000); // 30 second max
    });

    it('resets failure count and backoff', () => {
      incrementHealthCheckFailureCount();
      incrementHealthCheckFailureCount();
      expect(getHealthCheckFailureCount()).toBe(2);
      expect(isHealthCheckBackoffActive()).toBe(true);

      resetHealthCheckFailureCount();

      expect(getHealthCheckFailureCount()).toBe(0);
      expect(isHealthCheckBackoffActive()).toBe(false);
      expect(getHealthCheckBackoffRemainingMs()).toBe(0);
    });
  });

  describe('Health Check Pending State', () => {
    it('tracks and clears pending health check', () => {
      const promise = Promise.resolve({ success: true } as any);
      setHealthCheckPending(promise);

      expect(getHealthCheckPending()).toBe(promise);

      setHealthCheckPending(null);
      expect(getHealthCheckPending()).toBeNull();
    });

    it('allows checking if backoff is active', async () => {
      expect(isHealthCheckBackoffActive()).toBe(false);

      incrementHealthCheckFailureCount();
      expect(isHealthCheckBackoffActive()).toBe(true);

      // Wait for backoff to expire
      await new Promise(resolve => setTimeout(resolve, 2100));
      expect(isHealthCheckBackoffActive()).toBe(false);
    });
  });

  describe('Health Check State Cleanup', () => {
    it('clears all health check state', () => {
      const promise = Promise.resolve({ success: true } as any);
      setHealthCheckPending(promise);
      incrementHealthCheckFailureCount();
      incrementHealthCheckFailureCount();

      expect(getHealthCheckPending()).not.toBeNull();
      expect(getHealthCheckFailureCount()).toBe(2);
      expect(isHealthCheckBackoffActive()).toBe(true);

      clearHealthCheckCache();

      expect(getHealthCheckPending()).toBeNull();
      expect(getHealthCheckFailureCount()).toBe(0);
      expect(isHealthCheckBackoffActive()).toBe(false);
      expect(getHealthCheckBackoffRemainingMs()).toBe(0);
    });
  });
});

describe('Internal State Management - Global Reset', () => {
  beforeEach(() => {
    resetAllInternalState();
    clearHealthCheckCache();
  });

  afterEach(() => {
    resetAllInternalState();
    clearHealthCheckCache();
  });

  describe('Comprehensive State Reset', () => {
    it('resets all scheduler and health check state simultaneously', () => {
      // Set scheduler state
      setScheduler(mockScheduler);
      setSchedulerVersion('v3.0.0');
      setSchedulerInitializationPromise(Promise.resolve(mockScheduler));
      setSchedulerRestartInProgress(true);

      // Set health check state
      setHealthCheckPending(Promise.resolve({ success: true } as any));
      incrementHealthCheckFailureCount();

      // Verify everything is set
      expect(getSchedulerInstance()).toBe(mockScheduler);
      expect(getSchedulerVersionState()).toBe('v3.0.0');
      expect(getSchedulerInitializationPromise()).not.toBeNull();
      expect(isSchedulerRestartInProgress()).toBe(true);
      expect(getHealthCheckPending()).not.toBeNull();
      expect(getHealthCheckFailureCount()).toBe(1);

      // Reset all
      resetAllInternalState();
      clearHealthCheckCache();

      // Verify everything is reset
      expect(getSchedulerInstance()).toBeNull();
      expect(getSchedulerVersionState()).toBeNull();
      expect(getSchedulerInitializationPromise()).toBeNull();
      expect(isSchedulerRestartInProgress()).toBe(false);
      expect(getHealthCheckPending()).toBeNull();
      expect(getHealthCheckFailureCount()).toBe(0);
      expect(isHealthCheckBackoffActive()).toBe(false);
    });
  });
});

describe('Internal State Management - Thread Safety (Simulated)', () => {
  beforeEach(() => {
    resetAllInternalState();
    clearHealthCheckCache();
  });

  afterEach(() => {
    resetAllInternalState();
    clearHealthCheckCache();
  });

  describe('Concurrent Scheduler Access', () => {
    it('handles concurrent scheduler state access', async () => {
      const promises: Promise<void>[] = [];

      // Simulate 10 concurrent schedulers setting state
      for (let i = 0; i < 10; i++) {
        promises.push(
          (async () => {
            const scheduler = { ...mockScheduler, name: `scheduler-${i}` };
            setScheduler(scheduler as any);
            await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
            
            // Verify we get a valid scheduler (not null)
            const retrieved = getSchedulerInstance();
            expect(retrieved).not.toBeNull();
            expect(retrieved).toHaveProperty('name');
          })()
        );
      }

      await Promise.all(promises);

      // Final state should be one of the schedulers
      const finalScheduler = getSchedulerInstance();
      expect(finalScheduler).not.toBeNull();
      expect(finalScheduler?.name).toMatch(/scheduler-\d+/);
    });

    it('handles concurrent version updates', async () => {
      const promises: Promise<void>[] = [];

      for (let i = 0; i < 10; i++) {
        promises.push(
          (async () => {
            const version = `v${i}.0.0`;
            setSchedulerVersion(version);
            await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
            
            const retrieved = getSchedulerVersionState();
            expect(typeof retrieved).toBe('string');
            expect(retrieved).toMatch(/v\d+\.\d+\.\d+/);
          })()
        );
      }

      await Promise.all(promises);
    });
  });

  describe('Concurrent Health Check Access', () => {
    it('handles concurrent health check failure tracking', async () => {
      const promises: Promise<void>[] = [];

      // Simulate 10 concurrent health check failures
      for (let i = 0; i < 10; i++) {
        promises.push(
          (async () => {
            incrementHealthCheckFailureCount();
            await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
            
            const count = getHealthCheckFailureCount();
            expect(count).toBeGreaterThan(0);
            expect(count).toBeLessThanOrEqual(10);
          })()
        );
      }

      await Promise.all(promises);

      // Final count should be all failures
      expect(getHealthCheckFailureCount()).toBe(10);
    });

    it('handles concurrent backoff checks', async () => {
      // Set some failures
      for (let i = 0; i < 3; i++) {
        incrementHealthCheckFailureCount();
      }

      const promises: Promise<boolean>[] = [];

      // Concurrent backoff checks
      for (let i = 0; i < 10; i++) {
        promises.push(
          (async () => {
            await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
            return isHealthCheckBackoffActive();
          })()
        );
      }

      const results = await Promise.all(promises);
      
      // All should agree backoff is active
      expect(results.every(r => r === true)).toBe(true);
    });
  });
});

describe('Internal State Management - State Consistency', () => {
  beforeEach(() => {
    resetAllInternalState();
    clearHealthCheckCache();
  });

  afterEach(() => {
    resetAllInternalState();
    clearHealthCheckCache();
  });

  describe('State Invariants', () => {
    it('maintains consistency between failure count and backoff', () => {
      expect(getHealthCheckFailureCount()).toBe(0);
      expect(getHealthCheckBackoffRemainingMs()).toBe(0);
      expect(isHealthCheckBackoffActive()).toBe(false);

      // After first failure
      incrementHealthCheckFailureCount();
      expect(getHealthCheckFailureCount()).toBe(1);
      const backoff1 = getHealthCheckBackoffRemainingMs();
      expect(backoff1).toBeGreaterThan(0);
      expect(isHealthCheckBackoffActive()).toBe(true);

      // Reset should bring all back to initial state
      resetHealthCheckFailureCount();
      expect(getHealthCheckFailureCount()).toBe(0);
      expect(getHealthCheckBackoffRemainingMs()).toBe(0);
      expect(isHealthCheckBackoffActive()).toBe(false);
    });

    it('ensures restart state is cleared with scheduler', () => {
      setScheduler(mockScheduler);
      setSchedulerRestartInProgress(true);

      expect(getSchedulerInstance()).toBe(mockScheduler);
      expect(isSchedulerRestartInProgress()).toBe(true);

      // Clearing scheduler should also clear restart state
      clearSchedulerState();

      expect(getSchedulerInstance()).toBeNull();
      expect(isSchedulerRestartInProgress()).toBe(false);
    });
  });
});