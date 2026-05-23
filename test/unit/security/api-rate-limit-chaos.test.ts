/**
 * Chaos Engineering Tests: API Rate Limit
 *
 * Tests chaotic scenarios for API rate limiting including:
 * - HTTP 429 error simulation
 * - Retry-After header handling
 * - Exponential backoff with rate limiting
 * - Concurrent requests under rate limit pressure
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  simulateRateLimitError,
  withRandomError,
  executeBurst,
  measureTime,
} from '../../utils/chaos-helpers.ts';

describe('API Rate Limit Chaos Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('HTTP 429 Error Simulation', () => {
    it('should detect 429 rate limit errors', async () => {
      const error = simulateRateLimitError(5);
      
      expect(error.message).toContain('429');
      expect((error as any).statusCode).toBe(429);
      expect((error as any).retryAfter).toBe(5);
    });

    it('should retry on 429 with exponential backoff', async () => {
      let attempt = 0;
      const mockApiCall = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt <= 2) {
          throw simulateRateLimitError(1);
        }
        return { data: 'success' };
      });

      const apiCallWithRetry = async (maxRetries = 3) => {
        let delay = 1000;
        for (let i = 0; i <= maxRetries; i++) {
          try {
            return await mockApiCall();
          } catch (e: any) {
            if (i === maxRetries) throw e;
            
            // Use Retry-After if available, otherwise exponential backoff
            const waitTime = (e as any).retryAfter * 1000 || delay;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            delay = Math.min(delay * 2, 30000); // Cap at 30s
          }
        }
        throw new Error('Should not reach here');
      };

      const promise = apiCallWithRetry();
      
      // First retry after 1 second (Retry-After)
      await vi.advanceTimersByTimeAsync(1001);
      // Second retry after 1 second (Retry-After)
      await vi.advanceTimersByTimeAsync(1001);

      const result = await promise;
      expect(result).toEqual({ data: 'success' });
      expect(mockApiCall).toHaveBeenCalledTimes(3);
    });

    it('should respect Retry-After header when provided', async () => {
      const retryAfterSeconds = 3;
      let attempt = 0;
      const mockApiCall = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt === 1) {
          throw simulateRateLimitError(retryAfterSeconds);
        }
        return { data: 'success' };
      });

      const apiCallWithRetry = async () => {
        for (let i = 0; i < 3; i++) {
          try {
            return await mockApiCall();
          } catch (e: any) {
            const waitTime = e.retryAfter * 1000 || 1000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
        throw new Error('Max retries exceeded');
      };

      const promise = apiCallWithRetry();
      
      // Should wait exactly retryAfterSeconds
      await vi.advanceTimersByTimeAsync(retryAfterSeconds * 1000 + 1);

      const result = await promise;
      expect(result).toEqual({ data: 'success' });
      expect(mockApiCall).toHaveBeenCalledTimes(2);
    });

    it('should fallback to exponential backoff without Retry-After', async () => {
      let attempt = 0;
      const delays: number[] = [];
      
      const mockApiCall = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt <= 2) {
          // 429 without Retry-After
          const error = new Error('HTTP 429: Too Many Requests');
          (error as any).statusCode = 429;
          throw error;
        }
        return { data: 'success' };
      });

      const apiCallWithRetry = async () => {
        let delay = 1000;
        for (let i = 0; i < 5; i++) {
          try {
            return await mockApiCall();
          } catch (e: any) {
            delays.push(delay);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, 30000);
          }
        }
        throw new Error('Max retries exceeded');
      };

      const promise = apiCallWithRetry();
      
      // First retry after 1s
      await vi.advanceTimersByTimeAsync(1001);
      // Second retry after 2s
      await vi.advanceTimersByTimeAsync(2001);

      const result = await promise;
      expect(result).toEqual({ data: 'success' });
      expect(delays).toEqual([1000, 2000]);
    });

    it('should exhaust retries on persistent rate limiting', async () => {
      const mockApiCall = vi.fn().mockImplementation(async () => {
        throw simulateRateLimitError(1);
      });

      const apiCallWithRetry = async (maxRetries = 2) => {
        let delay = 1000;
        for (let i = 0; i <= maxRetries; i++) {
          try {
            return await mockApiCall();
          } catch (e: any) {
            if (i === maxRetries) throw e;
            const waitTime = e.retryAfter * 1000 || delay;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            delay = Math.min(delay * 2, 30000);
          }
        }
        throw new Error('Should not reach here');
      };

      const promise = apiCallWithRetry();
      promise.catch(() => {}); // Suppress unhandled rejection

      // Advance through all retries
      await vi.advanceTimersByTimeAsync(1001);
      await vi.advanceTimersByTimeAsync(1001);

      await expect(promise).rejects.toThrow('429');
      expect(mockApiCall).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });
  });

  describe('Rate Limit Detection', () => {
    it('should identify various 429 error formats', async () => {
      const errorFormats = [
        'HTTP 429: Too Many Requests',
        'Rate limit exceeded',
        'Quota exceeded',
        '429 Too Many Requests',
        'API rate limit exceeded',
      ];

      for (const format of errorFormats) {
        const error = new Error(format);
        (error as any).statusCode = 429;
        
        const isRateLimit = error.message.includes('429') || 
                           error.message.toLowerCase().includes('rate') ||
                           error.message.toLowerCase().includes('quota');
        
        expect(isRateLimit).toBe(true);
      }
    });

    it('should not confuse 429 with other 4xx errors', async () => {
      const errors = [
        { msg: 'HTTP 400: Bad Request', code: 400, isRateLimit: false },
        { msg: 'HTTP 401: Unauthorized', code: 401, isRateLimit: false },
        { msg: 'HTTP 403: Forbidden', code: 403, isRateLimit: false },
        { msg: 'HTTP 404: Not Found', code: 404, isRateLimit: false },
        { msg: 'HTTP 429: Too Many Requests', code: 429, isRateLimit: true },
      ];

      for (const { msg, code, isRateLimit } of errors) {
        const error = new Error(msg);
        (error as any).statusCode = code;
        
        const detected = error.message.includes('429') || code === 429;
        expect(detected).toBe(isRateLimit);
      }
    });
  });

  describe('Concurrent Requests Under Rate Limit', () => {
    it('should handle burst of requests hitting rate limit', async () => {
      let requestCount = 0;
      const rateLimitThreshold = 5;
      
      const mockApiCall = vi.fn().mockImplementation(async () => {
        requestCount++;
        // First 5 succeed, next 3 hit rate limit, then succeed again
        if (requestCount > rateLimitThreshold && requestCount <= rateLimitThreshold + 3) {
          throw simulateRateLimitError(2);
        }
        return { data: `result ${requestCount}` };
      });

      const apiCallWithRetry = async (maxRetries = 3) => {
        let delay = 1000;
        for (let i = 0; i <= maxRetries; i++) {
          try {
            return await mockApiCall();
          } catch (e: any) {
            if (i === maxRetries) throw e;
            const waitTime = e.retryAfter * 1000 || delay;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            delay = Math.min(delay * 2, 30000);
          }
        }
        throw new Error('Max retries exceeded');
      };

      const operations = Array.from({ length: 10 }, (_, i) =>
        apiCallWithRetry().catch(err => ({ error: err.message, index: i }))
      );

      const promise = Promise.all(operations);

      // Advance through retries
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(2001);
      }

      const results = await promise;

      // All should complete
      expect(results).toHaveLength(10);

      // Some may have failed if retries exhausted
      const failures = results.filter((r: any) => r.error);
      const successes = results.filter((r: any) => !r.error);

      expect(successes.length).toBeGreaterThan(0);
    });

    it('should distribute retries across time to avoid rate limit', async () => {
      let requestCount = 0;
      const timestamps: number[] = [];
      
      const mockApiCall = vi.fn().mockImplementation(async () => {
        timestamps.push(Date.now());
        requestCount++;
        // Rate limit if too many requests in short time
        const recentRequests = timestamps.filter(t => Date.now() - t < 1000).length;
        if (recentRequests > 3) {
          throw simulateRateLimitError(1);
        }
        return { data: `result ${requestCount}` };
      });

      const apiCallWithRetry = async (maxRetries = 5) => {
        let delay = 1000;
        for (let i = 0; i <= maxRetries; i++) {
          try {
            return await mockApiCall();
          } catch (e: any) {
            if (i === maxRetries) throw e;
            const waitTime = e.retryAfter * 1000 || delay;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            delay = Math.min(delay * 2, 30000);
          }
        }
        throw new Error('Max retries exceeded');
      };

      const operations = Array.from({ length: 8 }, () =>
        apiCallWithRetry()
      );

      const promise = Promise.all(operations);

      // Advance time to allow retries to spread out
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(1001);
      }

      const results = await promise;

      // All should eventually succeed
      expect(results).toHaveLength(8);
      results.forEach(r => {
        expect(r).toBeDefined();
      });
    });
  });

  describe('Backoff Strategy', () => {
    it('should implement jitter with backoff', async () => {
      let attempt = 0;
      const delays: number[] = [];
      
      const mockApiCall = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt <= 3) {
          throw simulateRateLimitError();
        }
        return { data: 'success' };
      });

      const apiCallWithJitteredBackoff = async () => {
        let baseDelay = 1000;
        for (let i = 0; i < 5; i++) {
          try {
            return await mockApiCall();
          } catch (e: any) {
            // Add ±50% jitter
            const jitter = baseDelay * 0.5 * (Math.random() * 2 - 1);
            const delay = Math.max(0, baseDelay + jitter);
            delays.push(delay);
            await new Promise(resolve => setTimeout(resolve, delay));
            baseDelay = Math.min(baseDelay * 2, 30000);
          }
        }
        throw new Error('Max retries exceeded');
      };

      const promise = apiCallWithJitteredBackoff();

      // Advance through retries
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(5000);

      const result = await promise;
      expect(result).toEqual({ data: 'success' });
      expect(delays).toHaveLength(3);
    });

    it('should cap maximum backoff delay', async () => {
      const maxDelay = 5000;
      let attempt = 0;
      const delays: number[] = [];
      
      const mockApiCall = vi.fn().mockImplementation(async () => {
        attempt++;
        throw simulateRateLimitError();
      });

      const apiCallWithCappedBackoff = async () => {
        let delay = 1000;
        for (let i = 0; i < 6; i++) {
          try {
            return await mockApiCall();
          } catch (e: any) {
            delay = Math.min(delay * 2, maxDelay);
            delays.push(delay);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
        throw new Error('Max retries exceeded');
      };

      const promise = apiCallWithCappedBackoff();
      promise.catch(() => {});

      // Advance through all retries
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(maxDelay + 100);
      }

      await expect(promise).rejects.toThrow();

      // All delays should be <= maxDelay
      delays.forEach(d => {
        expect(d).toBeLessThanOrEqual(maxDelay);
      });

      // Should have capped at maxDelay
      expect(delays.filter(d => d === maxDelay).length).toBeGreaterThan(0);
    });
  });

  describe('Rate Limit Headers', () => {
    it('should extract and use X-RateLimit-Reset header', async () => {
      let attempt = 0;
      const mockApiCall = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt === 1) {
          const error = new Error('HTTP 429: Too Many Requests');
          (error as any).statusCode = 429;
          (error as any).headers = {
            'X-RateLimit-Reset': Math.floor(Date.now() / 1000) + 3
          };
          throw error;
        }
        return { data: 'success' };
      });

      const apiCallWithRetry = async () => {
        for (let i = 0; i < 3; i++) {
          try {
            return await mockApiCall();
          } catch (e: any) {
            let waitTime = 1000;
            if (e.headers && e.headers['X-RateLimit-Reset']) {
              const resetTime = e.headers['X-RateLimit-Reset'] * 1000;
              waitTime = Math.max(0, resetTime - Date.now());
            }
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
        throw new Error('Max retries exceeded');
      };

      const promise = apiCallWithRetry();
      
      // Wait for reset
      await vi.advanceTimersByTimeAsync(3001);

      const result = await promise;
      expect(result).toEqual({ data: 'success' });
    });

    it('should handle missing rate limit headers gracefully', async () => {
      let attempt = 0;
      const mockApiCall = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt === 1) {
          // 429 without headers
          const error = new Error('HTTP 429: Too Many Requests');
          (error as any).statusCode = 429;
          throw error;
        }
        return { data: 'success' };
      });

      const apiCallWithRetry = async () => {
        for (let i = 0; i < 3; i++) {
          try {
            return await mockApiCall();
          } catch (e: any) {
            // Default backoff when no headers
            const waitTime = 1000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
        throw new Error('Max retries exceeded');
      };

      const promise = apiCallWithRetry();
      await vi.advanceTimersByTimeAsync(1001);

      const result = await promise;
      expect(result).toEqual({ data: 'success' });
    });
  });

  describe('Performance Under Rate Limit', () => {
    it('should complete successfully despite rate limiting', async () => {
      let requestCount = 0;
      const mockApiCall = vi.fn().mockImplementation(async () => {
        requestCount++;
        // Rate limit every 3rd request
        if (requestCount % 3 === 0) {
          throw simulateRateLimitError(1);
        }
        return { data: `result ${requestCount}` };
      });

      const apiCallWithRetry = async (maxRetries = 3) => {
        let delay = 1000;
        for (let i = 0; i <= maxRetries; i++) {
          try {
            return await mockApiCall();
          } catch (e: any) {
            if (i === maxRetries) throw e;
            const waitTime = e.retryAfter * 1000 || delay;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            delay = Math.min(delay * 2, 30000);
          }
        }
        throw new Error('Should not reach here');
      };

      const { result, durationMs } = await measureTime(async () => {
        const operations = Array.from({ length: 15 }, () =>
          apiCallWithRetry()
        );
        return await Promise.all(operations);
      });

      expect(result).toHaveLength(15);
      // Should complete despite rate limits
      expect(durationMs).toBeGreaterThan(0);
    });

    it('should handle high concurrency with rate limiting', async () => {
      let requestCount = 0;
      const mockApiCall = vi.fn().mockImplementation(async () => {
        requestCount++;
        if (requestCount <= 5) {
          throw simulateRateLimitError(1);
        }
        return { data: `result ${requestCount}` };
      });

      const apiCallWithRetry = async (maxRetries = 5) => {
        let delay = 1000;
        for (let i = 0; i <= maxRetries; i++) {
          try {
            return await mockApiCall();
          } catch (e: any) {
            if (i === maxRetries) throw e;
            const waitTime = e.retryAfter * 1000 || delay;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            delay = Math.min(delay * 2, 30000);
          }
        }
        throw new Error('Max retries exceeded');
      };

      const operations = Array.from({ length: 10 }, () =>
        apiCallWithRetry().catch(err => ({ error: err.message }))
      );

      const promise = Promise.all(operations);

      // Advance through retries
      for (let i = 0; i < 8; i++) {
        await vi.advanceTimersByTimeAsync(1001);
      }

      const results = await promise;

      // All should complete
      expect(results).toHaveLength(10);

      const failures = results.filter((r: any) => r.error);
      const successes = results.filter((r: any) => !r.error);

      expect(successes.length).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle Retry-After of 0', async () => {
      let attempt = 0;
      const mockApiCall = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt === 1) {
          throw simulateRateLimitError(0);
        }
        return { data: 'success' };
      });

      const apiCallWithRetry = async () => {
        for (let i = 0; i < 3; i++) {
          try {
            return await mockApiCall();
          } catch (e: any) {
            const waitTime = (e.retryAfter || 1) * 1000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
        throw new Error('Max retries exceeded');
      };

      const promise = apiCallWithRetry();
      await vi.advanceTimersByTimeAsync(1);

      const result = await promise;
      expect(result).toEqual({ data: 'success' });
    });

    it('should handle very large Retry-After value', async () => {
      const largeRetryAfter = 3600; // 1 hour
      let attempt = 0;
      
      const mockApiCall = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt === 1) {
          throw simulateRateLimitError(largeRetryAfter);
        }
        return { data: 'success' };
      });

      const apiCallWithCappedRetry = async (maxWaitMs = 5000) => {
        for (let i = 0; i < 2; i++) {
          try {
            return await mockApiCall();
          } catch (e: any) {
            let waitTime = e.retryAfter * 1000;
            waitTime = Math.min(waitTime, maxWaitMs); // Cap the wait
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
        throw new Error('Max retries exceeded');
      };

      const promise = apiCallWithCappedRetry();
      await vi.advanceTimersByTimeAsync(5001);

      const result = await promise;
      expect(result).toEqual({ data: 'success' });
    });
  });
});