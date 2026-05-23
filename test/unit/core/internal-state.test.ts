/**
 * Tests for Internal State Management
 * 
 * These tests verify that the internal state management correctly replaces
 * globalThis usage while maintaining thread safety and proper cleanup.
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
  getHealthCheckPending,
  setHealthCheckPending,
  getHealthCheckFailureCount,
  incrementHealthCheckFailureCount,
  resetHealthCheckFailureCount,
  isHealthCheckBackoffActive,
  getHealthCheckBackoffRemainingMs,
  clearHealthCheckState,
  resetAllInternalState,
} from '../../../src/core/internal-state.ts';
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

  describe('Scheduler Instance Management', () => {
    it('should initialize with null scheduler', () => {
      expect(getSchedulerInstance()).toBeNull();
    });

    it('should set and get scheduler instance', () => {
      setScheduler(mockScheduler);
      expect(getSchedulerInstance()).toBe(mockScheduler);
    });

    it('should replace existing scheduler', () => {
      const mockScheduler2: IScheduler = {
        name: 'mock-scheduler-2',
        lifecycle: 'initialized' as any,
        runSearch: vi.fn(),
        runScrape: vi.fn(),
        runHealthCheck: vi.fn(),
        shutdown: vi.fn(),
      };

      setScheduler(mockScheduler);
      expect(getSchedulerInstance()).toBe(mockScheduler);

      setScheduler(mockScheduler2);
      expect(getSchedulerInstance()).toBe(mockScheduler2);
      expect(getSchedulerInstance()).not.toBe(mockScheduler);
    });

    it('should clear scheduler state', () => {
      setScheduler(mockScheduler);
      setSchedulerVersion('v1');
      setSchedulerInitializationPromise(Promise.resolve(mockScheduler));

      expect(getSchedulerInstance()).toBe(mockScheduler);
      expect(getSchedulerVersionState()).toBe('v1');
      expect(getSchedulerInitializationPromise()).not.toBeNull();

      clearSchedulerState();

      expect(getSchedulerInstance()).toBeNull();
      expect(getSchedulerVersionState()).toBeNull();
      expect(getSchedulerInitializationPromise()).toBeNull();
    });
  });

  describe('Scheduler Version Management', () => {
    it('should initialize with null version', () => {
      expect(getSchedulerVersionState()).toBeNull();
    });

    it('should set and get scheduler version', () => {
      setSchedulerVersion('v1.0.0');
      expect(getSchedulerVersionState()).toBe('v1.0.0');
    });

    it('should replace existing version', () => {
      setSchedulerVersion('v1.0.0');
      expect(getSchedulerVersionState()).toBe('v1.0.0');

      setSchedulerVersion('v2.0.0');
      expect(getSchedulerVersionState()).toBe('v2.0.0');
    });
  });

  describe('Scheduler Initialization Promise Management', () => {
    it('should initialize with null initialization promise', () => {
      expect(getSchedulerInitializationPromise()).toBeNull();
    });

    it('should set and get initialization promise', async () => {
      const promise = Promise.resolve(mockScheduler);
      setSchedulerInitializationPromise(promise);

      const retrieved = getSchedulerInitializationPromise();
      expect(retrieved).toBe(promise);

      const result = await retrieved;
      expect(result).toBe(mockScheduler);
    });

    it('should replace existing initialization promise', () => {
      const promise1 = Promise.resolve(mockScheduler);
      const promise2 = Promise.resolve(mockScheduler);

      setSchedulerInitializationPromise(promise1);
      expect(getSchedulerInitializationPromise()).toBe(promise1);

      setSchedulerInitializationPromise(promise2);
      expect(getSchedulerInitializationPromise()).toBe(promise2);
    });
  });

  describe('Restart Progress Management', () => {
    it('should initialize with restart not in progress', () => {
      expect(isSchedulerRestartInProgress()).toBe(false);
    });

    it('should set restart in progress', () => {
      setSchedulerRestartInProgress(true);
      expect(isSchedulerRestartInProgress()).toBe(true);
    });

    it('should clear restart in progress', () => {
      setSchedulerRestartInProgress(true);
      expect(isSchedulerRestartInProgress()).toBe(true);

      setSchedulerRestartInProgress(false);
      expect(isSchedulerRestartInProgress()).toBe(false);
    });
  });
});

describe('Internal State Management - Health Check', () => {
  beforeEach(() => {
    resetAllInternalState();
  });

  afterEach(() => {
    resetAllInternalState();
  });

  describe('Pending Health Check Management', () => {
    it('should initialize with null pending check', () => {
      expect(getHealthCheckPending()).toBeNull();
    });

    it('should set and get pending health check', async () => {
      const promise = Promise.resolve({
        success: true,
        searchOk: true,
        scrapeOk: true,
        timestamp: new Date().toISOString(),
      });
      setHealthCheckPending(promise);

      const retrieved = getHealthCheckPending();
      expect(retrieved).toBe(promise);

      const result = await retrieved;
      expect(result.success).toBe(true);
    });

    it('should replace existing pending check', () => {
      const promise1 = Promise.resolve({ success: true } as any);
      const promise2 = Promise.resolve({ success: false } as any);

      setHealthCheckPending(promise1);
      expect(getHealthCheckPending()).toBe(promise1);

      setHealthCheckPending(promise2);
      expect(getHealthCheckPending()).toBe(promise2);
    });
  });

  describe('Health Check Failure Count', () => {
    it('should initialize with zero failure count', () => {
      expect(getHealthCheckFailureCount()).toBe(0);
    });

    it('should increment failure count', () => {
      expect(getHealthCheckFailureCount()).toBe(0);

      const count = incrementHealthCheckFailureCount();
      expect(count).toBe(1);
      expect(getHealthCheckFailureCount()).toBe(1);

      const count2 = incrementHealthCheckFailureCount();
      expect(count2).toBe(2);
      expect(getHealthCheckFailureCount()).toBe(2);
    });

    it('should reset failure count', () => {
      incrementHealthCheckFailureCount();
      incrementHealthCheckFailureCount();
      expect(getHealthCheckFailureCount()).toBe(2);

      resetHealthCheckFailureCount();
      expect(getHealthCheckFailureCount()).toBe(0);
    });

    it('should reset backoff when failure count is reset', () => {
      incrementHealthCheckFailureCount();
      expect(isHealthCheckBackoffActive()).toBe(true);

      resetHealthCheckFailureCount();
      expect(isHealthCheckBackoffActive()).toBe(false);
    });
  });

  describe('Health Check Backoff Management', () => {
    it('should not be active initially', () => {
      expect(isHealthCheckBackoffActive()).toBe(false);
      expect(getHealthCheckBackoffRemainingMs()).toBe(0);
    });

    it('should set backoff on failure', () => {
      incrementHealthCheckFailureCount();
      expect(isHealthCheckBackoffActive()).toBe(true);
      expect(getHealthCheckBackoffRemainingMs()).toBeGreaterThan(0);
    });

    it('should decrease backoff over time', async () => {
      incrementHealthCheckFailureCount();
      const initialRemaining = getHealthCheckBackoffRemainingMs();
      expect(initialRemaining).toBeGreaterThan(0);

      // Wait 500ms
      await new Promise(resolve => setTimeout(resolve, 500));

      const remainingAfterWait = getHealthCheckBackoffRemainingMs();
      expect(remainingAfterWait).toBeLessThan(initialRemaining);
    });

    it('should have exponential backoff', () => {
      resetHealthCheckFailureCount();

      incrementHealthCheckFailureCount();
      const backoff1 = getHealthCheckBackoffRemainingMs();
      expect(backoff1).toBeGreaterThanOrEqual(1999); // 2^0 * 2000 = 2000ms (allow 1ms timing variance)

      incrementHealthCheckFailureCount();
      const backoff2 = getHealthCheckBackoffRemainingMs();
      expect(backoff2).toBeGreaterThanOrEqual(3999); // 2^1 * 2000 = 4000ms

      incrementHealthCheckFailureCount();
      const backoff3 = getHealthCheckBackoffRemainingMs();
      expect(backoff3).toBeGreaterThanOrEqual(7999); // 2^2 * 2000 = 8000ms

      incrementHealthCheckFailureCount();
      const backoff4 = getHealthCheckBackoffRemainingMs();
      expect(backoff4).toBeGreaterThanOrEqual(15999); // 2^3 * 2000 = 16000ms

      incrementHealthCheckFailureCount();
      const backoff5 = getHealthCheckBackoffRemainingMs();
      expect(backoff5).toBeGreaterThanOrEqual(29999); // 2^4 * 2000 = 32000ms, capped at 30000ms

      incrementHealthCheckFailureCount();
      const backoff6 = getHealthCheckBackoffRemainingMs();
      expect(backoff6).toBeGreaterThanOrEqual(29999); // Still capped at 30000ms
    });

    it('should clear backoff when state is cleared', () => {
      incrementHealthCheckFailureCount();
      expect(isHealthCheckBackoffActive()).toBe(true);

      clearHealthCheckState();
      expect(isHealthCheckBackoffActive()).toBe(false);
      expect(getHealthCheckBackoffRemainingMs()).toBe(0);
    });
  });

  describe('Health Check State Management', () => {
    it('should clear all health check state', () => {
      const promise = Promise.resolve({ success: true } as any);
      setHealthCheckPending(promise);
      incrementHealthCheckFailureCount();
      incrementHealthCheckFailureCount();

      expect(getHealthCheckPending()).not.toBeNull();
      expect(getHealthCheckFailureCount()).toBe(2);
      expect(isHealthCheckBackoffActive()).toBe(true);

      clearHealthCheckState();

      expect(getHealthCheckPending()).toBeNull();
      expect(getHealthCheckFailureCount()).toBe(0);
      expect(isHealthCheckBackoffActive()).toBe(false);
    });
  });
});

describe('Internal State Management - Global Reset', () => {
  beforeEach(() => {
    resetAllInternalState();
  });

  afterEach(() => {
    resetAllInternalState();
  });

  it('should reset all scheduler state', () => {
    setScheduler(mockScheduler);
    setSchedulerVersion('v1.0.0');
    setSchedulerInitializationPromise(Promise.resolve(mockScheduler));
    setSchedulerRestartInProgress(true);

    expect(getSchedulerInstance()).toBe(mockScheduler);
    expect(getSchedulerVersionState()).toBe('v1.0.0');
    expect(getSchedulerInitializationPromise()).not.toBeNull();
    expect(isSchedulerRestartInProgress()).toBe(true);

    resetAllInternalState();

    expect(getSchedulerInstance()).toBeNull();
    expect(getSchedulerVersionState()).toBeNull();
    expect(getSchedulerInitializationPromise()).toBeNull();
    expect(isSchedulerRestartInProgress()).toBe(false);
  });

  it('should reset all health check state', () => {
    setHealthCheckPending(Promise.resolve({ success: true } as any));
    incrementHealthCheckFailureCount();
    incrementHealthCheckFailureCount();

    expect(getHealthCheckPending()).not.toBeNull();
    expect(getHealthCheckFailureCount()).toBe(2);
    expect(isHealthCheckBackoffActive()).toBe(true);

    resetAllInternalState();

    expect(getHealthCheckPending()).toBeNull();
    expect(getHealthCheckFailureCount()).toBe(0);
    expect(isHealthCheckBackoffActive()).toBe(false);
  });

  it('should reset all state simultaneously', () => {
    // Set scheduler state
    setScheduler(mockScheduler);
    setSchedulerVersion('v1.0.0');
    setSchedulerInitializationPromise(Promise.resolve(mockScheduler));
    setSchedulerRestartInProgress(true);

    // Set health check state
    setHealthCheckPending(Promise.resolve({ success: true } as any));
    incrementHealthCheckFailureCount();

    // Verify everything is set
    expect(getSchedulerInstance()).toBe(mockScheduler);
    expect(getHealthCheckFailureCount()).toBe(1);

    // Reset all
    resetAllInternalState();

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

describe('Internal State Management - Thread Safety (Simulated)', () => {
  beforeEach(() => {
    resetAllInternalState();
  });

  afterEach(() => {
    resetAllInternalState();
  });

  it('should handle concurrent scheduler access', async () => {
    const promises: Promise<void>[] = [];

    // Simulate 10 concurrent schedulers setting state
    for (let i = 0; i < 10; i++) {
      promises.push(
        (async () => {
          setScheduler({ ...mockScheduler, name: `scheduler-${i}` } as any);
          await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
          expect(getSchedulerInstance()).not.toBeNull();
        })()
      );
    }

    await Promise.all(promises);
  });

  it('should handle concurrent health check access', async () => {
    const promises: Promise<void>[] = [];

    // Simulate 10 concurrent health check operations
    for (let i = 0; i < 10; i++) {
      promises.push(
        (async () => {
          incrementHealthCheckFailureCount();
          await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
          expect(getHealthCheckFailureCount()).toBeGreaterThan(0);
        })()
      );
    }

    await Promise.all(promises);
  });
});