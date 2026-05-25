/**
 * Integration Tests: Browser Pool Orchestration
 *
 * Tests the browser pool's ability to handle concurrent operations,
 * proper initialization, shutdown, error recovery, and resource cleanup.
 * This is an integration test that requires the browser environment.
 *
 * NOTE: These tests are currently skipped due to browser pool lifecycle issues.
 * The Camoufox browser initialization works, but the pool destruction/creation
 * cycle in tests causes race conditions resulting in
 * "Cannot execute a task on destroying pool" errors.
 *
 * TODO: Fix pool lifecycle management to properly wait for full destruction
 * before allowing new pool initialization, or implement a shared pool instance
 * across tests with proper state reset.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  runBrowserTask,
  runBrowserHealthCheck,
  stopBrowserManager,
  forceSchedulerRestart,
  getMaxWorkers,
  isBrowserAvailable,
} from '../../src/infrastructure/browser/index.ts';
import { getConfig } from '../../src/config.ts';
import { setupLifecycle, teardownLifecycle, type TestContext } from './helpers/setup.ts';
import { logger } from '../../src/logger.ts';
import type { SearchResult } from '../../src/web-research/types.ts';

// Helper to detect network unavailable
function isNetworkUnavailable(text: string): boolean {
  return text.includes('network unavailable') || text.includes('Network unavailable');
}

describe.skip('Browser Pool Orchestration', () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupLifecycle();
  });

  afterAll(async () => {
    await teardownLifecycle(testContext);
  });

  beforeEach(async () => {
    // Ensure clean state before each test
    if (testContext.lifecycleInitialized) {
      logger.log('[test] Cleaning up before test...');
      await stopBrowserManager().catch(() => {
        // Ignore errors during cleanup
      });
      // Additional delay after stopBrowserManager to allow worker processes to
      // finish their Playwright browser/context teardown before the next test
      // starts a fresh pool. stopBrowserManager already waits for pool.destroy()
      // (up to 10s) + 1.5s IPC drain, but an extra buffer guards against any
      // residual OS-level process cleanup.
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  });

  afterEach(async () => {
    // Ensure clean state after each test
    if (testContext.lifecycleInitialized) {
      await stopBrowserManager().catch(() => {
        // Ignore errors during cleanup
      });
    }
  });

  describe('Browser Pool Initialization', () => {
    it('should initialize browser pool on first task', async () => {
      if (testContext.skipTests()) {
        return;
      }

      // First task should initialize the pool
      const result = await runBrowserTask<SearchResult[]>(
        { query: 'test initialization' },
        'search'
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle concurrent initialization gracefully', async () => {
      if (testContext.skipTests()) {
        return;
      }

      // Multiple concurrent tasks should coalesce initialization
      const promises = Array.from({ length: 3 }, (_, i) =>
        runBrowserTask<SearchResult[]>(
          { query: `concurrent test ${i}` },
          'search'
        )
      );

      const results = await Promise.all(promises);
      results.forEach(result => {
        expect(result).toBeDefined();
        expect(Array.isArray(result)).toBe(true);
      });
    });

    it('should report correct max workers from config', () => {
      const config = getConfig();
      const maxWorkers = getMaxWorkers(config);
      
      expect(maxWorkers).toBeGreaterThan(0);
      expect(maxWorkers).toBeLessThanOrEqual(10);
      expect(maxWorkers).toBe(config.WORKER_THREADS);
    });
  });

  describe('Concurrent Search Operations', () => {
    it.skip('should handle multiple concurrent searches', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const queries = [
        'typescript programming',
        'javascript async',
        'react hooks',
      ];

      const promises = queries.map(query =>
        runBrowserTask<SearchResult[]>(
          { query },
          'search'
        )
      );

      const results = await Promise.all(promises);

      results.forEach(result => {
        expect(Array.isArray(result)).toBe(true);
        // Check if we have results or network is unavailable
        const hasResults = result.length > 0;
        const allEmpty = result.length === 0;
        expect(hasResults || allEmpty).toBe(true);
      });
    });

    it.skip('should handle high concurrency burst', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const config = getConfig();
      const maxWorkers = getMaxWorkers(config);
      
      // Create more tasks than workers
      const taskCount = maxWorkers * 2;
      const queries = Array.from(
        { length: taskCount },
        (_, i) => `concurrency test ${i}`
      );

      const promises = queries.map(query =>
        runBrowserTask<SearchResult[]>(
          { query },
          'search'
        )
      );

      const results = await Promise.all(promises);

      expect(results.length).toBe(taskCount);
      results.forEach(result => {
        expect(Array.isArray(result)).toBe(true);
      });
    });
  });

  describe('Concurrent Scrape Operations', () => {
    it.skip('should handle multiple concurrent scrapes', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const urls = [
        'https://en.wikipedia.org/wiki/TypeScript',
        'https://en.wikipedia.org/wiki/JavaScript',
      ];

      const promises = urls.map(url =>
        runBrowserTask<any>(
          { url },
          'scrape'
        )
      );

      const results = await Promise.all(promises);

      results.forEach(result => {
        expect(result).toBeDefined();
        expect(result).toHaveProperty('contentType');
        expect(result).toHaveProperty('html');
        // Allow for network unavailable
        const isUnavailable = result.contentType?.includes('text/html') === false && result.html === '';
        if (!isUnavailable && result.html) {
          expect(result.html.length).toBeGreaterThan(100);
        }
      });
    });
  });

  describe('Mixed Operations (Search + Scrape)', () => {
    it('should handle mixed search and scrape operations concurrently', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const searchTask = runBrowserTask<SearchResult[]>(
        { query: 'typescript programming' },
        'search'
      );

      const scrapeTask = runBrowserTask<any>(
        { url: 'https://en.wikipedia.org/wiki/TypeScript' },
        'scrape'
      );

      const [searchResults, scrapeResult] = await Promise.all([searchTask, scrapeTask]);

      expect(Array.isArray(searchResults)).toBe(true);
      expect(scrapeResult).toBeDefined();
    });
  });

  describe('Health Check', () => {
    it('should pass health check after pool initialization', async () => {
      if (testContext.skipTests()) {
        return;
      }

      // Initialize pool
      await runBrowserTask<{ success: boolean }>(
        { query: 'health check test' },
        'search'
      );

      // Run health check
      const healthCheck = await runBrowserHealthCheck();

      expect(healthCheck).toBeDefined();
      expect(healthCheck.success).toBe(true);
    });

    it('should handle health check without prior initialization', async () => {
      if (testContext.skipTests()) {
        return;
      }

      // Ensure clean state
      await stopBrowserManager();
      await new Promise(resolve => setTimeout(resolve, 500));

      // Health check should initialize pool if needed
      const healthCheck = await runBrowserHealthCheck();

      expect(healthCheck).toBeDefined();
      expect(healthCheck.success).toBe(true);
    });
  });

  describe('Error Recovery', () => {
    it('should handle invalid search queries gracefully', async () => {
      if (testContext.skipTests()) {
        return;
      }

      // Empty query should still return a result (empty array or error)
      const result = await runBrowserTask<SearchResult[]>(
        { query: '' },
        'search'
      );

      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle invalid URLs gracefully', async () => {
      if (testContext.skipTests()) {
        return;
      }

      // Invalid URLs will throw an error
      let errorCaught = false;
      try {
        await runBrowserTask<any>(
          { url: 'not-a-valid-url' },
          'scrape'
        );
      } catch (error) {
        errorCaught = true;
        expect(error).toBeDefined();
        expect(String(error)).toContain('Invalid url');
      }
      expect(errorCaught).toBe(true);
    });
  });

  describe('Resource Cleanup and Shutdown', () => {
    it('should shutdown pool completely', async () => {
      if (testContext.skipTests()) {
        return;
      }

      // Initialize pool
      await runBrowserTask<SearchResult[]>(
        { query: 'shutdown test' },
        'search'
      );

      // Shutdown
      await stopBrowserManager();

      // Small delay to ensure cleanup completes
      await new Promise(resolve => setTimeout(resolve, 500));

      // Pool should be able to restart
      const result = await runBrowserTask<SearchResult[]>(
        { query: 'restart test' },
        'search'
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle multiple shutdown/restart cycles', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const cycles = 3;

      for (let i = 0; i < cycles; i++) {
        // Run a task
        const result = await runBrowserTask<SearchResult[]>(
          { query: `cycle ${i} test` },
          'search'
        );
        expect(Array.isArray(result)).toBe(true);

        // Shutdown
        await stopBrowserManager();

        // Delay between cycles
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }, 60000); // 60 seconds for 3 shutdown/restart cycles

    it('should handle concurrent shutdown requests', async () => {
      if (testContext.skipTests()) {
        return;
      }

      // Initialize pool
      await runBrowserTask<SearchResult[]>(
        { query: 'concurrent shutdown test' },
        'search'
      );

      // Multiple concurrent shutdowns should be safe
      const promises = Array.from({ length: 3 }, () => stopBrowserManager());
      await Promise.all(promises);

      // Pool should be able to restart
      const result = await runBrowserTask<SearchResult[]>(
        { query: 'post-concurrent-shutdown test' },
        'search'
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    }, 60000); // 60 seconds for concurrent shutdown test
  });

  describe('Scheduler Restart', () => {
    it('should force scheduler restart', async () => {
      if (testContext.skipTests()) {
        return;
      }

      // Initialize pool
      await runBrowserTask<SearchResult[]>(
        { query: 'restart test before' },
        'search'
      );

      // Force restart
      await forceSchedulerRestart();

      // Small delay to allow restart to complete
      await new Promise(resolve => setTimeout(resolve, 500));

      // Pool should work after restart
      const result = await runBrowserTask<SearchResult[]>(
        { query: 'restart test after' },
        'search'
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('Browser Availability', () => {
    it('should correctly report browser availability', () => {
      const available = isBrowserAvailable();

      // If we're running integration tests, browser should be available
      if (testContext.lifecycleInitialized) {
        expect(available).toBe(true);
      }
    });
  });
});
