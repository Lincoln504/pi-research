/**
 * Chaos Engineering Tests: Retry Utils
 *
 * Tests chaotic scenarios for retry utilities including:
 * - Network failure injection with various error types
 * - Jittered retry under high contention
 * - Mixed transient and non-transient errors
 * - Timeout chaos
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  retryWithBackoff,
  isTransientError,
  withTimeout,
  createTimeoutSignal,
} from '../../../src/web-research/retry-utils.ts';
import {
  simulateNetworkTimeout,
  simulateConnectionReset,
  simulateConnectionRefused,
  simulateRateLimitError,
  withRandomError,
  withNetworkChaos,
  executeBurst,
  measureTime,
  type NetworkChaosOptions,
} from '../../utils/chaos-helpers.ts';

describe('Retry Utils Chaos Tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Network Failure Injection', () => {
    it('should retry on various network timeouts', async () => {
      let attempts = 0;
      
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts <= 2) {
          throw simulateNetworkTimeout('https://api.example.com/data');
        }
        return { data: 'success' };
      });

      const result = await retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelay: 100,
        maxDelay: 1000,
      });

      expect(result).toEqual({ data: 'success' });
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should handle connection reset errors', async () => {
      let attempts = 0;
      
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          throw simulateConnectionReset();
        }
        return { data: 'recovered' };
      });

      const result = await retryWithBackoff(fn, {
        maxRetries: 2,
        initialDelay: 50,
      });

      expect(result).toEqual({ data: 'recovered' });
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should handle connection refused errors', async () => {
      let attempts = 0;
      
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts <= 3) {
          throw simulateConnectionRefused();
        }
        return { connected: true };
      });

      const result = await retryWithBackoff(fn, {
        maxRetries: 5,
        initialDelay: 100,
      });

      expect(result).toEqual({ connected: true });
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it('should handle rate limit errors with proper backoff', async () => {
      let attempts = 0;
      const retryAfterDelays: number[] = [];
      
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts <= 2) {
          const error = simulateRateLimitError(5);
          retryAfterDelays.push(attempts);
          throw error;
        }
        return { data: 'after-rate-limit' };
      });

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 10000,
        label: 'rate-limit-test',
      });

      // Advance timers for retries
      await vi.advanceTimersByTimeAsync(1200); // First retry
      await vi.advanceTimersByTimeAsync(2200); // Second retry with exponential backoff

      const result = await promise;
      expect(result).toEqual({ data: 'after-rate-limit' });
      expect(fn).toHaveBeenCalledTimes(3);
      expect(retryAfterDelays).toEqual([1, 2]);
    });

    it('should not retry on non-transient errors', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('HTTP 404: Not Found'));

      await expect(retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelay: 100,
      })).rejects.toThrow('404');

      expect(fn).toHaveBeenCalledTimes(1); // No retries
    });

    it('should exhaust retries on persistent network errors', async () => {
      const fn = vi.fn().mockRejectedValue(simulateNetworkTimeout());
      
      const promise = retryWithBackoff(fn, {
        maxRetries: 2,
        initialDelay: 50,
      });

      // Advance through all retries
      promise.catch(() => {}); // Suppress unhandled rejection
      await vi.advanceTimersByTimeAsync(75);
      await vi.advanceTimersByTimeAsync(125);

      await expect(promise).rejects.toThrow('network timeout');
      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });
  });

  describe('Mixed Error Patterns', () => {
    it('should handle alternating transient and non-transient errors', async () => {
      let attempts = 0;
      
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        switch (attempts) {
          case 1:
            throw simulateNetworkTimeout();
          case 2:
            throw new Error('HTTP 400: Bad Request'); // Non-transient
          case 3:
            throw simulateConnectionReset();
          default:
            return { success: true };
        }
      });

      // Should fail on non-transient error at attempt 2
      await expect(retryWithBackoff(fn, {
        maxRetries: 5,
        initialDelay: 50,
      })).rejects.toThrow('400');

      expect(attempts).toBe(2);
    });

    it('should succeed after mixed transient errors', async () => {
      const errorSequence = [
        simulateNetworkTimeout(),
        simulateConnectionReset(),
        simulateRateLimitError(),
      ];
      let attempts = 0;
      
      const fn = vi.fn().mockImplementation(async () => {
        if (attempts < errorSequence.length) {
          throw errorSequence[attempts++];
        }
        return { success: true };
      });

      const promise = retryWithBackoff(fn, {
        maxRetries: 5,
        initialDelay: 50,
      });

      // Advance timers for each retry
      await vi.advanceTimersByTimeAsync(75);
      await vi.advanceTimersByTimeAsync(125);
      await vi.advanceTimersByTimeAsync(225);

      const result = await promise;
      expect(result).toEqual({ success: true });
      expect(fn).toHaveBeenCalledTimes(4); // 3 errors + 1 success
    });

    it('should handle custom transient error detection', async () => {
      let attempts = 0;
      
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts <= 2) {
          throw new Error('Custom transient error: TEMP_FAILURE');
        }
        return { success: true };
      });

      const isCustomTransient = (error: unknown) => {
        return error instanceof Error && 
               error.message.includes('TEMP_FAILURE');
      };

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelay: 50,
        isTransientError: isCustomTransient,
      });

      await vi.advanceTimersByTimeAsync(75);
      await vi.advanceTimersByTimeAsync(125);

      const result = await promise;
      expect(result).toEqual({ success: true });
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('Randomized Failure Patterns', () => {
    it('should handle random transient errors', async () => {
      let successCount = 0;
      let failureCount = 0;
      
      const fn = vi.fn().mockImplementation(async () => {
        // 60% chance of success
        if (Math.random() < 0.6) {
          successCount++;
          return { success: true };
        }
        failureCount++;
        throw simulateNetworkTimeout();
      });

      const promise = retryWithBackoff(fn, {
        maxRetries: 10,
        initialDelay: 10,
      });

      // Advance timers rapidly to get through retries
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(15);
      }

      // Eventually should succeed
      const result = await promise;
      expect(result).toEqual({ success: true });
    });

    it('should use chaos helper for random error injection', async () => {
      const baseFn = vi.fn().mockResolvedValue({ data: 'success' });
      const chaoticFn = withRandomError(baseFn, {
        errorProbability: 0.7, // 70% chance of error
        error: simulateConnectionReset(),
        seed: 12345, // Deterministic
      });

      // With this seed and probability, should fail a few times then succeed
      let lastError: Error | null = null;
      let attempts = 0;

      const result = await retryWithBackoff(async () => {
        attempts++;
        try {
          return await chaoticFn();
        } catch (e) {
          lastError = e as Error;
          throw e;
        }
      }, {
        maxRetries: 10,
        initialDelay: 10,
      });

      expect(result).toEqual({ data: 'success' });
      expect(attempts).toBeGreaterThan(1);
    });

    it('should respect onAttempts filter in error injection', async () => {
      const baseFn = vi.fn().mockResolvedValue({ data: 'success' });
      
      const chaoticFn = withRandomError(baseFn, {
        errorProbability: 1.0,
        error: simulateNetworkTimeout(),
        onAttempts: [1, 3, 5], // Fail only on attempts 1, 3, 5
      });

      const promise = retryWithBackoff(chaoticFn, {
        maxRetries: 6,
        initialDelay: 10,
      });

      // Advance through retries
      for (let i = 0; i < 7; i++) {
        await vi.advanceTimersByTimeAsync(15);
      }

      const result = await promise;
      expect(result).toEqual({ data: 'success' });
    });
  });

  describe('Network Chaos Scenarios', () => {
    it('should handle network chaos with various failure types', async () => {
      const baseFn = vi.fn().mockResolvedValue({ data: 'success' });
      const options: NetworkChaosOptions = {
        failureProbability: 0.5,
        failureTypes: ['timeout', 'reset', 'refused', 'dns'],
        addedLatency: { min: 10, max: 50 },
        seed: 42,
      };

      const chaoticFn = withNetworkChaos(baseFn, options);

      const promise = retryWithBackoff(chaoticFn, {
        maxRetries: 10,
        initialDelay: 20,
      });

      // Advance through potential retries
      for (let i = 0; i < 15; i++) {
        await vi.advanceTimersByTimeAsync(30);
      }

      const result = await promise;
      expect(result).toEqual({ data: 'success' });
    });

    it('should handle only timeout failures', async () => {
      const baseFn = vi.fn().mockResolvedValue({ data: 'success' });
      const options: NetworkChaosOptions = {
        failureProbability: 0.6,
        failureTypes: ['timeout'],
        seed: 999,
      };

      const chaoticFn = withNetworkChaos(baseFn, options);

      const promise = retryWithBackoff(chaoticFn, {
        maxRetries: 5,
        initialDelay: 10,
      });

      // Advance through retries
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(15);
      }

      const result = await promise;
      expect(result).toEqual({ data: 'success' });
    });

    it('should handle added latency with chaos', async () => {
      const baseFn = vi.fn().mockImplementation(async () => {
        // Track actual execution time
        const start = Date.now();
        await new Promise(resolve => setTimeout(resolve, 5));
        return { 
          data: 'success',
          execTime: Date.now() - start,
        };
      });

      const options: NetworkChaosOptions = {
        failureProbability: 0.2, // Low failure rate
        failureTypes: ['timeout'],
        addedLatency: { min: 100, max: 200 },
        seed: 777,
      };

      const chaoticFn = withNetworkChaos(baseFn, options);

      const promise = retryWithBackoff(chaoticFn, {
        maxRetries: 3,
        initialDelay: 10,
      });

      // Advance through retries
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(50);
      }

      const result = await promise;
      expect(result.data).toBe('success');
    });
  });

  describe('Timeout Chaos', () => {
    it('should timeout correctly under fake timers', async () => {
      const slowFn = async () => {
        await new Promise(resolve => setTimeout(resolve, 5000));
        return { data: 'too slow' };
      };

      const promise = withTimeout(slowFn(), 100, 'test operation');
      
      // Advance past timeout
      await vi.advanceTimersByTimeAsync(101);

      await expect(promise).rejects.toThrow('test operation cancelled or timed out');
    });

    it('should handle timeout with external abort signal', async () => {
      const controller = new AbortController();
      const slowFn = async () => {
        await new Promise(resolve => setTimeout(resolve, 5000));
        return { data: 'result' };
      };

      const promise = withTimeout(slowFn(), 1000, 'test', controller.signal);

      // Abort externally before timeout
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();

      await expect(promise).rejects.toThrow('test operation cancelled or timed out');
    });

    it('should complete successfully before timeout', async () => {
      const fn = async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return { data: 'timely' };
      };

      const promise = withTimeout(fn(), 100, 'test');

      await vi.advanceTimersByTimeAsync(51);

      const result = await promise;
      expect(result).toEqual({ data: 'timely' });
    });

    it('should handle multiple concurrent timeouts', async () => {
      const operations = [
        withTimeout(Promise.resolve({ id: 1 }), 100, 'op1'),
        withTimeout(Promise.resolve({ id: 2 }), 100, 'op2'),
        withTimeout(
          new Promise(resolve => setTimeout(() => resolve({ id: 3 }), 200)),
          100,
          'op3'
        ),
        withTimeout(Promise.resolve({ id: 4 }), 100, 'op4'),
      ];

      const promise = Promise.allSettled(operations);
      
      // Advance past first timeout
      await vi.advanceTimersByTimeAsync(101);

      const results = await promise;

      // op3 should timeout, others succeed
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('fulfilled');
      expect(results[2].status).toBe('rejected');
      expect(results[3].status).toBe('fulfilled');
    });
  });

  describe('High Contention Scenarios', () => {
    it('should handle concurrent operations with mixed outcomes', async () => {
      let counter = 0;
      
      const fn = vi.fn().mockImplementation(async () => {
        counter++;
        // Fail first few, then succeed
        if (counter <= 3) {
          throw simulateNetworkTimeout();
        }
        return { success: true, id: counter };
      });

      const operations = Array.from({ length: 10 }, (_, i) =>
        retryWithBackoff(fn, {
          maxRetries: 3,
          initialDelay: 10,
          label: `op-${i}`,
        })
      );

      const promise = Promise.allSettled(operations);

      // Advance timers for all potential retries
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(15);
      }

      const results = await promise;

      // Most should succeed
      const successes = results.filter(r => r.status === 'fulfilled');
      expect(successes.length).toBeGreaterThan(5);
    });

    it('should handle burst operations efficiently', async () => {
      let callCount = 0;
      
      const fn = vi.fn().mockImplementation(async () => {
        callCount++;
        // Intermittent failures
        if (callCount % 3 === 0) {
          throw simulateConnectionReset();
        }
        return { success: true, call: callCount };
      });

      const operations = Array.from({ length: 15 }, () => 
        () => retryWithBackoff(fn, {
          maxRetries: 2,
          initialDelay: 10,
        })
      );

      const promise = executeBurst(operations, 5);

      // Advance timers
      for (let i = 0; i < 25; i++) {
        await vi.advanceTimersByTimeAsync(15);
      }

      const results = await promise;
      expect(results.length).toBe(15);
    });

    it('should maintain performance under load', async () => {
      const fn = vi.fn().mockResolvedValue({ data: 'success' });

      const operations = Array.from({ length: 20 }, (_, i) =>
        measureTime(() => retryWithBackoff(fn, {
          maxRetries: 1,
          initialDelay: 5,
          label: `perf-${i}`,
        }))
      );

      // Execute concurrently
      const promise = Promise.all(operations);

      // Advance timers
      await vi.advanceTimersByTimeAsync(100);

      const results = await promise;

      // All should complete quickly
      results.forEach(({ durationMs }) => {
        expect(durationMs).toBeLessThan(50);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero maxRetries', async () => {
      const fn = vi.fn().mockRejectedValue(simulateNetworkTimeout());

      await expect(retryWithBackoff(fn, {
        maxRetries: 0,
        initialDelay: 10,
      })).rejects.toThrow();

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should handle very small delays', async () => {
      let attempts = 0;
      
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts <= 2) {
          throw simulateConnectionReset();
        }
        return { success: true };
      });

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelay: 1,
        maxDelay: 5,
      });

      // Should complete quickly with tiny delays
      await vi.advanceTimersByTimeAsync(10);

      const result = await promise;
      expect(result).toEqual({ success: true });
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should handle very large delays', async () => {
      let attempts = 0;
      
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts <= 1) {
          throw simulateNetworkTimeout();
        }
        return { success: true };
      });

      const promise = retryWithBackoff(fn, {
        maxRetries: 1,
        initialDelay: 100000,
        maxDelay: 200000,
      });

      // Should wait for the configured delay
      const start = Date.now();
      await vi.advanceTimersByTimeAsync(100001);
      const result = await promise;
      const elapsed = Date.now() - start;

      expect(result).toEqual({ success: true });
      expect(elapsed).toBeGreaterThanOrEqual(100000);
    });

    it('should handle function that returns non-promise', async () => {
      const fn = vi.fn().mockReturnValue({ data: 'sync result' });

      const result = await retryWithBackoff(fn, {
        maxRetries: 2,
        initialDelay: 10,
      });

      expect(result).toEqual({ data: 'sync result' });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should handle null/undefined errors', async () => {
      const fn = vi.fn().mockRejectedValue(null);

      await expect(retryWithBackoff(fn, {
        maxRetries: 2,
        initialDelay: 10,
      })).rejects.toThrow();

      // Should not retry on null
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});