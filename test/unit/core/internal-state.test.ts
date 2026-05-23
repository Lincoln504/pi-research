/**
 * Tests for Internal State Management
 *
 * These tests verify that the internal state management correctly replaces
 * globalThis usage while maintaining thread safety and proper cleanup.
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

  describe('Scheduler Instance Management', () => {

    it('should get null when no scheduler is set', () => {
      expect(getSchedulerInstance()).toBeNull();
    });

    it('should set and get scheduler instance', () => {
      setScheduler(mockScheduler);
      expect(getSchedulerInstance()).toBe(mockScheduler);
    });

    it('should replace existing scheduler', () => {
      const mockScheduler2 = { ...mockScheduler, name: 'mock-scheduler-2' };
      setScheduler(mockScheduler);
      setScheduler(mockScheduler2);
      expect(getSchedulerInstance()).toBe(mockScheduler2);
    });

    it('should clear scheduler state', () => {
      setScheduler(mockScheduler);
      expect(getSchedulerInstance()).toBe(mockScheduler);

      clearSchedulerState();
      expect(getSchedulerInstance()).toBeNull();
    });
  });

  describe('Scheduler Version Management', () => {

    it('should get null when no version is set', () => {
      expect(getSchedulerVersionState()).toBeNull();
    });

    it('should set and get scheduler version', () => {
      setSchedulerVersion('v1.0.0');
      expect(getSchedulerVersionState()).toBe('v1.0.0');
    });

    it('should update scheduler version', () => {
      setSchedulerVersion('v1.0.0');
      setSchedulerVersion('v2.0.0');
      expect(getSchedulerVersionState()).toBe('v2.0.0');
    });

    it('should clear version when scheduler state is cleared', () => {
      setSchedulerVersion('v1.0.0');
      clearSchedulerState();
      expect(getSchedulerVersionState()).toBeNull();
    });
  });

  describe('Scheduler Initialization Promise Management', () => {

    it('should get null when no initialization promise is set', () => {
      expect(getSchedulerInitializationPromise()).toBeNull();
    });

    it('should set and get initialization promise', async () => {
      const promise = Promise.resolve(mockScheduler);
      setSchedulerInitializationPromise(promise);
      expect(getSchedulerInitializationPromise()).toBe(promise);

      const result = await promise;
      expect(result).toBe(mockScheduler);
    });

    it('should clear initialization promise when scheduler state is cleared', () => {
      const promise = Promise.resolve(mockScheduler);
      setSchedulerInitializationPromise(promise);
      clearSchedulerState();
      expect(getSchedulerInitializationPromise()).toBeNull();
    });
  });

  describe('Scheduler Restart State Management', () => {

    it('should return false when restart is not in progress', () => {
      expect(isSchedulerRestartInProgress()).toBe(false);
    });

    it('should set and check restart in progress state', () => {
      setSchedulerRestartInProgress(true);
      expect(isSchedulerRestartInProgress()).toBe(true);

      setSchedulerRestartInProgress(false);
      expect(isSchedulerRestartInProgress()).toBe(false);
    });

    it('should clear restart state when scheduler state is cleared', () => {
      setSchedulerRestartInProgress(true);
      clearSchedulerState();
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

  it('should track pending health check', () => {
    const promise = Promise.resolve({ success: true } as any);
    setHealthCheckPending(promise);

    expect(getHealthCheckPending()).not.toBeNull();
    expect(getHealthCheckPending()).toBe(promise);
  });

  it('should clear pending health check', () => {
    const promise = Promise.resolve({ success: true } as any);
    setHealthCheckPending(promise);
    expect(getHealthCheckPending()).not.toBeNull();

    setHealthCheckPending(null);
    expect(getHealthCheckPending()).toBeNull();
  });

  it('should track health check failure count', () => {
    expect(getHealthCheckFailureCount()).toBe(0);

    incrementHealthCheckFailureCount();
    expect(getHealthCheckFailureCount()).toBe(1);

    incrementHealthCheckFailureCount();
    expect(getHealthCheckFailureCount()).toBe(2);
  });

  it('should reset health check failure count', () => {
    incrementHealthCheckFailureCount();
    incrementHealthCheckFailureCount();
    expect(getHealthCheckFailureCount()).toBe(2);

    resetHealthCheckFailureCount();
    expect(getHealthCheckFailureCount()).toBe(0);
  });

  it('should calculate exponential backoff', () => {
    incrementHealthCheckFailureCount();
    const backoff1 = getHealthCheckBackoffRemainingMs();
    expect(backoff1).toBeGreaterThan(0);
    expect(backoff1).toBeLessThanOrEqual(2000);

    incrementHealthCheckFailureCount();
    const backoff2 = getHealthCheckBackoffRemainingMs();
    expect(backoff2).toBeGreaterThan(backoff1);

    // After many failures, backoff should cap at 30s
    for (let i = 0; i < 10; i++) {
      incrementHealthCheckFailureCount();
    }
    const backoffMax = getHealthCheckBackoffRemainingMs();
    expect(backoffMax).toBeLessThanOrEqual(30000);
  });

  it('should check if backoff is active', async () => {
    expect(isHealthCheckBackoffActive()).toBe(false);

    incrementHealthCheckFailureCount();
    expect(isHealthCheckBackoffActive()).toBe(true);

    // Wait for backoff to expire
    await new Promise(resolve => setTimeout(resolve, 2100));
    expect(isHealthCheckBackoffActive()).toBe(false);
  });

  it('should clear all health check state', () => {
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
    clearHealthCheckCache();

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

describe('Internal State Management - Thread Safety (Simulated)', () => {
  beforeEach(() => {
    resetAllInternalState();
    clearHealthCheckCache();
  });

  afterEach(() => {
    resetAllInternalState();
    clearHealthCheckCache();
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