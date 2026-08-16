/**
 * Browser Search Unit Tests
 *
 * Tests for the browser-based search orchestration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { performSearch } from '../../../src/web-research/browser-search.ts';
import type { SearchResult } from '../../../src/web-research/types.ts';

// Mock the task-execution-service module
vi.mock('../../../src/infrastructure/browser/task-execution-service.ts', () => ({
  runWorkerSearch: vi.fn(),
  runBrowserTask: vi.fn(),
  runBrowserHealthCheck: vi.fn(),
}));

// Mock the browser-configuration module
vi.mock('../../../src/infrastructure/browser/config.ts', () => ({
  getMaxWorkers: vi.fn(() => 4),
  isBrowserAvailable: vi.fn(() => true),
  getSchedulerVersion: vi.fn(() => '1.0.0'),
  generateSchedulerVersion: vi.fn(() => '1.0.0'),
}));

// Mock the logger
vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/core/service-registry.ts', () => ({
  getServiceContainer: vi.fn(() => ({})),
  tryGetServiceContainerFromCtx: vi.fn(() => ({})),
}));

import { runWorkerSearch, getMaxWorkers } from '../../../src/infrastructure/browser/index.ts';
import { logger } from '../../../src/logger.ts';

describe('browser-search', () => {
  const mockSearchResults: SearchResult[] = [
    { title: 'Result 1', url: 'https://example.com/1', content: 'Snippet 1' },
    { title: 'Result 2', url: 'https://example.com/2', content: 'Snippet 2' },
    { title: 'Result 3', url: 'https://example.com/3', content: 'Snippet 3' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMaxWorkers).mockReturnValue(4);
    vi.mocked(runWorkerSearch).mockResolvedValue(mockSearchResults);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('basic search execution', () => {
    it('should execute search for a single query', async () => {
      const result = await performSearch(['test query']);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(1);
      expect(result.get('test query')).toEqual(mockSearchResults);
    });

    it('should execute search for multiple queries', async () => {
      const queries = ['query 1', 'query 2', 'query 3'];
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        // Use unique URLs for each query to avoid global deduplication
        return mockSearchResults.map(r => ({ 
          ...r, 
          url: `${r.url}?q=${encodeURIComponent(q)}`,
          title: `${r.title} - ${q}` 
        }));
      });

      const result = await performSearch(queries);

      expect(result.size).toBe(3);
      expect(result.get('query 1')).toHaveLength(3);
      expect(result.get('query 2')).toHaveLength(3);
      expect(result.get('query 3')).toHaveLength(3);
    });

    it('should filter out empty and whitespace-only queries', async () => {
      const queries = ['valid query 1', '', '  ', 'valid query 2'];
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        // Valid queries get a result; empty/whitespace never reach the worker (filtered before dispatch)
        return [{ title: 'Result', url: `https://example.com/${encodeURIComponent(q)}`, content: 'test' }];
      });

      const result = await performSearch(queries);

      // Empty string and whitespace-only queries are filtered before dispatch — not in result Map
      expect(result.size).toBe(2);
      expect(result.has('valid query 1')).toBe(true);
      expect(result.has('valid query 2')).toBe(true);
      expect(result.has('')).toBe(false);
      expect(result.has('  ')).toBe(false);
      // Worker was only called for the 2 valid queries
      expect(runWorkerSearch).toHaveBeenCalledTimes(2);
    });

    it('should return Map with query strings as keys', async () => {
      const queries = ['query a', 'query b'];
      const result = await performSearch(queries);

      expect(result.has('query a')).toBe(true);
      expect(result.has('query b')).toBe(true);
      expect(Array.from(result.keys())).toEqual(queries);
    });
  });

  describe('worker coordination', () => {
    it('should call runWorkerSearch for each query', async () => {
      const queries = ['q1', 'q2', 'q3'];
      await performSearch(queries);

      expect(runWorkerSearch).toHaveBeenCalledTimes(3);
      expect(runWorkerSearch).toHaveBeenCalledWith('q1', undefined, expect.any(AbortSignal), 1, undefined, expect.any(Object));
      expect(runWorkerSearch).toHaveBeenCalledWith('q2', undefined, expect.any(AbortSignal), 1, undefined, expect.any(Object));
      expect(runWorkerSearch).toHaveBeenCalledWith('q3', undefined, expect.any(AbortSignal), 1, undefined, expect.any(Object));
    });

    it('should pass config to workers when provided', async () => {
      const mockConfig = {
        WORKER_THREADS: 4,
        RESEARCHER_TIMEOUT_MS: 360000,
      } as any;

      await performSearch(['test'], mockConfig);

      expect(runWorkerSearch).toHaveBeenCalledWith('test', mockConfig, expect.any(AbortSignal), 1, undefined, expect.any(Object));
    });

    it('passes sessionId through to runWorkerSearch so the per-session circuit breaker applies', async () => {
      await performSearch(['test'], undefined, undefined, undefined, undefined, undefined, 'pisess-abcd1234');

      expect(runWorkerSearch).toHaveBeenCalledWith('test', undefined, expect.any(AbortSignal), 1, 'pisess-abcd1234', expect.any(Object));
    });

    it('should use max workers from browser-manager', async () => {
      vi.mocked(getMaxWorkers).mockReturnValue(8);

      await performSearch(['test']);

      expect(getMaxWorkers).toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('across 8 worker processes')
      );
    });
  });

  describe('abort handling', () => {
    it('reports a cancelled search as cancelled, not as an infrastructure failure', async () => {
      const controller = new AbortController();
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        await new Promise(r => setTimeout(r, 100));
        return mockSearchResults;
      });

      controller.abort();

      // Every query aborts with zero results, which looks identical to a dead
      // browser pool. It must NOT be reported as one: the old message told the
      // user "Browser workers may be unavailable, DuckDuckGo is unreachable, or
      // the system is under extreme load" when all they did was press Ctrl-C.
      const attempt = performSearch(['test'], undefined, controller.signal);
      await expect(attempt).rejects.toThrow('Aborted');
      await expect(attempt).rejects.not.toThrow('Search completely failed');
    });

    it('discards partial results when the caller cancels mid-flight', async () => {
      const controller = new AbortController();
      // Note this mock ignores the signal, so queries DO return results — the
      // rejection below is driven by the cancellation itself, not by emptiness.
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        await new Promise(r => setTimeout(r, 50));
        return mockSearchResults;
      });

      setTimeout(() => controller.abort(), 25);

      await expect(performSearch(['q1', 'q2'], undefined, controller.signal))
        .rejects.toThrow('Aborted');
    });
  });

  describe('progress callback', () => {
    it('should call progress callback with unique URL count', async () => {
      const progressCb = vi.fn();
      
      // Return different URLs for different queries
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        return [
          { title: `Result for ${q}`, url: `https://example.com/${q}`, content: 'Content' },
        ];
      });

      await performSearch(['q1', 'q2', 'q3'], undefined, undefined, progressCb);

      expect(progressCb).toHaveBeenCalled();
      // Should be called multiple times as results come in
      expect(progressCb.mock.calls.length).toBeGreaterThan(0);
      
      // Final call should have 3 unique URLs
      const finalCall = progressCb.mock.calls[progressCb.mock.calls.length - 1];
      expect(finalCall![0]!).toBe(3);
    });

    it('should track unique URLs across all queries', async () => {
      const progressCb = vi.fn();

      // Return overlapping URLs
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        const base = [
          { title: 'Shared Result', url: 'https://example.com/shared', content: 'Shared' },
        ];
        const unique = [
          { title: `Unique to ${q}`, url: `https://example.com/${q}`, content: 'Unique' },
        ];
        return [...base, ...unique];
      });

      await performSearch(['q1', 'q2', 'q3'], undefined, undefined, progressCb);

      // Should track unique URLs (1 shared + 3 unique = 4 total)
      const finalCall = progressCb.mock.calls[progressCb.mock.calls.length - 1];
      expect(finalCall![0]!).toBe(4);
    });

    it('should handle progress callback errors gracefully', async () => {
      const progressCb = vi.fn(() => {
        // Don't throw, just track the call
      });

      // Progress callback should be called multiple times
      await performSearch(['test'], undefined, undefined, progressCb);
      expect(progressCb).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle worker failure gracefully', async () => {
      // Need at least one successful query to avoid total failure
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        if (q === 'failing') throw new Error('Worker failed');
        return mockSearchResults;
      });

      const result = await performSearch(['working', 'failing']);

      expect(result.get('working')).toEqual(mockSearchResults);
      expect(result.get('failing')).toEqual([]);
      expect(logger.error).toHaveBeenCalled();
      expect(vi.mocked(logger.error).mock.calls[0][0]).toContain('[Search]');
    });

    it('should continue with other queries after one fails', async () => {
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        if (q === 'failing') {
          throw new Error('Failed');
        }
        return mockSearchResults;
      });

      const result = await performSearch(['failing', 'working']);

      expect(result.get('failing')).toEqual([]);
      expect(result.get('working')).toEqual(mockSearchResults);
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('should throw error when all queries return no results', async () => {
      vi.mocked(runWorkerSearch).mockResolvedValue([]);

      await expect(performSearch(['q1', 'q2', 'q3']))
        .rejects.toThrow('Search completely failed');
    });

    it('should throw error with helpful message on total failure', async () => {
      vi.mocked(runWorkerSearch).mockResolvedValue([]);

      try {
        await performSearch(['test']);
        throw new Error('Should have thrown');
      } catch (error) {
        expect(String(error)).toContain('all 1 queries returned no results');
        expect(String(error)).toContain('Browser workers may be unavailable');
      }
    });

    it('should not throw when some queries succeed', async () => {
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        if (q === 'empty') return [];
        return mockSearchResults;
      });

      // One query returns empty, one returns results
      await expect(performSearch(['empty', 'working'])).resolves.toBeInstanceOf(Map);
    });

    it('should handle null results from workers', async () => {
      // Need at least one successful query to avoid total failure
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        if (q === 'null') return null as any;
        return mockSearchResults;
      });

      const result = await performSearch(['working', 'null']);

      expect(result.get('working')).toEqual(mockSearchResults);
      expect(result.get('null')).toEqual([]);
    });
  });

  describe('result handling', () => {
    it('should deduplicate URLs within same query results', async () => {
      vi.mocked(runWorkerSearch).mockResolvedValue([
        { title: 'Result 1', url: 'https://example.com/1', content: 'Content' },
        { title: 'Result 2', url: 'https://example.com/1', content: 'Duplicate URL' },
      ]);

      const result = await performSearch(['test']);

      // Results should be deduplicated in the final Map
      expect(result.get('test')).toHaveLength(1);
    });

    it('should preserve result structure', async () => {
      const customResults: SearchResult[] = [
        { title: 'Test', url: 'https://test.com', content: 'Test snippet' },
      ];
      vi.mocked(runWorkerSearch).mockResolvedValue(customResults);

      const result = await performSearch(['test']);

      expect(result.get('test')).toEqual(customResults);
    });

    it('should handle empty query list', async () => {
      const result = await performSearch([]);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it('should handle queries with special characters', async () => {
      const queries = ['test with spaces', 'test+plus', 'test&ampersand'];
      
      await performSearch(queries);

      expect(runWorkerSearch).toHaveBeenCalledTimes(3);
    });
  });

  describe('logging', () => {
    it('should log search orchestration start', async () => {
      await performSearch(['test']);

      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('[Search]')
      );
    });

    it('should log successful worker results', async () => {
      await performSearch(['test']);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('[Search]')
      );
    });

    it('should log worker errors', async () => {
      // Need successful queries to avoid total failure
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        if (q === 'failing') throw new Error('Test error');
        return mockSearchResults;
      });

      await performSearch(['working', 'failing']);

      expect(logger.error).toHaveBeenCalled();
      expect(vi.mocked(logger.error).mock.calls[0][0]).toContain('[Search]');
    });
  });

  /**
   * Burst dispatch.
   *
   * Handing every query to Promise.all at once put N-minus-maxWorkers of them in the shared
   * browser queue with their per-query deadline ALREADY RUNNING — the clock started at
   * enqueue, not when a worker picked the query up. The number that could possibly succeed
   * was therefore `maxWorkers x (budget / latency)`, not N. Measured on a level-3 run: 100
   * queries into 6 workers went 94 deep, 78 aborted at the 90s mark having never run, and
   * the burst returned 49 results — then reported those as timeouts, which told the
   * researchers to retry and grew the next burst.
   */
  describe('bounded dispatch', () => {
    it('never runs more queries at once than there are workers', async () => {
      vi.mocked(getMaxWorkers).mockReturnValue(3);
      let inFlight = 0;
      let peak = 0;
      vi.mocked(runWorkerSearch).mockImplementation(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
        return mockSearchResults;
      });

      await performSearch(Array.from({ length: 30 }, (_, i) => `q${i}`));

      expect(peak).toBeLessThanOrEqual(3);
    });

    it('still runs every query — pacing must not drop work', async () => {
      // The whole point of pacing rather than trimming: nothing is discarded, it is just
      // served in order.
      vi.mocked(getMaxWorkers).mockReturnValue(2);
      const seen: string[] = [];
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        seen.push(q as string);
        return mockSearchResults;
      });

      const queries = Array.from({ length: 25 }, (_, i) => `q${i}`);
      const out = await performSearch(queries);

      expect(seen.sort()).toEqual([...queries].sort());
      for (const q of queries) expect(out.has(q)).toBe(true);
    });

    it('starts a query\'s deadline when it runs, not when the burst is dispatched', async () => {
      // The correctness property. With a 2-lane pool and slow searches, the LAST query
      // starts long after dispatch; under the old code its budget had already elapsed by
      // then and it aborted without ever running. Here it must still get a full attempt.
      vi.mocked(getMaxWorkers).mockReturnValue(2);
      const startedAt: number[] = [];
      const t0 = Date.now();
      // Unique URLs per query: results are deduplicated ACROSS queries, so a shared fixture
      // would leave every query after the first with an empty (but successful) result set
      // and make the assertion below meaningless.
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        startedAt.push(Date.now() - t0);
        await new Promise(r => setTimeout(r, 10));
        return [{ title: `t-${q}`, url: `https://example.com/${q}`, content: 'c' }];
      });

      // A budget far shorter than the total burst duration: 12 queries / 2 lanes x 10ms
      // is ~60ms of wall clock, against a 40ms per-query budget.
      const config = { SEARCH_TIMEOUT_MS: 30, BROWSER_TASK_TIMEOUT_MS: 10 } as any;
      const out = await performSearch(Array.from({ length: 12 }, (_, i) => `q${i}`), config);

      // Every query ran, including ones dispatched after the budget would have expired.
      expect(startedAt).toHaveLength(12);
      expect(Math.max(...startedAt)).toBeGreaterThan(40);
      expect([...out.values()].every(v => v.length > 0)).toBe(true);
    });

    it('stops pulling new queries once the caller aborts', async () => {
      vi.mocked(getMaxWorkers).mockReturnValue(2);
      const ac = new AbortController();
      let started = 0;
      vi.mocked(runWorkerSearch).mockImplementation(async () => {
        started++;
        if (started === 3) ac.abort();
        return mockSearchResults;
      });

      await expect(
        performSearch(Array.from({ length: 40 }, (_, i) => `q${i}`), undefined, ac.signal),
      ).rejects.toThrow('Aborted');

      // Not all 40 were dispatched — the lanes stopped pulling work.
      expect(started).toBeLessThan(40);
    });
  });
});
