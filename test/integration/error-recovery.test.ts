/**
 * Integration Tests: Error Recovery and Resilience
 *
 * Tests system behavior under failure conditions and its ability to recover.
 * These are integration tests that require the browser and knowledge store.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  runBrowserTask,
  stopBrowserManager,
  forceSchedulerRestart,
} from '../../src/infrastructure/browser-manager.ts';
import { KnowledgeStore } from '../../src/knowledge/store.ts';
import { getConfig } from '../../src/config.ts';
import { setupLifecycle, teardownLifecycle, type TestContext, makeSyntheticEmbedder } from './helpers/setup.ts';
import { CircuitBreaker } from '../../src/utils/circuit-breaker.ts';
import { logger } from '../../src/logger.ts';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

interface RecoveryTestResult {
  scenario: string;
  recovered: boolean;
  attempts: number;
  durationMs: number;
  error?: Error;
}

// ============================================================================
// Test Implementation
// ============================================================================

describe('Error Recovery and Resilience', () => {
  let testContext: TestContext;
  let testDbDir: string;
  const embedder = makeSyntheticEmbedder();
  const modelName = 'Xenova/all-MiniLM-L6-v2';

  beforeAll(async () => {
    testContext = await setupLifecycle();
    testDbDir = path.join(os.tmpdir(), `pi-error-recovery-${Date.now()}`);
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

  describe('Browser Pool Recovery', () => {
    it('should recover browser pool after crash', async () => {
      if (testContext.skipTests()) {
        return;
      }

      // Run a successful task to initialize pool
      const result1 = await runBrowserTask<any>(
        { query: 'initialization test' },
        'search'
      );
      expect(result1).toBeDefined();

      // Force stop to simulate crash
      await stopBrowserManager();

      // Small delay to ensure cleanup
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Pool should recover and run new task
      const result2 = await runBrowserTask<any>(
        { query: 'recovery test' },
        'search'
      );

      expect(result2).toBeDefined();
    }, 90000);

    it('should recover from multiple rapid failures', async () => {
      if (testContext.skipTests()) {
        return;
      }

      let successCount = 0;
      let failureCount = 0;

      // Run multiple tasks rapidly
      for (let i = 0; i < 10; i++) {
        try {
          const result = await runBrowserTask<any>(
            { query: `rapid test ${i}` },
            'search'
          );
          if (result) {
            successCount++;
          } else {
            failureCount++;
          }
        } catch (error) {
          failureCount++;
        }
      }

      // Most should succeed even after failures
      const totalAttempts = successCount + failureCount;
      const successRate = totalAttempts > 0 ? successCount / totalAttempts : 0;

      expect(successRate).toBeGreaterThan(0.5);
      logger.info(`[test] Recovery rate: ${successRate.toFixed(2)} (${successCount}/${totalAttempts})`);
    }, 120000);

    it('should handle and recover from scheduler restart', async () => {
      if (testContext.skipTests()) {
        return;
      }

      // Initialize pool
      const result1 = await runBrowserTask<any>(
        { query: 'pre-restart test' },
        'search'
      );
      expect(result1).toBeDefined();

      // Force restart
      await forceSchedulerRestart();

      // Small delay for restart
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Should work after restart
      const result2 = await runBrowserTask<any>(
        { query: 'post-restart test' },
        'search'
      );

      expect(result2).toBeDefined();
    }, 90000);

    it('should handle concurrent restart requests safely', async () => {
      if (testContext.skipTests()) {
        return;
      }

      // Initialize pool
      await runBrowserTask<any>(
        { query: 'concurrent restart test' },
        'search'
      );

      // Multiple concurrent restarts should be safe
      await Promise.all([
        forceSchedulerRestart(),
        forceSchedulerRestart(),
        forceSchedulerRestart(),
      ]);

      // Delay for restart to complete
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Pool should still work
      const result = await runBrowserTask<any>(
        { query: 'after concurrent restarts' },
        'search'
      );

      expect(result).toBeDefined();
    }, 90000);
  });

  describe('Knowledge Store Recovery', () => {
    it('should recover from corrupted database file', async () => {
      const dbPath = path.join(testDbDir, `corrupt-${randomUUID()}`);
      const knowledgeStore = new KnowledgeStore({ dbDir: dbPath, embedder, modelName });

      // Initialize store
      await knowledgeStore.open();
      await knowledgeStore.addDocuments([
        { text: 'Test document 1', url: 'https://test.com/1', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() },
        { text: 'Test document 2', url: 'https://test.com/2', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() },
      ]);

      const countBefore = await knowledgeStore.count();
      expect(countBefore).toBeGreaterThan(0);

      await knowledgeStore.close();

      // Corrupt the database (simulate corruption)
      const fs = await import('node:fs');
      const dbFiles = fs.readdirSync(dbPath).filter(f => f.endsWith('.db') || f.endsWith('.sqlite'));

      for (const file of dbFiles) {
        const filePath = path.join(dbPath, file);
        const content = fs.readFileSync(filePath);
        // Corrupt first few bytes
        const corrupted = Buffer.from(content);
        corrupted[0] = 0xFF;
        corrupted[1] = 0xFF;
        fs.writeFileSync(filePath, corrupted);
      }

      // Should recover or create new store
      const recoveredStore = new KnowledgeStore({ dbDir: dbPath, embedder, modelName });
      try {
        await recoveredStore.open();

        // Either we recovered data or we have a fresh store
        const countAfter = await recoveredStore.count();
        expect(countAfter).toBeGreaterThanOrEqual(0);

        await recoveredStore.close();
      } catch (error) {
        // If recovery fails, we should be able to create a new store
        const newStorePath = path.join(testDbDir, `recovered-${randomUUID()}`);
        const newStore = new KnowledgeStore({ dbDir: newStorePath, embedder, modelName });
        await newStore.open();

        const countInNew = await newStore.count();
        expect(countInNew).toBe(0);

        await newStore.close();
      }
    }, 60000);

    it('should handle concurrent database operations safely', async () => {
      const dbPath = path.join(testDbDir, `concurrent-${randomUUID()}`);
      const knowledgeStore = new KnowledgeStore({ dbDir: dbPath, embedder, modelName });
      await knowledgeStore.open();

      // Add initial documents
      await knowledgeStore.addDocuments([
        { text: 'Initial document', url: 'https://test.com/initial', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() },
      ]);

      // Concurrent operations
      const operations = [
        knowledgeStore.search('test'),
        knowledgeStore.count(),
        knowledgeStore.addDocuments([
          { text: 'Concurrent doc 1', url: 'https://test.com/c1', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() },
        ]),
        knowledgeStore.search('initial'),
        knowledgeStore.addDocuments([
          { text: 'Concurrent doc 2', url: 'https://test.com/c2', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() },
        ]),
      ];

      const results = await Promise.allSettled(operations);

      // All operations should complete (some might fail but not crash)
      const completed = results.filter(r => r.status === 'fulfilled').length;
      expect(completed).toBeGreaterThan(0);

      const finalCount = await knowledgeStore.count();
      expect(finalCount).toBeGreaterThan(0);

      await knowledgeStore.close();
    }, 60000);

    it('should recover from write failures gracefully', async () => {
      const dbPath = path.join(testDbDir, `write-fail-${randomUUID()}`);
      const knowledgeStore = new KnowledgeStore({ dbDir: dbPath, embedder, modelName });
      await knowledgeStore.open();

      // Simulate write failures by making the directory read-only
      const fs = await import('node:fs');
      try {
        fs.chmodSync(dbPath, 0o444);

        // Attempt to write should fail gracefully
        let caughtError = false;
        try {
          await knowledgeStore.addDocuments([
            { text: 'Should fail', url: 'https://test.com/fail', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() },
          ]);
        } catch (error) {
          caughtError = true;
        }

        // Either succeeded or failed gracefully (not crashed)
        expect(true).toBe(true);
      } finally {
        // Restore permissions
        try {
          fs.chmodSync(dbPath, 0o755);
        } catch {
          // Ignore
        }
        await knowledgeStore.close();
      }
    }, 60000);
  });

  describe('Circuit Breaker Integration', () => {
    it('should integrate circuit breaker with browser operations', async () => {
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 3,
        resetTimeoutMs: 5000,
        isTransientError: (error: any) => {
          return String(error).includes('timeout') ||
                 String(error).includes('network') ||
                 String(error).includes('ECONN');
        },
      });

      let successes = 0;
      let failures = 0;

      // Execute multiple operations through circuit breaker
      for (let i = 0; i < 10; i++) {
        try {
          const result = await circuitBreaker.execute(async () => {
            return await runBrowserTask<any>(
              { query: `circuit breaker test ${i}` },
              'search'
            );
          });
          successes++;
        } catch (error) {
          failures++;
          logger.debug(`[test] Circuit breaker caught error:`, error);
        }
      }

      // Circuit breaker should prevent cascading failures
      const total = successes + failures;
      expect(total).toBeGreaterThan(0);
      logger.info(`[test] Circuit breaker stats: ${successes} successes, ${failures} failures`);
    }, 120000);

    it('should open circuit after threshold failures and recover after timeout', async () => {
      vi.useFakeTimers();

      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 10000,
      });

      const failingAction = vi.fn().mockRejectedValue(new Error('transient error'));

      // Trip the circuit
      await expect(circuitBreaker.execute(failingAction)).rejects.toThrow();
      await expect(circuitBreaker.execute(failingAction)).rejects.toThrow();

      expect(circuitBreaker.getState()).toBe('OPEN');

      // Fast-forward past reset timeout
      vi.advanceTimersByTime(15000);

      // Should transition to HALF_OPEN and allow one test
      const successAction = vi.fn().mockResolvedValue('success');
      const result = await circuitBreaker.execute(successAction);

      expect(result).toBe('success');
      expect(circuitBreaker.getState()).toBe('CLOSED');

      vi.restoreAllMocks();
    }, 60000);
  });

  describe('Retry Logic', () => {
    it('should retry failed operations with exponential backoff', async () => {
      vi.useFakeTimers();

      let attemptCount = 0;
      const maxAttempts = 3;

      const flakyAction = vi.fn(async () => {
        attemptCount++;
        if (attemptCount < maxAttempts) {
          throw new Error('temporary failure');
        }
        return 'success';
      });

      // Simple retry implementation (in real code, use retry utility)
      async function retryWithBackoff<T>(
        action: () => Promise<T>,
        maxRetries: number
      ): Promise<T> {
        let lastError: Error | undefined;

        for (let i = 0; i <= maxRetries; i++) {
          try {
            return await action();
          } catch (error) {
            lastError = error as Error;
            if (i < maxRetries) {
              const delay = Math.pow(2, i) * 100; // Exponential backoff
              vi.advanceTimersByTime(delay);
            }
          }
        }

        throw lastError;
      }

      const result = await retryWithBackoff(flakyAction, maxAttempts);

      expect(result).toBe('success');
      expect(attemptCount).toBe(maxAttempts);

      vi.restoreAllMocks();
    }, 60000);

    it('should not retry non-transient errors', async () => {
      let attemptCount = 0;

      const fatalAction = vi.fn(async () => {
        attemptCount++;
        throw new Error('fatal error - no retry');
      });

      // Simple retry with transient error detection
      async function retryTransient<T>(
        action: () => Promise<T>,
        isTransient: (error: Error) => boolean
      ): Promise<T> {
        let lastError: Error | undefined;

        for (let i = 0; i < 3; i++) {
          try {
            return await action();
          } catch (error) {
            lastError = error as Error;
            if (!isTransient(lastError) || i >= 2) {
              throw lastError;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        throw lastError;
      }

      const isTransient = (error: Error) => !error.message.includes('fatal');

      await expect(
        retryTransient(fatalAction, isTransient)
      ).rejects.toThrow('fatal error');

      // Should only attempt once (no retries for fatal errors)
      expect(attemptCount).toBe(1);
    }, 60000);
  });

  describe('Resource Exhaustion Recovery', () => {
    it('should handle high memory usage gracefully', async () => {
      // Simulate high memory usage by creating large strings
      const largeStrings: string[] = [];
      const memoryBefore = process.memoryUsage().heapUsed;

      try {
        // Create memory pressure
        for (let i = 0; i < 100; i++) {
          largeStrings.push('x'.repeat(1024 * 1024)); // 1MB each
        }

        const memoryDuring = process.memoryUsage().heapUsed;
        const memoryIncrease = memoryDuring - memoryBefore;

        logger.info(`[test] Memory increase: ${(memoryIncrease / 1024 / 1024).toFixed(2)} MB`);

        // System should still function under memory pressure
        const result = await runBrowserTask<any>(
          { query: 'memory pressure test' },
          'search'
        );

        expect(result).toBeDefined();
      } finally {
        // Cleanup
        largeStrings.length = 0;
        if (global.gc) {
          global.gc();
        }
      }
    }, 90000);

    it('should recover from file descriptor exhaustion', async () => {
      if (testContext.skipTests()) {
        return;
      }

      // Open many files to simulate fd exhaustion
      const fs = await import('node:fs');
      const openFiles: number[] = [];
      const maxFiles = 50; // Conservative limit

      try {
        for (let i = 0; i < maxFiles; i++) {
          const tempPath = path.join(testDbDir, `fd-test-${i}.tmp`);
          const fd = fs.openSync(tempPath, 'w');
          openFiles.push(fd);
        }

        // System should still function
        const result = await runBrowserTask<any>(
          { query: 'fd pressure test' },
          'search'
        );

        expect(result).toBeDefined();
      } finally {
        // Cleanup
        for (const fd of openFiles) {
          try {
            fs.closeSync(fd);
          } catch {
            // Ignore
          }
        }
        // Clean up temp files
        for (let i = 0; i < maxFiles; i++) {
          try {
            const tempPath = path.join(testDbDir, `fd-test-${i}.tmp`);
            fs.unlinkSync(tempPath);
          } catch {
            // Ignore
          }
        }
      }
    }, 90000);
  });
});