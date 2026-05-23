/**
 * Chaos Engineering Tests: Search Operations
 *
 * Tests chaotic scenarios for search operations including:
 * - Search timeout simulation
 * - Concurrent search with mixed outcomes
 * - Search result corruption handling
 * - Retry behavior under various failure conditions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  simulateNetworkTimeout,
  simulateConnectionReset,
  simulateConnectionRefused,
  withRandomError,
  withNetworkChaos,
  executeBurst,
  measureTime,
} from '../../utils/chaos-helpers.ts';

describe('Search Chaos Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Search Timeout Simulation', () => {
    it('should timeout slow search queries', async () => {
      const mockSearch = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 30000)); // 30s delay
        return { results: [] };
      });

      const searchWithTimeout = async (query: string, timeoutMs: number) => {
        return Promise.race([
          mockSearch(query),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Search timeout')), timeoutMs)
          )
        ]);
      };

      const promise = searchWithTimeout('test query', 5000);

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(5001);

      await expect(promise).rejects.toThrow('Search timeout');
    });

    it('should complete fast searches before timeout', async () => {
      const mockSearch = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return { results: [{ title: 'Result' }] };
      });

      const searchWithTimeout = async (query: string, timeoutMs: number) => {
        return Promise.race([
          mockSearch(query),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Search timeout')), timeoutMs)
          )
        ]);
      };

      const promise = searchWithTimeout('fast query', 5000);

      // Advance past search completion
      await vi.advanceTimersByTimeAsync(101);

      const result = await promise;
      expect(result).toEqual({ results: [{ title: 'Result' }] });
      expect(mockSearch).toHaveBeenCalledTimes(1);
    });

    it('should handle concurrent searches with different timeouts', async () => {
      const mockSearch = vi.fn().mockImplementation(async (query: string) => {
        const delay = query.includes('slow') ? 10000 : 100;
        await new Promise(resolve => setTimeout(resolve, delay));
        return { results: [{ title: query }] };
      });

      const searchWithTimeout = async (query: string, timeoutMs: number) => {
        return Promise.race([
          mockSearch(query),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Search timeout')), timeoutMs)
          )
        ]);
      };

      const operations = [
        searchWithTimeout('fast query 1', 5000),
        searchWithTimeout('slow query', 2000),
        searchWithTimeout('fast query 2', 5000),
      ];

      const promise = Promise.allSettled(operations);

      // Advance time
      await vi.advanceTimersByTimeAsync(2001);

      const results = await promise;

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected'); // Timeout
      expect(results[2].status).toBe('fulfilled');
    });
  });

  describe('Network Failure During Search', () => {
    it('should retry on connection reset during search', async () => {
      let attempt = 0;
      const mockSearch = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt === 1) {
          throw simulateConnectionReset();
        }
        return { results: [{ title: 'Result' }] };
      });

      const searchWithRetry = async (query: string, maxRetries = 3) => {
        for (let i = 0; i <= maxRetries; i++) {
          try {
            return await mockSearch(query);
          } catch (e) {
            if (i === maxRetries) throw e;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        throw new Error('Should not reach here');
      };

      const promise = searchWithRetry('test query');
      await vi.advanceTimersByTimeAsync(101);

      const result = await promise;
      expect(result).toEqual({ results: [{ title: 'Result' }] });
      expect(mockSearch).toHaveBeenCalledTimes(2);
    });

    it('should retry on connection refused', async () => {
      let attempt = 0;
      const mockSearch = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt <= 2) {
          throw simulateConnectionRefused();
        }
        return { results: [{ title: 'Result' }] };
      });

      const searchWithRetry = async (query: string) => {
        for (let i = 0; i < 5; i++) {
          try {
            return await mockSearch(query);
          } catch (e) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
        throw new Error('Max retries exceeded');
      };

      const promise = searchWithRetry('test query');
      
      // Advance through retries
      await vi.advanceTimersByTimeAsync(51);
      await vi.advanceTimersByTimeAsync(51);

      const result = await promise;
      expect(result).toEqual({ results: [{ title: 'Result' }] });
      expect(mockSearch).toHaveBeenCalledTimes(3);
    });

    it('should retry on network timeout', async () => {
      let attempt = 0;
      const mockSearch = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt === 1) {
          throw simulateNetworkTimeout();
        }
        return { results: [{ title: 'Result' }] };
      });

      const searchWithRetry = async (query: string) => {
        for (let i = 0; i < 3; i++) {
          try {
            return await mockSearch(query);
          } catch (e) {
            if (i === 2) throw e;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        throw new Error('Should not reach here');
      };

      const promise = searchWithRetry('test query');
      await vi.advanceTimersByTimeAsync(101);

      const result = await promise;
      expect(result).toEqual({ results: [{ title: 'Result' }] });
    });

    it('should exhaust retries on persistent failures', async () => {
      const mockSearch = vi.fn().mockRejectedValue(simulateNetworkTimeout());

      const searchWithRetry = async (query: string, maxRetries = 2) => {
        for (let i = 0; i <= maxRetries; i++) {
          try {
            return await mockSearch(query);
          } catch (e) {
            if (i === maxRetries) throw e;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
        throw new Error('Should not reach here');
      };

      const promise = searchWithRetry('test query');
      
      // Advance through all retries
      await vi.advanceTimersByTimeAsync(51);
      await vi.advanceTimersByTimeAsync(51);

      await expect(promise).rejects.toThrow('network timeout');
      expect(mockSearch).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });
  });

  describe('Concurrent Search with Mixed Outcomes', () => {
    it('should handle burst of searches with some failures', async () => {
      let callCount = 0;
      const mockSearch = vi.fn().mockImplementation(async () => {
        callCount++;
        // Fail every 3rd call
        if (callCount % 3 === 0) {
          throw simulateConnectionReset();
        }
        return { results: [{ title: `Result ${callCount}` }] };
      });

      const operations = Array.from({ length: 12 }, (_, i) =>
        mockSearch(`query ${i}`)
          .catch(err => ({ error: err.message, index: i }))
      );

      const results = await Promise.all(operations);

      // Should have 4 failures (every 3rd)
      const failures = results.filter((r: any) => r.error);
      const successes = results.filter((r: any) => !r.error);

      expect(failures.length).toBe(4);
      expect(successes.length).toBe(8);
    });

    it('should handle concurrent searches with network chaos', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: [{ title: 'Result' }]
      });

      const chaoticSearch = withNetworkChaos(mockSearch, {
        failureProbability: 0.3,
        failureTypes: ['timeout', 'reset', 'refused'],
        addedLatency: { min: 10, max: 50 },
        seed: 999,
      });

      const operations = Array.from({ length: 15 }, (_, i) =>
        chaoticSearch(`query ${i}`)
          .catch(err => ({ error: err.message }))
      );

      const results = await Promise.all(operations);

      // Some should fail, some should succeed
      const failures = results.filter((r: any) => r.error);
      const successes = results.filter((r: any) => !r.error);

      expect(failures.length).toBeGreaterThan(0);
      expect(successes.length).toBeGreaterThan(0);
      expect(failures.length + successes.length).toBe(15);
    });

    it('should handle burst pattern with chaos', async () => {
      let callCount = 0;
      const mockSearch = vi.fn().mockImplementation(async () => {
        callCount++;
        // First burst has failures
        if (callCount <= 5 && callCount % 2 === 0) {
          throw simulateConnectionReset();
        }
        return { results: [{ title: `Result ${callCount}` }] };
      });

      const operations = Array.from({ length: 10 }, (_, i) =>
        () => mockSearch(`query ${i}`)
          .catch(err => ({ error: err.message, index: i }))
      );

      const results = await executeBurst(operations, 5);

      // Should have some failures in first batch
      const failures = results.filter((r: any) => r.error);
      expect(failures.length).toBeGreaterThan(0);
    });
  });

  describe('Search Result Corruption Handling', () => {
    it('should handle malformed search results', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: [
          { title: 'Valid result' },
          null, // Corrupted
          { title: 'Another valid' },
          undefined, // Corrupted
        ]
      });

      const searchWithValidation = async (query: string) => {
        const response = await mockSearch(query);
        const validResults = response.results.filter((r: any) => r && r.title);
        return { results: validResults };
      };

      const result = await searchWithValidation('test query');

      expect(result.results).toHaveLength(2);
      expect(result.results[0].title).toBe('Valid result');
      expect(result.results[1].title).toBe('Another valid');
    });

    it('should handle completely invalid response', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        invalid: 'response',
        noResults: true
      });

      const searchWithValidation = async (query: string) => {
        const response = await mockSearch(query);
        if (!response.results || !Array.isArray(response.results)) {
          return { results: [], error: 'Invalid response format' };
        }
        return response;
      };

      const result = await searchWithValidation('test query');

      expect(result.results).toEqual([]);
      expect(result.error).toBe('Invalid response format');
    });

    it('should handle empty results gracefully', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: []
      });

      const result = await mockSearch('test query');

      expect(result.results).toEqual([]);
      expect(result.results).toHaveLength(0);
    });
  });

  describe('Exponential Backoff Behavior', () => {
    it('should implement exponential backoff correctly', async () => {
      let attempt = 0;
      const delays: number[] = [];

      const mockSearch = vi.fn().mockImplementation(async () => {
        attempt++;
        if (attempt <= 3) {
          throw simulateConnectionReset();
        }
        return { results: [{ title: 'Result' }] };
      });

      const searchWithBackoff = async (query: string) => {
        let delay = 100;
        for (let i = 0; i < 5; i++) {
          try {
            return await mockSearch(query);
          } catch (e) {
            delays.push(delay);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; // Exponential backoff
          }
        }
        throw new Error('Max retries exceeded');
      };

      const promise = searchWithBackoff('test query');

      // Advance through retries with increasing delays
      await vi.advanceTimersByTimeAsync(101); // First retry
      await vi.advanceTimersByTimeAsync(201); // Second retry
      await vi.advanceTimersByTimeAsync(401); // Third retry

      const result = await promise;
      expect(result).toEqual({ results: [{ title: 'Result' }] });
      expect(delays).toEqual([100, 200, 400]);
    });

    it('should respect maximum backoff delay', async () => {
      let attempt = 0;
      const maxDelay = 500;
      const delays: number[] = [];

      const mockSearch = vi.fn().mockImplementation(async () => {
        attempt++;
        throw simulateConnectionReset();
      });

      const searchWithCappedBackoff = async (query: string) => {
        let delay = 100;
        for (let i = 0; i < 5; i++) {
          try {
            return await mockSearch(query);
          } catch (e) {
            delays.push(delay);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, maxDelay); // Cap at maxDelay
          }
        }
        throw new Error('Max retries exceeded');
      };

      const promise = searchWithCappedBackoff('test query');
      promise.catch(() => {}); // Suppress unhandled rejection

      // Advance through retries
      await vi.advanceTimersByTimeAsync(101); // 100
      await vi.advanceTimersByTimeAsync(201); // 200
      await vi.advanceTimersByTimeAsync(501); // 400
      await vi.advanceTimersByTimeAsync(501); // 500 (capped)
      await vi.advanceTimersByTimeAsync(501); // 500 (capped)

      await expect(promise).rejects.toThrow();
      expect(delays).toEqual([100, 200, 400, 500, 500]);
    });
  });

  describe('Performance Under Chaos', () => {
    it('should maintain reasonable performance despite failures', async () => {
      let failCount = 0;
      const mockSearch = vi.fn().mockImplementation(async () => {
        failCount++;
        // Fail 20% of the time
        if (Math.random() < 0.2) {
          throw simulateConnectionReset();
        }
        await new Promise(resolve => setTimeout(resolve, 10));
        return { results: [{ title: 'Result' }] };
      });

      const { result, durationMs } = await measureTime(async () => {
        const operations = Array.from({ length: 20 }, (_, i) =>
          mockSearch(`query ${i}`)
            .catch(err => ({ error: err.message }))
        );
        return await Promise.all(operations);
      });

      expect(result).toHaveLength(20);

      const failures = result.filter((r: any) => r.error);
      const successes = result.filter((r: any) => !r.error);

      expect(successes.length).toBeGreaterThan(0);
      // Should complete in reasonable time despite failures
      expect(durationMs).toBeLessThan(500);
    });

    it('should handle high concurrency efficiently', async () => {
      const mockSearch = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return { results: [{ title: 'Result' }] };
      });

      const { result, durationMs } = await measureTime(async () => {
        const operations = Array.from({ length: 50 }, (_, i) =>
          mockSearch(`query ${i}`)
        );
        return await Promise.all(operations);
      });

      expect(result).toHaveLength(50);
      // 50 operations with 5ms delay each should complete in ~50-100ms with concurrency
      expect(durationMs).toBeLessThan(200);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty query string', async () => {
      const mockSearch = vi.fn().mockResolvedValue({
        results: []
      });

      const result = await mockSearch('');

      expect(result.results).toEqual([]);
    });

    it('should handle very long query string', async () => {
      const longQuery = 'a'.repeat(10000);
      const mockSearch = vi.fn().mockResolvedValue({
        results: [{ title: 'Result' }]
      });

      const result = await mockSearch(longQuery);

      expect(result.results).toHaveLength(1);
      expect(mockSearch).toHaveBeenCalledWith(longQuery);
    });

    it('should handle special characters in query', async () => {
      const specialQuery = 'test <script>alert("xss")</script> & "quotes"';
      const mockSearch = vi.fn().mockResolvedValue({
        results: [{ title: 'Result' }]
      });

      const result = await mockSearch(specialQuery);

      expect(result.results).toHaveLength(1);
    });

    it('should handle Unicode characters in query', async () => {
      const unicodeQuery = 'test 你好 🚀 العربية';
      const mockSearch = vi.fn().mockResolvedValue({
        results: [{ title: 'Result' }]
      });

      const result = await mockSearch(unicodeQuery);

      expect(result.results).toHaveLength(1);
    });
  });
});