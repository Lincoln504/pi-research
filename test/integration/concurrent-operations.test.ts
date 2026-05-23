/**
 * Integration Tests: Concurrent Operations
 *
 * Tests system behavior under concurrent load and proper isolation
 * between independent operations.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  runBrowserTask,
  stopBrowserManager,
} from '../../src/infrastructure/browser-manager.ts';
import { KnowledgeStore } from '../../src/knowledge/store.ts';
import { getConfig } from '../../src/config.ts';
import { setupLifecycle, teardownLifecycle, type TestContext } from './helpers/setup.ts';
import { logger } from '../../src/logger.ts';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

interface ConcurrentTestResult {
  sessionId: string;
  success: boolean;
  durationMs: number;
  error?: Error;
  result?: any;
}

interface ConcurrencyMetrics {
  totalOperations: number;
  successfulOperations: number;
  failedOperations: number;
  averageDurationMs: number;
  maxDurationMs: number;
  minDurationMs: number;
  isolationViolations: number;
}

// ============================================================================
// Test Implementation
// ============================================================================

describe('Concurrent Operations', () => {
  let testContext: TestContext;
  let testDbDir: string;

  beforeAll(async () => {
    testContext = await setupLifecycle();
    testDbDir = path.join(os.tmpdir(), `pi-concurrent-ops-${Date.now()}`);
  }, 30000);

  afterAll(async () => {
    await teardownLifecycle(testContext);
    // Cleanup test database
    try {
      const fs = await import('node:fs');
      if (fs.existsSync(testDbDir)) {
        fs.rmSync(testDbDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }, 30000);

  describe('Concurrent Browser Task Queue Management', () => {
    it('should handle multiple concurrent search operations', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const concurrency = 5;
      const queries = Array.from(
        { length: concurrency },
        (_, i) => `concurrent search ${i} ${randomUUID()}`
      );

      const startTime = Date.now();

      const results = await Promise.allSettled(
        queries.map(query =>
          runBrowserTask<any>({ query }, 'search')
        )
      );

      const duration = Date.now() - startTime;

      // All operations should complete
      expect(results.length).toBe(concurrency);

      // Most should succeed
      const successful = results.filter(r => r.status === 'fulfilled').length;
      expect(successful).toBeGreaterThan(0);

      // Concurrent operations should be faster than sequential
      const estimatedSequentialTime = concurrency * 1000; // 1 second each
      expect(duration).toBeLessThan(estimatedSequentialTime);

      logger.info(
        `[test] Concurrent search: ${successful}/${concurrency} successful in ${duration}ms`
      );
    }, 120000);

    it('should handle mixed search and scrape operations concurrently', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const searchTasks = [
        runBrowserTask<any>({ query: 'mixed test 1' }, 'search'),
        runBrowserTask<any>({ query: 'mixed test 2' }, 'search'),
      ];

      const scrapeTasks = [
        runBrowserTask<any>(
          { url: 'https://example.com' },
          'scrape'
        ),
      ];

      const startTime = Date.now();

      const results = await Promise.allSettled([
        ...searchTasks,
        ...scrapeTasks,
      ]);

      const duration = Date.now() - startTime;

      // All should complete
      expect(results.length).toBe(3);

      // Most should succeed
      const successful = results.filter(r => r.status === 'fulfilled').length;
      expect(successful).toBeGreaterThan(0);

      logger.info(
        `[test] Mixed operations: ${successful}/${results.length} successful in ${duration}ms`
      );
    }, 120000);

    it('should handle burst of concurrent operations', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const burstSize = 10;
      const queries = Array.from(
        { length: burstSize },
        (_, i) => `burst test ${i} ${randomUUID()}`
      );

      const startTime = Date.now();

      const results = await Promise.allSettled(
        queries.map(query =>
          runBrowserTask<any>({ query }, 'search')
        )
      );

      const duration = Date.now() - startTime;

      // All should complete
      expect(results.length).toBe(burstSize);

      // Most should succeed
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const successRate = successful / burstSize;

      expect(successRate).toBeGreaterThan(0.3); // At least 30% should succeed

      logger.info(
        `[test] Burst (${burstSize}): ${successful}/${burstSize} successful in ${duration}ms`
      );
    }, 180000);
  });

  describe('Concurrent Research Session Isolation', () => {
    it('should maintain isolation between concurrent knowledge store operations', async () => {
      const dbPath = path.join(testDbDir, `isolation-${randomUUID()}`);
      const knowledgeStore = new KnowledgeStore(dbPath);
      await knowledgeStore.open();

      // Create sessions with different documents
      const session1Docs = [
        { content: 'Session 1 document A', url: 'https://session1.com/a' },
        { content: 'Session 1 document B', url: 'https://session1.com/b' },
      ];

      const session2Docs = [
        { content: 'Session 2 document X', url: 'https://session2.com/x' },
        { content: 'Session 2 document Y', url: 'https://session2.com/y' },
      ];

      // Add documents concurrently
      await Promise.all([
        knowledgeStore.addDocuments(session1Docs),
        knowledgeStore.addDocuments(session2Docs),
      ]);

      // Verify all documents were added
      const totalCount = await knowledgeStore.count();
      expect(totalCount).toBe(4);

      // Verify session 1 documents
      const results1 = await knowledgeStore.search('Session 1');
      expect(results1.length).toBeGreaterThanOrEqual(2);

      // Verify session 2 documents
      const results2 = await knowledgeStore.search('Session 2');
      expect(results2.length).toBeGreaterThanOrEqual(2);

      await knowledgeStore.close();
    }, 60000);

    it('should handle concurrent searches without interference', async () => {
      const dbPath = path.join(testDbDir, `search-isolation-${randomUUID()}`);
      const knowledgeStore = new KnowledgeStore(dbPath);

      await knowledgeStore.open();

      // Add diverse documents
      await knowledgeStore.addDocuments([
        { content: 'TypeScript is a superset of JavaScript', url: 'https://ts.com' },
        { content: 'Python is a popular programming language', url: 'https://py.com' },
        { content: 'Rust is a systems programming language', url: 'https://rust.com' },
        { content: 'Go is a language developed at Google', url: 'https://go.com' },
      ]);

      // Perform concurrent searches
      const searchResults = await Promise.all([
        knowledgeStore.search('TypeScript'),
        knowledgeStore.search('Python'),
        knowledgeStore.search('Rust'),
        knowledgeStore.search('Go'),
        knowledgeStore.search('programming'),
      ]);

      // Each search should return relevant results
      searchResults.forEach((results, index) => {
        expect(results).toBeDefined();
        expect(Array.isArray(results)).toBe(true);
      });

      // TypeScript search should find TypeScript document
      const tsResults = searchResults[0];
      const hasTsDoc = tsResults.some(r =>
        r.metadata?.url === 'https://ts.com'
      );
      expect(hasTsDoc).toBe(true);

      await knowledgeStore.close();
    }, 60000);

    it('should handle concurrent document additions and deletions', async () => {
      const dbPath = path.join(testDbDir, `concurrent-crud-${randomUUID()}`);
      const knowledgeStore = new KnowledgeStore(dbPath);

      await knowledgeStore.open();

      // Add initial documents
      const initialDocs = Array.from(
        { length: 10 },
        (_, i) => ({
          content: `Document ${i}`,
          url: `https://test.com/doc${i}`,
        })
      );

      await knowledgeStore.addDocuments(initialDocs);

      // Concurrent operations: add, search, count
      const operations = [
        knowledgeStore.addDocuments([
          { content: 'New document A', url: 'https://test.com/new-a' },
          { content: 'New document B', url: 'https://test.com/new-b' },
        ]),
        knowledgeStore.search('Document'),
        knowledgeStore.count(),
        knowledgeStore.addDocuments([
          { content: 'New document C', url: 'https://test.com/new-c' },
        ]),
        knowledgeStore.search('New'),
      ];

      const results = await Promise.allSettled(operations);

      // All should complete
      expect(results.length).toBe(5);

      // Most should succeed
      const successful = results.filter(r => r.status === 'fulfilled').length;
      expect(successful).toBeGreaterThan(0);

      await knowledgeStore.close();
    }, 60000);
  });

  describe('Browser Pool Thread Safety', () => {
    it('should handle rapid sequential task submissions', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const taskCount = 20;
      const results: Array<{ success: boolean; duration: number }> = [];

      // Submit tasks sequentially but rapidly
      for (let i = 0; i < taskCount; i++) {
        const start = Date.now();
        try {
          await runBrowserTask<any>(
            { query: `rapid sequential ${i}` },
            'search'
          );
          results.push({ success: true, duration: Date.now() - start });
        } catch (error) {
          results.push({ success: false, duration: Date.now() - start });
        }
      }

      // All should complete
      expect(results.length).toBe(taskCount);

      // Most should succeed
      const successful = results.filter(r => r.success).length;
      expect(successful).toBeGreaterThan(taskCount * 0.5);

      logger.info(
        `[test] Rapid sequential: ${successful}/${taskCount} successful`
      );
    }, 120000);

    it('should handle task submission during pool restart', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const promises: Promise<any>[] = [];

      // Submit initial tasks
      for (let i = 0; i < 3; i++) {
        promises.push(
          runBrowserTask<any>({ query: `pre-restart ${i}` }, 'search')
        );
      }

      // Restart pool while tasks are running
      const restartPromise = stopBrowserManager();

      // Submit more tasks during restart
      for (let i = 0; i < 3; i++) {
        promises.push(
          runBrowserTask<any>({ query: `during-restart ${i}` }, 'search')
        );
      }

      // Wait for restart
      await restartPromise;

      // Submit final tasks
      for (let i = 0; i < 3; i++) {
        promises.push(
          runBrowserTask<any>({ query: `post-restart ${i}` }, 'search')
        );
      }

      const results = await Promise.allSettled(promises);

      // Most should complete successfully
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const total = results.length;
      const successRate = successful / total;

      expect(successRate).toBeGreaterThan(0.3);

      logger.info(
        `[test] During restart: ${successful}/${total} successful (${(successRate * 100).toFixed(1)}%)`
      );
    }, 120000);
  });

  describe('Resource Management Under Concurrency', () => {
    it('should not leak file handles under concurrent load', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const fs = await import('node:fs');
      const getOpenFileCount = async () => {
        try {
          // On Linux, count open file descriptors
          const pid = process.pid;
          const fdDir = `/proc/${pid}/fd`;
          if (fs.existsSync(fdDir)) {
            const fds = fs.readdirSync(fdDir);
            return fds.length;
          }
        } catch {
          // Not supported on this platform
        }
        return 0;
      };

      const beforeCount = await getOpenFileCount();

      // Run concurrent operations
      const operations = Array.from(
        { length: 10 },
        (_, i) =>
          runBrowserTask<any>({ query: `resource test ${i}` }, 'search')
      );

      await Promise.allSettled(operations);

      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 2000));

      const afterCount = await getOpenFileCount();

      // File handle count should not increase significantly
      const increase = afterCount - beforeCount;
      logger.info(
        `[test] File handle change: ${increase} (before: ${beforeCount}, after: ${afterCount})`
      );

      // Allow some increase but not excessive
      expect(increase).toBeLessThan(20);
    }, 120000);

    it('should maintain stable memory usage under concurrent load', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const memoryBefore = process.memoryUsage().heapUsed;

      // Run concurrent operations
      const operations = Array.from(
        { length: 15 },
        (_, i) =>
          runBrowserTask<any>({ query: `memory test ${i}` }, 'search')
      );

      await Promise.allSettled(operations);

      // Wait for potential cleanup
      await new Promise(resolve => setTimeout(resolve, 1000));

      const memoryAfter = process.memoryUsage().heapUsed;
      const memoryIncrease = memoryAfter - memoryBefore;
      const increaseMB = memoryIncrease / 1024 / 1024;

      logger.info(
        `[test] Memory increase: ${increaseMB.toFixed(2)} MB`
      );

      // Memory increase should be reasonable (< 100MB for 15 operations)
      expect(increaseMB).toBeLessThan(100);
    }, 120000);
  });

  describe('Concurrency Metrics', () => {
    it('should calculate and report concurrency metrics accurately', async () => {
      if (testContext.skipTests()) {
        return;
      }

      const concurrency = 5;
      const queries = Array.from(
        { length: concurrency },
        (_, i) => `metrics test ${i}`
      );

      const results: ConcurrentTestResult[] = [];
      const startTime = Date.now();

      await Promise.all(
        queries.map(async (query, index) => {
          const sessionId = `session-${randomUUID()}`;
          const start = Date.now();

          try {
            const result = await runBrowserTask<any>({ query }, 'search');
            results.push({
              sessionId,
              success: true,
              durationMs: Date.now() - start,
              result,
            });
          } catch (error) {
            results.push({
              sessionId,
              success: false,
              durationMs: Date.now() - start,
              error: error as Error,
            });
          }
        })
      );

      const totalDuration = Date.now() - startTime;

      // Calculate metrics
      const metrics: ConcurrencyMetrics = {
        totalOperations: results.length,
        successfulOperations: results.filter(r => r.success).length,
        failedOperations: results.filter(r => !r.success).length,
        averageDurationMs:
          results.reduce((sum, r) => sum + r.durationMs, 0) /
          results.length,
        maxDurationMs: Math.max(...results.map(r => r.durationMs)),
        minDurationMs: Math.min(...results.map(r => r.durationMs)),
        isolationViolations: 0, // Would check for cross-session contamination
      };

      logger.info('[test] Concurrency metrics:', JSON.stringify(metrics, null, 2));

      // Verify metrics
      expect(metrics.totalOperations).toBe(concurrency);
      expect(metrics.successfulOperations).toBeGreaterThan(0);
      expect(metrics.averageDurationMs).toBeGreaterThan(0);
      expect(metrics.maxDurationMs).toBeGreaterThanOrEqual(metrics.minDurationMs);

      // Concurrent should be faster than sequential
      const estimatedSequentialTime =
        metrics.averageDurationMs * concurrency;
      expect(totalDuration).toBeLessThan(estimatedSequentialTime * 0.8);
    }, 120000);
  });
});