import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retryWithBackoff, createTimeoutSignal, withTimeout, isTransientError } from '../../../src/web-research/retry-utils.ts';

vi.mock('../../../src/logger.ts');

describe('retry-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('retryWithBackoff', () => {
    it('should return result on first success', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await retryWithBackoff(fn);
      
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on 429 error (using fake timers)', async () => {
      vi.useFakeTimers();
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('HTTP 429: Too Many Requests'))
        .mockResolvedValueOnce('success');
        
      const promise = retryWithBackoff(fn, { initialDelay: 100 });
      
      // Move past the first failure and wait for the retry
      await vi.advanceTimersByTimeAsync(200); 
      
      const result = await promise;
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('should NOT retry on 404 error', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('HTTP 404: Not Found'));
      
      await expect(retryWithBackoff(fn)).rejects.toThrow('HTTP 404');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should exhaust retries and throw last error (using real timers with short delays)', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('HTTP 429'));
      
      // Using very short delays to keep tests fast without fake timer headaches
      const start = Date.now();
      await expect(retryWithBackoff(fn, { maxRetries: 2, initialDelay: 10, maxDelay: 50 })).rejects.toThrow('HTTP 429');
      const duration = Date.now() - start;
      
      expect(fn).toHaveBeenCalledTimes(3); 
      // Should have taken at least 10ms + 20ms = 30ms (roughly)
      expect(duration).toBeGreaterThanOrEqual(20);
    });
  });

  describe('isTransientError', () => {
    it('returns true for 429 rate limit errors', () => {
      expect(isTransientError(new Error('HTTP 429: Too Many Requests'))).toBe(true);
    });

    it('returns true for 503 service unavailable', () => {
      expect(isTransientError(new Error('503 Service Unavailable'))).toBe(true);
    });

    it('returns true for ECONNREFUSED network errors', () => {
      expect(isTransientError(new Error('connect ECONNREFUSED 127.0.0.1:8080'))).toBe(true);
    });

    it('returns false for 404 not found', () => {
      expect(isTransientError(new Error('HTTP 404: Not Found'))).toBe(false);
    });

    it('returns false for non-Error values', () => {
      expect(isTransientError('string error')).toBe(false);
      expect(isTransientError(null)).toBe(false);
      expect(isTransientError(42)).toBe(false);
    });
  });

  describe('withTimeout', () => {
    it('resolves with the promise value when it completes in time', async () => {
      const result = await withTimeout(Promise.resolve('done'), 1000, 'test-op');
      expect(result).toBe('done');
    });

    it('rejects when the promise exceeds the timeout', async () => {
      const never = new Promise<never>(() => {});
      await expect(withTimeout(never, 30, 'slow-op')).rejects.toThrow('slow-op cancelled or timed out');
    });

    it('rejects immediately if the provided signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(withTimeout(Promise.resolve('x'), 1000, 'op', controller.signal))
        .rejects.toThrow('op cancelled or timed out');
    });

    it('passes through the original rejection error', async () => {
      const failing = Promise.reject(new Error('upstream failure'));
      await expect(withTimeout(failing, 1000, 'op')).rejects.toThrow('upstream failure');
    });
  });

  describe('createTimeoutSignal', () => {
    it('should create a signal that aborts after timeout', async () => {
      // Use real timers for this test since AbortSignal.timeout() is native
      // and can't be controlled by Vitest's fake timers
      const signal = createTimeoutSignal(50);
      expect(signal.aborted).toBe(false);
      
      await new Promise(r => setTimeout(r, 100));
      expect(signal.aborted).toBe(true);
    });

    it('should combine with existing signal', async () => {
      const controller = new AbortController();
      const signal = createTimeoutSignal(1000, controller.signal);
      
      controller.abort();
      expect(signal.aborted).toBe(true);
    });
  });
});
