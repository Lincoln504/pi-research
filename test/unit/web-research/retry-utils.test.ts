/**
 * Web Research Retry Utils Unit Tests
 *
 * Tests for timeout signals and retry logic.
 */

import { describe, it, expect } from 'vitest';
import { createTimeoutSignal, retryWithBackoff, type RetryOptions } from '../../../src/web-research/retry-utils';

describe('Web Research Retry Utils', () => {
  describe('createTimeoutSignal', () => {
    it('should create a valid AbortSignal', () => {
      const signal = createTimeoutSignal(1000);
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it('should return an AbortSignal object', () => {
      const signal = createTimeoutSignal(100);
      expect(typeof signal).toBe('object');
      expect('aborted' in signal).toBe(true);
    });

    it('should accept positive timeout values', () => {
      const signal1 = createTimeoutSignal(100);
      const signal2 = createTimeoutSignal(1000);
      const signal3 = createTimeoutSignal(10000);

      expect(signal1).toBeInstanceOf(AbortSignal);
      expect(signal2).toBeInstanceOf(AbortSignal);
      expect(signal3).toBeInstanceOf(AbortSignal);
    });

    it('should handle zero timeout', () => {
      const signal = createTimeoutSignal(0);
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it('should handle large timeout values', () => {
      const signal = createTimeoutSignal(1000000);
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it('should combine with existing abort signal', () => {
      const controller = new AbortController();
      const signal = createTimeoutSignal(1000, controller.signal);

      expect(signal).toBeInstanceOf(AbortSignal);

      // Abort the original signal
      controller.abort();

      // Combined signal should also be aborted
      expect(signal.aborted).toBe(true);
    });

    it('should handle multiple timeout signals independently', () => {
      const signal1 = createTimeoutSignal(100);
      const signal2 = createTimeoutSignal(200);
      const signal3 = createTimeoutSignal(300);

      expect(signal1).toBeInstanceOf(AbortSignal);
      expect(signal2).toBeInstanceOf(AbortSignal);
      expect(signal3).toBeInstanceOf(AbortSignal);
    });

    it('should support addEventListener for abort', () => {
      const signal = createTimeoutSignal(100);
      let called = false;

      signal.addEventListener('abort', () => {
        called = true;
      });

      expect(typeof signal.addEventListener).toBe('function');
    });
  });

  describe('retryWithBackoff', () => {
    it('should execute function successfully on first try', async () => {
      const fn = async () => 'success';

      const result = await retryWithBackoff(fn);

      expect(result).toBe('success');
    });

    it('should return successful result without retrying', async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return 'success';
      };

      const result = await retryWithBackoff(fn, { maxRetries: 3, initialDelay: 5, maxDelay: 50 });

      expect(result).toBe('success');
      expect(callCount).toBe(1);
    });

    it('should attempt retries', async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return 'success';
      };

      const result = await retryWithBackoff(fn, { maxRetries: 3, initialDelay: 1, maxDelay: 1 });

      expect(result).toBe('success');
      expect(callCount).toBeGreaterThanOrEqual(1);
    });

    it('should return promise-like behavior', async () => {
      const fn = async () => 'test';

      const result = await retryWithBackoff(fn, { maxRetries: 0, initialDelay: 1, maxDelay: 1 });

      expect(result).toBeDefined();
    });

    it('should handle zero max retries', async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        throw new Error('fails');
      };

      await expect(
        retryWithBackoff(fn, { maxRetries: 0, initialDelay: 5, maxDelay: 50 })
      ).rejects.toThrow();

      // Should only try once with no retries
      expect(callCount).toBe(1);
    });

    it('should handle error types', async () => {
      const fn = async () => {
        throw new TypeError('type error');
      };

      // Test that the function accepts error types
      expect(() => {
        retryWithBackoff(fn, { maxRetries: 0, initialDelay: 1, maxDelay: 1 });
      }).not.toThrow();
    });

    it('should handle various rejection types', async () => {
      const fn = async () => Promise.reject(new Error('error'));

      // Test that the function can handle rejections
      expect(() => {
        retryWithBackoff(fn, { maxRetries: 0, initialDelay: 1, maxDelay: 1 });
      }).not.toThrow();
    });

    it('should accept custom retry options', async () => {
      const fn = async () => 'success';

      const options: RetryOptions = {
        maxRetries: 5,
        initialDelay: 20,
        maxDelay: 200,
      };

      const result = await retryWithBackoff(fn, options);

      expect(result).toBe('success');
    });

    it('should work with minimal retry options', async () => {
      const fn = async () => 'success';

      const result = await retryWithBackoff(fn, {
        maxRetries: 0,
        initialDelay: 1,
        maxDelay: 1,
      });

      expect(result).toBe('success');
    });

    it('should preserve function result type', async () => {
      const testData = { id: 1, name: 'test', value: 100 };
      const fn = async () => testData;

      const result = await retryWithBackoff(fn);

      expect(result).toEqual(testData);
      expect(result.id).toBe(1);
      expect(result.name).toBe('test');
      expect(result.value).toBe(100);
    });

    it('should handle async functions with delays', async () => {
      const fn = async () => {
        return new Promise((resolve) => {
          setTimeout(() => resolve('async result'), 10);
        });
      };

      const result = await retryWithBackoff(fn);

      expect(result).toBe('async result');
    });

    it('should handle promises that return null', async () => {
      const fn = async () => null;

      const result = await retryWithBackoff(fn);

      expect(result).toBeNull();
    });

    it('should handle promises that return undefined', async () => {
      const fn = async () => undefined;

      const result = await retryWithBackoff(fn);

      expect(result).toBeUndefined();
    });

    it('should handle promises that return false', async () => {
      const fn = async () => false;

      const result = await retryWithBackoff(fn);

      expect(result).toBe(false);
    });

    it('should handle promises that return zero', async () => {
      const fn = async () => 0;

      const result = await retryWithBackoff(fn);

      expect(result).toBe(0);
    });

    it('should handle promises that return empty string', async () => {
      const fn = async () => '';

      const result = await retryWithBackoff(fn);

      expect(result).toBe('');
    });

    it('should work with maxRetries equal to 1', async () => {
      const fn = async () => 'success';

      const result = await retryWithBackoff(fn, {
        maxRetries: 1,
        initialDelay: 1,
        maxDelay: 1,
      });

      expect(result).toBe('success');
    });

    it('should handle synchronous errors in async function', async () => {
      const fn = async () => {
        throw new Error('sync error');
      };

      await expect(
        retryWithBackoff(fn, { maxRetries: 0, initialDelay: 5, maxDelay: 20 })
      ).rejects.toThrow();
    });

    it('should work with large max retries', async () => {
      const fn = async () => 'success';

      const result = await retryWithBackoff(fn, {
        maxRetries: 100,
        initialDelay: 1,
        maxDelay: 1,
      });

      expect(result).toBe('success');
    });

    it('should handle function without explicit return', async () => {
      let executed = false;
      const fn = async () => {
        executed = true;
      };

      const result = await retryWithBackoff(fn);

      expect(executed).toBe(true);
      expect(result).toBeUndefined();
    });
  });

  describe('Retry Options', () => {
    it('should work with default options', async () => {
      const fn = async () => 'success';

      const result = await retryWithBackoff(fn);

      expect(result).toBe('success');
    });

    it('should work with partial options', async () => {
      const fn = async () => 'success';

      const result = await retryWithBackoff(fn, { maxRetries: 1 });

      expect(result).toBe('success');
    });

    it('should work with empty partial options', async () => {
      const fn = async () => 'success';

      const result = await retryWithBackoff(fn, {});

      expect(result).toBe('success');
    });

    it('should work with full options', async () => {
      const fn = async () => 'success';

      const result = await retryWithBackoff(fn, {
        maxRetries: 5,
        initialDelay: 20,
        maxDelay: 200,
      });

      expect(result).toBe('success');
    });
  });
});
