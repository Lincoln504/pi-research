import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  isTransientError, 
  retryWithBackoff, 
  createTimeoutSignal, 
  withTimeout 
} from '../../../src/web-research/retry-utils.ts';

describe('retry-utils', () => {
  describe('isTransientError', () => {
    it('returns true for network errors', () => {
      expect(isTransientError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isTransientError(new Error('ETIMEDOUT'))).toBe(true);
      expect(isTransientError(new Error('ENOTFOUND'))).toBe(true);
    });

    it('returns true for rate limit errors', () => {
      expect(isTransientError(new Error('HTTP 429: Too Many Requests'))).toBe(true);
      expect(isTransientError(new Error('Rate limit exceeded'))).toBe(true);
    });

    it('returns true for 5xx server errors', () => {
      expect(isTransientError(new Error('HTTP 500: Internal Server Error'))).toBe(true);
      expect(isTransientError(new Error('HTTP 503: Service Unavailable'))).toBe(true);
    });

    it('returns false for other errors', () => {
      expect(isTransientError(new Error('HTTP 404: Not Found'))).toBe(false);
      expect(isTransientError(new Error('Validation failed'))).toBe(false);
      expect(isTransientError(null)).toBe(false);
    });

    it('does not over-classify words/numbers that merely contain "rate" or a 5xx substring', () => {
      // "generate"/"moderate" contain "rate"; a token count contains "500".
      expect(isTransientError(new Error('failed to generate a research plan'))).toBe(false);
      expect(isTransientError(new Error('response was moderate quality'))).toBe(false);
      expect(isTransientError(new Error('context of 50000 tokens exceeded budget'))).toBe(false);
    });
  });

  describe('retryWithBackoff', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('returns result on first successful attempt', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await retryWithBackoff(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on transient errors and eventually succeeds', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('503 Service Unavailable'))
        .mockResolvedValue('finally success');

      const promise = retryWithBackoff(fn, { initialDelay: 100, maxRetries: 3 });

      // Attempt 1 fails, wait for delay
      await vi.advanceTimersByTimeAsync(150);
      // Attempt 2 fails, wait for delay
      await vi.advanceTimersByTimeAsync(300);

      const result = await promise;
      expect(result).toBe('finally success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('throws immediately on non-transient errors', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Fatal error 404'));
      await expect(retryWithBackoff(fn)).rejects.toThrow('Fatal error 404');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('exhausts retries and throws last error', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const promise = retryWithBackoff(fn, { initialDelay: 100, maxRetries: 2 });
      
      // Silence unhandled rejection warning while we advance timers
      promise.catch(() => {});

      // Initial call fails. Delay 1: 100ms.
      await vi.advanceTimersByTimeAsync(150);
      // Retry 1 fails. Delay 2: 200ms.
      await vi.advanceTimersByTimeAsync(300);
      // Retry 2 fails. Throws.

      await expect(promise).rejects.toThrow('ECONNREFUSED');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('stops retrying and surfaces the original error when the signal aborts during backoff', async () => {
      vi.useRealTimers(); // deterministic real-time abort instead of fake-timer microtask juggling
      const controller = new AbortController();
      const fn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const promise = retryWithBackoff(fn, { initialDelay: 10000, maxRetries: 5, signal: controller.signal });
      promise.catch(() => {});

      // Let the first attempt fail and the loop park in the long (10s) backoff.
      await new Promise((r) => setTimeout(r, 20));
      expect(fn).toHaveBeenCalledTimes(1);

      // Abort mid-backoff: the wait short-circuits and the ORIGINAL transient
      // error is surfaced (not a synthetic AbortError), without further attempts.
      controller.abort();
      await expect(promise).rejects.toThrow('ECONNREFUSED');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('abortableDelay', () => {
    beforeEach(() => {
      vi.useRealTimers();
    });

    it('resolves after the delay when not aborted', async () => {
      const { abortableDelay } = await import('../../../src/web-research/retry-utils.ts');
      await expect(abortableDelay(10)).resolves.toBeUndefined();
    });

    it('rejects immediately if the signal is already aborted', async () => {
      const { abortableDelay } = await import('../../../src/web-research/retry-utils.ts');
      const controller = new AbortController();
      controller.abort();
      await expect(abortableDelay(10000, controller.signal)).rejects.toThrow(/abort/i);
    });

    it('rejects when the signal aborts mid-wait', async () => {
      const { abortableDelay } = await import('../../../src/web-research/retry-utils.ts');
      const controller = new AbortController();
      const p = abortableDelay(10000, controller.signal);
      controller.abort();
      await expect(p).rejects.toThrow(/abort/i);
    });
  });

  describe('createTimeoutSignal', () => {
    it('creates a signal that aborts after timeout', async () => {
      // Mock AbortSignal.timeout to undefined to force the fallback path
      // that uses setTimeout, which works reliably with vi.useFakeTimers()
      const originalTimeout = AbortSignal.timeout;
      (AbortSignal as any).timeout = undefined;
      
      try {
        vi.useFakeTimers();
        const signal = createTimeoutSignal(100);
        expect(signal.aborted).toBe(false);
        vi.advanceTimersByTime(101);
        expect(signal.aborted).toBe(true);
      } finally {
        AbortSignal.timeout = originalTimeout;
      }
    });

    it('combines with an existing signal', () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const signal = createTimeoutSignal(1000, controller.signal);
      
      controller.abort('external');
      expect(signal.aborted).toBe(true);
    });
  });

  describe('withTimeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('resolves if promise completes before timeout', async () => {
      const promise = Promise.resolve('ok');
      const result = await withTimeout(promise, 1000, 'test');
      expect(result).toBe('ok');
    });

    it('rejects if timeout occurs first', async () => {
      // Use a promise that won't reject on its own to avoid unhandled rejections
      let resolveRef: any;
      const slowPromise = new Promise(resolve => { resolveRef = resolve; });
      
      const promise = withTimeout(slowPromise, 100, 'test');
      
      vi.advanceTimersByTime(101);
      
      await expect(promise).rejects.toThrow('test cancelled or timed out');
      resolveRef('done'); // Cleanup
    });

    it('rejects if external signal aborts', async () => {
      const controller = new AbortController();
      let resolveRef: any;
      const slowPromise = new Promise(resolve => { resolveRef = resolve; });
      
      const promise = withTimeout(slowPromise, 5000, 'test', controller.signal);
      
      controller.abort();
      
      await expect(promise).rejects.toThrow('test cancelled or timed out');
      resolveRef('done'); // Cleanup
    });
  });
});
