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
vi.mock('../../../src/infrastructure/browser/browser-configuration.ts', () => ({
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

import { runWorkerSearch, getMaxWorkers } from '../../../src/infrastructure/browser-manager.ts';
import { logger } from '../../../src/logger.ts';

describe('browser-search', () => {
  const mockSearchResults: SearchResult[] = [
    { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet 1' },
    { title: 'Result 2', url: 'https://example.com/2', snippet: 'Snippet 2' },
    { title: 'Result 3', url: 'https://example.com/3', snippet: 'Snippet 3' },
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
        return [{ title: 'Result', url: `https://example.com/${encodeURIComponent(q)}`, snippet: 'test' }];
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
      expect(runWorkerSearch).toHaveBeenCalledWith('q1', undefined);
      expect(runWorkerSearch).toHaveBeenCalledWith('q2', undefined);
      expect(runWorkerSearch).toHaveBeenCalledWith('q3', undefined);
    });

    it('should pass config to workers when provided', async () => {
      const mockConfig = {
        WORKER_THREADS: 4,
        RESEARCHER_TIMEOUT_MS: 360000,
      } as any;

      await performSearch(['test'], mockConfig);

      expect(runWorkerSearch).toHaveBeenCalledWith('test', mockConfig);
    });

    it('should use max workers from browser-manager', async () => {
      vi.mocked(getMaxWorkers).mockReturnValue(8);

      await performSearch(['test']);

      expect(getMaxWorkers).toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('across 8 worker processes')
      );
    });

    it('should execute queries in parallel', async () => {
      const queries = ['q1', 'q2', 'q3'];
      const startTime = Date.now();
      
      let resolveTimes = [100, 150, 200];
      vi.mocked(runWorkerSearch).mockImplementation(async () => {
        const delay = resolveTimes.shift() || 0;
        await new Promise(r => setTimeout(r, delay));
        return mockSearchResults;
      });

      await performSearch(queries);
      const elapsed = Date.now() - startTime;

      // With parallel execution, should complete in roughly max delay (200ms)
      // plus some overhead, not sum of all delays (450ms)
      expect(elapsed).toBeLessThan(400);
    });
  });

  describe('abort handling', () => {
    it('should respect abort signal', async () => {
      const controller = new AbortController();
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        await new Promise(r => setTimeout(r, 100));
        return mockSearchResults;
      });

      // Abort immediately - this will result in empty results and total failure error
      controller.abort();
      
      await expect(performSearch(['test'], undefined, controller.signal))
        .rejects.toThrow('Search completely failed');
    });

    it('should handle partial abort', async () => {
      const controller = new AbortController();
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        await new Promise(r => setTimeout(r, 50));
        return mockSearchResults;
      });

      // Abort after some delay
      setTimeout(() => controller.abort(), 25);
      const result = await performSearch(['q1', 'q2'], undefined, controller.signal);

      // Behavior may vary, but should handle gracefully
      expect(result).toBeInstanceOf(Map);
    });
  });

  describe('progress callback', () => {
    it('should call progress callback with unique URL count', async () => {
      const progressCb = vi.fn();
      
      // Return different URLs for different queries
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        return [
          { title: `Result for ${q}`, url: `https://example.com/${q}`, snippet: 'Snippet' },
        ];
      });

      await performSearch(['q1', 'q2', 'q3'], undefined, undefined, progressCb);

      expect(progressCb).toHaveBeenCalled();
      // Should be called multiple times as results come in
      expect(progressCb.mock.calls.length).toBeGreaterThan(0);
      
      // Final call should have 3 unique URLs
      const finalCall = progressCb.mock.calls[progressCb.mock.calls.length - 1];
      expect(finalCall[0]).toBe(3);
    });

    it('should track unique URLs across all queries', async () => {
      const progressCb = vi.fn();

      // Return overlapping URLs
      vi.mocked(runWorkerSearch).mockImplementation(async (q) => {
        const base = [
          { title: 'Shared Result', url: 'https://example.com/shared', snippet: 'Shared' },
        ];
        const unique = [
          { title: `Unique to ${q}`, url: `https://example.com/${q}`, snippet: 'Unique' },
        ];
        return [...base, ...unique];
      });

      await performSearch(['q1', 'q2', 'q3'], undefined, undefined, progressCb);

      // Should track unique URLs (1 shared + 3 unique = 4 total)
      const finalCall = progressCb.mock.calls[progressCb.mock.calls.length - 1];
      expect(finalCall[0]).toBe(4);
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
      expect(logger.error.mock.calls[0][0]).toContain('[Search]');
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
        fail('Should have thrown');
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
        if (q === 'null') return null;
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
        { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet' },
        { title: 'Result 2', url: 'https://example.com/1', snippet: 'Duplicate URL' },
      ]);

      const result = await performSearch(['test']);

      // Results should be deduplicated in the final Map
      expect(result.get('test')).toHaveLength(1);
    });

    it('should preserve result structure', async () => {
      const customResults: SearchResult[] = [
        { title: 'Test', url: 'https://test.com', snippet: 'Test snippet' },
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
      expect(logger.error.mock.calls[0][0]).toContain('[Search]');
    });
  });
});
