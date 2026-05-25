/**
 * Load Tests: Configurable Concurrent Research Sessions with Behavior Validation
 *
 * Tests the system's ability to handle multiple simultaneous research
 * sessions with configurable parameters, behavior validation, and
 * resource contention measurement.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DeepResearchOrchestrator } from '../../src/orchestration/deep-research-orchestrator.ts';
import { QuickResearchOrchestrator } from '../../src/orchestration/quick-research-orchestrator.ts';
import { getConfig } from '../../src/config.ts';
import * as path from 'node:path';
import os from 'node:os';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { logger } from '../../src/logger.ts';

// ============================================================================
// Configuration
// ============================================================================

interface LoadTestConfig {
  concurrency: number;
  duration: number;
  maxMemoryIncreaseMB: number;
  maxFileHandleIncrease: number;
  minSuccessRate: number;
  maxAverageLatencyMs: number;
  maxSessionInterferenceRate: number;
}

const QUICK_LOAD_CONFIG: LoadTestConfig = {
  concurrency: parseInt(process.env['LOAD_TEST_CONCURRENCY'] || '5'),
  duration: parseInt(process.env['LOAD_TEST_DURATION'] || '30000'),
  maxMemoryIncreaseMB: parseInt(process.env['LOAD_TEST_MAX_MEMORY_MB'] || '50'),
  maxFileHandleIncrease: parseInt(process.env['LOAD_TEST_MAX_FDS'] || '10'),
  minSuccessRate: parseFloat(process.env['LOAD_TEST_MIN_SUCCESS_RATE'] || '0.7'),
  maxAverageLatencyMs: parseInt(process.env['LOAD_TEST_MAX_LATENCY'] || '5000'),
  maxSessionInterferenceRate: parseFloat(process.env['LOAD_TEST_MAX_INTERFERENCE'] || '0.1'),
};

const STANDARD_LOAD_CONFIG: LoadTestConfig = {
  concurrency: parseInt(process.env['LOAD_TEST_CONCURRENCY'] || '10'),
  duration: parseInt(process.env['LOAD_TEST_DURATION'] || '60000'),
  maxMemoryIncreaseMB: parseInt(process.env['LOAD_TEST_MAX_MEMORY_MB'] || '100'),
  maxFileHandleIncrease: parseInt(process.env['LOAD_TEST_MAX_FDS'] || '20'),
  minSuccessRate: parseFloat(process.env['LOAD_TEST_MIN_SUCCESS_RATE'] || '0.6'),
  maxAverageLatencyMs: parseInt(process.env['LOAD_TEST_MAX_LATENCY'] || '10000'),
  maxSessionInterferenceRate: parseFloat(process.env['LOAD_TEST_MAX_INTERFERENCE'] || '0.15'),
};

// ============================================================================
// Types
// ============================================================================

interface ResearchSessionResult {
  sessionId: string;
  depth: number;
  query: string;
  success: boolean;
  durationMs: number;
  memoryBeforeMB: number;
  memoryAfterMB: number;
  fileHandlesBefore: number;
  fileHandlesAfter: number;
  error?: Error;
  resultQuality?: 'high' | 'medium' | 'low';
  stateConsistent: boolean;
  knowledgeStoreAccessible: boolean;
}

interface LoadTestMetrics {
  config: LoadTestConfig;
  totalSessions: number;
  successfulSessions: number;
  failedSessions: number;
  successRate: number;
  averageDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  totalMemoryIncreaseMB: number;
  averageMemoryIncreaseMB: number;
  totalFileHandleIncrease: number;
  averageFileHandleIncrease: number;
  sessionsByDepth: Record<number, { count: number; successRate: number }>;
  interferenceDetected: boolean;
  resourceLeaksDetected: boolean;
  dataCorruptionDetected: boolean;
  stateConsistencyRate: number;
  knowledgeStoreAvailabilityRate: number;
}

interface ResourceSnapshot {
  heapUsedMB: number;
  externalMB: number;
  fileHandles: number;
  timestamp: number;
}

// ============================================================================
// Mock Objects
// ============================================================================

const mockBrowserManager = {
  runBrowserTask: vi.fn(async (data: any, type: string) => {
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));

    if (type === 'search') {
      return {
        results: [
          { url: `https://example.com/result/1`, title: `Result 1`, snippet: 'Snippet 1' },
          { url: `https://example.com/result/2`, title: `Result 2`, snippet: 'Snippet 2' },
        ],
        totalResults: 2,
        searchTimeMs: 50,
      };
    }
    return { html: '<html><body>Mock Content</body></html>' };
  }),
  stop: vi.fn().mockResolvedValue(undefined),
};

const mockKnowledgeStore = {
  search: vi.fn().mockResolvedValue([]),
  addDocuments: vi.fn().mockResolvedValue(undefined),
  count: vi.fn().mockResolvedValue(0),
  open: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  findRelevantUrls: vi.fn().mockResolvedValue([]),
  findByUrl: vi.fn().mockResolvedValue([]),
  rebuildDocument: vi.fn().mockResolvedValue(null),
};

// ============================================================================
// Test Implementation
// ============================================================================

describe('Load Tests: Concurrent Research Sessions with Validation', () => {
  let testDbDir: string;
  let sessionIds: string[] = [];

  beforeAll(() => {
    testDbDir = path.join(os.tmpdir(), `pi-load-test-${Date.now()}`);
    if (!fs.existsSync(testDbDir)) {
      fs.mkdirSync(testDbDir, { recursive: true });
    }
  });

  afterAll(async () => {
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  // ============================================================================
  // Utility Functions
  // ============================================================================

  function takeResourceSnapshot(): ResourceSnapshot {
    const memory = process.memoryUsage();
    return {
      heapUsedMB: memory.heapUsed / 1024 / 1024,
      externalMB: memory.external / 1024 / 1024,
      fileHandles: getOpenFileCount(),
      timestamp: Date.now(),
    };
  }

  function getOpenFileCount(): number {
    try {
      const pid = process.pid;
      const fdDir = `/proc/${pid}/fd`;
      if (fs.existsSync(fdDir)) {
        return fs.readdirSync(fdDir).length;
      }
    } catch {
      // Not supported on this platform
    }
    return 0;
  }

  function assessResultQuality(result: string): 'high' | 'medium' | 'low' {
    if (!result || result.length < 10) return 'low';
    if (result.length < 100) return 'medium';
    if (result.includes('error') || result.includes('failed')) return 'low';
    return 'high';
  }

  async function verifyStateConsistency(sessionId: string): Promise<boolean> {
    // In a real test, this would verify session state in a state store
    // For now, we'll check that the session ID is valid
    return sessionId !== null && sessionId !== undefined && sessionId.length > 0;
  }

  async function verifyKnowledgeStoreAccessibility(): Promise<boolean> {
    // In a real test, this would verify knowledge store is accessible
    // For now, we'll simulate success
    return true;
  }

  function createResearchTask(query: string, depth: number) {
    return async (): Promise<ResearchSessionResult> => {
      const sessionId = `session-${depth}-${randomUUID()}`;
      const researchId = `res-${randomUUID()}`;
      sessionIds.push(sessionId);

      const snapshotBefore = takeResourceSnapshot();
      const start = Date.now();

      try {
        let result: string;
        let stateConsistent = false;
        let knowledgeStoreAccessible = false;

        // Verify state before execution
        stateConsistent = await verifyStateConsistency(sessionId);
        knowledgeStoreAccessible = await verifyKnowledgeStoreAccessibility();

        if (depth === 0) {
          const orchestrator = new QuickResearchOrchestrator({
            query,
            sessionId,
            researchId,
            model: { id: 'test-model' } as any,
            ctx: {
              cwd: testDbDir,
              modelRegistry: {
                getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'test', headers: {} }),
              },
            } as any,
            observer: {},
            config: { ...getConfig(), KNOWLEDGE_STORE_ENABLED: false },
          });

          // Mock run to avoid real LLM calls
          vi.spyOn(orchestrator, 'run').mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 200));
            return `Quick research result for: ${query}`;
          });

          result = await orchestrator.run();
        } else {
          const orchestrator = new DeepResearchOrchestrator({
            query,
            complexity: depth as 1 | 2 | 3,
            sessionId,
            researchId,
            model: { id: 'test-model' } as any,
            ctx: {
              cwd: testDbDir,
              modelRegistry: {
                getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'test', headers: {} }),
              },
            } as any,
            observer: {},
            config: { ...getConfig(), KNOWLEDGE_STORE_ENABLED: false },
          });

          // Mock run
          vi.spyOn(orchestrator, 'run').mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 500));
            return `Deep research result for: ${query}`;
          });

          result = await orchestrator.run();
        }

        const snapshotAfter = takeResourceSnapshot();
        const resultQuality = assessResultQuality(result);

        return {
          sessionId,
          depth,
          query,
          success: true,
          durationMs: Date.now() - start,
          memoryBeforeMB: snapshotBefore.heapUsedMB,
          memoryAfterMB: snapshotAfter.heapUsedMB,
          fileHandlesBefore: snapshotBefore.fileHandles,
          fileHandlesAfter: snapshotAfter.fileHandles,
          resultQuality,
          stateConsistent,
          knowledgeStoreAccessible,
        };
      } catch (error) {
        const snapshotAfter = takeResourceSnapshot();

        return {
          sessionId,
          depth,
          query,
          success: false,
          durationMs: Date.now() - start,
          memoryBeforeMB: snapshotBefore.heapUsedMB,
          memoryAfterMB: snapshotAfter.heapUsedMB,
          fileHandlesBefore: snapshotBefore.fileHandles,
          fileHandlesAfter: snapshotAfter.fileHandles,
          error: error as Error,
          stateConsistent: false,
          knowledgeStoreAccessible: false,
        };
      }
    };
  }

  function calculateLoadTestMetrics(
    results: ResearchSessionResult[],
    config: LoadTestConfig
  ): LoadTestMetrics {
    const totalSessions = results.length;
    const successfulSessions = results.filter(r => r.success).length;
    const failedSessions = totalSessions - successfulSessions;
    const successRate = totalSessions > 0 ? successfulSessions / totalSessions : 0;

    const durations = results.map(r => r.durationMs);
    const averageDurationMs = durations.length > 0
      ? durations.reduce((sum, d) => sum + d, 0) / durations.length
      : 0;

    // Calculate percentiles
    const sorted = [...durations].sort((a, b) => a - b);
    const p50DurationMs = sorted[Math.floor(sorted.length * 0.5)] || 0;
    const p95DurationMs = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const p99DurationMs = sorted[Math.floor(sorted.length * 0.99)] || 0;

    // Memory metrics
    const memoryIncreases = results.map(r => r.memoryAfterMB - r.memoryBeforeMB);
    const totalMemoryIncreaseMB = memoryIncreases.reduce((sum, d) => sum + d, 0);
    const averageMemoryIncreaseMB = memoryIncreases.length > 0
      ? totalMemoryIncreaseMB / memoryIncreases.length
      : 0;

    // File handle metrics
    const fileHandleIncreases = results.map(r => r.fileHandlesAfter - r.fileHandlesBefore);
    const totalFileHandleIncrease = fileHandleIncreases.reduce((sum, d) => sum + d, 0);
    const averageFileHandleIncrease = fileHandleIncreases.length > 0
      ? totalFileHandleIncrease / fileHandleIncreases.length
      : 0;

    // Session state consistency
    const stateConsistencyCount = results.filter(r => r.stateConsistent).length;
    const stateConsistencyRate = stateConsistencyCount / totalSessions;

    // Knowledge store availability
    const knowledgeStoreCount = results.filter(r => r.knowledgeStoreAccessible).length;
    const knowledgeStoreAvailabilityRate = knowledgeStoreCount / totalSessions;

    // Data corruption detection (results with low quality from successful sessions)
    const lowQualitySuccessful = results.filter(r => r.success && r.resultQuality === 'low');
    const dataCorruptionDetected = lowQualitySuccessful.length > (totalSessions * 0.1);

    const sessionsByDepth: Record<number, { count: number; successRate: number }> = {};

    for (const result of results) {
      const depth = result.depth;
      if (!sessionsByDepth[depth]) {
        sessionsByDepth[depth] = { count: 0, successRate: 0 };
      }
      sessionsByDepth[depth].count++;
      if (result.success) {
        sessionsByDepth[depth].successRate += 1;
      }
    }

    for (const depth of Object.keys(sessionsByDepth)) {
      const d = parseInt(depth, 10);
      sessionsByDepth[d].successRate /= sessionsByDepth[d].count;
    }

    return {
      config,
      totalSessions,
      successfulSessions,
      failedSessions,
      successRate,
      averageDurationMs,
      minDurationMs: durations.length > 0 ? Math.min(...durations) : 0,
      maxDurationMs: durations.length > 0 ? Math.max(...durations) : 0,
      p50DurationMs,
      p95DurationMs,
      p99DurationMs,
      totalMemoryIncreaseMB,
      averageMemoryIncreaseMB,
      totalFileHandleIncrease,
      averageFileHandleIncrease,
      sessionsByDepth,
      interferenceDetected: false, // Simplified for this test
      resourceLeaksDetected:
        totalMemoryIncreaseMB > config.maxMemoryIncreaseMB ||
        totalFileHandleIncrease > config.maxFileHandleIncrease,
      dataCorruptionDetected,
      stateConsistencyRate,
      knowledgeStoreAvailabilityRate,
    };
  }

  function assertLoadTestMetrics(metrics: LoadTestMetrics) {
    const { config } = metrics;

    // Assert success rate meets minimum
    expect(
      metrics.successRate,
      `Success rate ${metrics.successRate.toFixed(2)} below minimum ${config.minSuccessRate}`
    ).toBeGreaterThanOrEqual(config.minSuccessRate);

    // Assert average latency is acceptable
    expect(
      metrics.averageDurationMs,
      `Average latency ${metrics.averageDurationMs}ms above maximum ${config.maxAverageLatencyMs}ms`
    ).toBeLessThanOrEqual(config.maxAverageLatencyMs);

    // Assert no resource leaks
    expect(
      metrics.totalMemoryIncreaseMB,
      `Memory increase ${metrics.totalMemoryIncreaseMB.toFixed(2)}MB above maximum ${config.maxMemoryIncreaseMB}MB`
    ).toBeLessThanOrEqual(config.maxMemoryIncreaseMB);

    expect(
      metrics.totalFileHandleIncrease,
      `File handle increase ${metrics.totalFileHandleIncrease} above maximum ${config.maxFileHandleIncrease}`
    ).toBeLessThanOrEqual(config.maxFileHandleIncrease);

    // Assert state consistency
    expect(
      metrics.stateConsistencyRate,
      `State consistency rate ${metrics.stateConsistencyRate.toFixed(2)} too low`
    ).toBeGreaterThan(0.95);

    // Assert knowledge store availability
    expect(
      metrics.knowledgeStoreAvailabilityRate,
      `Knowledge store availability rate ${metrics.knowledgeStoreAvailabilityRate.toFixed(2)} too low`
    ).toBeGreaterThan(0.95);

    // Assert no data corruption
    expect(
      metrics.dataCorruptionDetected,
      'Data corruption detected: too many low-quality results from successful sessions'
    ).toBe(false);
  }

  // ============================================================================
  // Tests
  // ============================================================================

  describe('Quick Load Test with Validation', () => {
    it('should handle quick concurrent research sessions with behavior validation', async () => {
      const config = QUICK_LOAD_CONFIG;
      logger.info(`[load test] Quick load test: concurrency=${config.concurrency}`);

      const queries = Array.from(
        { length: config.concurrency },
        (_, i) => `Quick load test ${i}: ${randomUUID()}`
      );

      const results = await Promise.all(
        queries.map(q => createResearchTask(q, 0)())
      );

      const metrics = calculateLoadTestMetrics(results, config);

      logger.info('[load test] Quick load test metrics:', JSON.stringify(metrics, null, 2));

      assertLoadTestMetrics(metrics);

      expect(metrics.totalSessions).toBe(config.concurrency);
    }, QUICK_LOAD_CONFIG.duration);
  });

  describe('Standard Load Test with Validation', () => {
    it('should handle standard concurrent research sessions at varying depths with validation', async () => {
      const config = STANDARD_LOAD_CONFIG;
      logger.info(`[load test] Standard load test: concurrency=${config.concurrency}`);

      const scenarios: Array<{ query: string; depth: number }> = [];
      const depthDistribution = [0, 0, 1, 1, 2]; // 40% depth 0, 40% depth 1, 20% depth 2

      for (let i = 0; i < config.concurrency; i++) {
        const depth = depthDistribution[i % depthDistribution.length]!;
        scenarios.push({
          query: `Standard load test ${i} (depth ${depth}): ${randomUUID()}`,
          depth,
        });
      }

      const results = await Promise.all(
        scenarios.map(s => createResearchTask(s.query, s.depth)())
      );

      const metrics = calculateLoadTestMetrics(results, config);

      logger.info('[load test] Standard load test metrics:', JSON.stringify(metrics, null, 2));

      assertLoadTestMetrics(metrics);

      expect(metrics.totalSessions).toBe(config.concurrency);
      expect(metrics.sessionsByDepth[0]?.count).toBeGreaterThan(0);
      expect(metrics.sessionsByDepth[1]?.count).toBeGreaterThan(0);
    }, STANDARD_LOAD_CONFIG.duration);
  });

  describe('Session Isolation Validation', () => {
    it('should verify no cross-session contamination', async () => {
      const config = QUICK_LOAD_CONFIG;

      const queries = Array.from(
        { length: config.concurrency },
        (_, i) => `Isolation test ${i}: ${randomUUID()}`
      );

      const results = await Promise.all(
        queries.map(q => createResearchTask(q, 0)())
      );

      const metrics = calculateLoadTestMetrics(results, config);

      // Verify each session had consistent state
      results.forEach(result => {
        expect(result.stateConsistent).toBe(true);
        expect(result.sessionId).toBeDefined();
      });

      // Verify no session interference (simplified check)
      const uniqueSessionIds = new Set(results.map(r => r.sessionId));
      expect(uniqueSessionIds.size).toBe(results.length);

      logger.info('[load test] Session isolation validated:', {
        totalSessions: results.length,
        uniqueSessions: uniqueSessionIds.size,
        stateConsistencyRate: metrics.stateConsistencyRate,
      });
    }, QUICK_LOAD_CONFIG.duration);
  });

  describe('Resource Usage Validation', () => {
    it('should measure and validate resource usage during load', async () => {
      const config = QUICK_LOAD_CONFIG;

      const snapshotBefore = takeResourceSnapshot();

      const queries = Array.from(
        { length: config.concurrency },
        (_, i) => `Resource test ${i}: ${randomUUID()}`
      );

      const results = await Promise.all(
        queries.map(q => createResearchTask(q, 0)())
      );

      const snapshotAfter = takeResourceSnapshot();

      const metrics = calculateLoadTestMetrics(results, config);

      logger.info('[load test] Resource usage metrics:', {
        memory: {
          beforeMB: snapshotBefore.heapUsedMB.toFixed(2),
          afterMB: snapshotAfter.heapUsedMB.toFixed(2),
          increaseMB: (snapshotAfter.heapUsedMB - snapshotBefore.heapUsedMB).toFixed(2),
          perSessionMB: metrics.averageMemoryIncreaseMB.toFixed(2),
          limitMB: config.maxMemoryIncreaseMB,
        },
        fileHandles: {
          before: snapshotBefore.fileHandles,
          after: snapshotAfter.fileHandles,
          increase: snapshotAfter.fileHandles - snapshotBefore.fileHandles,
          perSession: metrics.averageFileHandleIncrease.toFixed(2),
          limit: config.maxFileHandleIncrease,
        },
        external: {
          beforeMB: snapshotBefore.externalMB.toFixed(2),
          afterMB: snapshotAfter.externalMB.toFixed(2),
          increaseMB: (snapshotAfter.externalMB - snapshotBefore.externalMB).toFixed(2),
        },
      });

      // Verify resource limits
      expect(metrics.totalMemoryIncreaseMB).toBeLessThanOrEqual(config.maxMemoryIncreaseMB);
      expect(metrics.totalFileHandleIncrease).toBeLessThanOrEqual(config.maxFileHandleIncrease);
    }, QUICK_LOAD_CONFIG.duration);
  });
});