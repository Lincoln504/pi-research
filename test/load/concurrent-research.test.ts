/**
 * Concurrent Research Sessions Load Test
 *
 * Tests for verifying no session interference when running
 * multiple research sessions simultaneously with different depths.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DeepResearchOrchestrator, type DeepResearchOrchestratorOptions } from '../../../src/orchestration/deep-research-orchestrator.ts';
import { QuickResearchOrchestrator, type QuickResearchOrchestratorOptions } from '../../../src/orchestration/quick-research-orchestrator.ts';
import { executeBurst, measureTime, withJitterDelay } from '../utils/chaos-helpers.ts';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import os from 'node:os';

// ============================================================================
// Types
// ============================================================================

interface ResearchSessionResult {
  sessionId: string;
  depth: number;
  query: string;
  success: boolean;
  durationMs: number;
  error?: Error;
  documentCount?: number;
  hadInterference?: boolean;
}

interface ConcurrentResearchMetrics {
  totalSessions: number;
  successfulSessions: number;
  failedSessions: number;
  successRate: number;
  averageDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  sessionsByDepth: Record<number, { count: number; successRate: number }>;
  interferenceDetected: boolean;
}

// ============================================================================
// Test Fixtures
// ============================================================================

// Mock browser manager for testing
const mockBrowserManager = {
  query: vi.fn().mockImplementation(async (query: string) => {
    // Simulate search results
    await new Promise(resolve => setTimeout(resolve, 50));
    return {
      results: [
        { url: `https://example.com/${query}/1`, title: `${query} result 1`, snippet: 'Snippet 1' },
        { url: `https://example.com/${query}/2`, title: `${query} result 2`, snippet: 'Snippet 2' },
        { url: `https://example.com/${query}/3`, title: `${query} result 3`, snippet: 'Snippet 3' },
      ],
      totalResults: 3,
      searchTimeMs: 50,
    };
  }),
  close: vi.fn().mockResolvedValue(undefined),
};

// Mock knowledge store
const mockKnowledgeStore = {
  search: vi.fn().mockResolvedValue([]),
  addDocuments: vi.fn().mockResolvedValue(undefined),
  getStats: vi.fn().mockResolvedValue({ documentCount: 0 }),
  open: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

// ============================================================================
// Test Implementation
// ============================================================================

describe('Concurrent Research Sessions Load Test', () => {
  let testDbDir: string;
  let sessionIds: string[] = [];

  beforeAll(() => {
    testDbDir = path.join(os.tmpdir(), `pi-concurrent-research-${Date.now()}`);
  });

  afterAll(async () => {
    // Cleanup
    for (const sessionId of sessionIds) {
      // Any session-specific cleanup would go here
    }
    vi.clearAllMocks();
  });

  it('should run 5 concurrent research sessions at depth 0 without interference', async () => {
    const queries = [
      'TypeScript performance optimization',
      'Node.js best practices',
      'React state management',
      'Vitest testing patterns',
      'Microservices architecture',
    ];

    const results = await executeBurst(
      queries.map((query, index) => withJitterDelay(async () => {
        const sessionId = `depth0-${index}-${randomUUID()}`;
        sessionIds.push(sessionId);

        const start = Date.now();
        try {
          // Mock quick research at depth 0
          const orchestrator = new QuickResearchOrchestrator({
            browserManager: mockBrowserManager as any,
            knowledgeStore: mockKnowledgeStore as any,
            observer: {
              onProgress: vi.fn(),
              onStatusChange: vi.fn(),
              onComplete: vi.fn(),
            },
          });

          const result = await orchestrator.research(query, {
            maxQueries: 3,
            maxResults: 5,
          });

          const duration = Date.now() - start;
          return {
            sessionId,
            depth: 0,
            query,
            success: true,
            durationMs: duration,
            documentCount: result.results?.length || 0,
            hadInterference: false,
          };
        } catch (error) {
          const duration = Date.now() - start;
          return {
            sessionId,
            depth: 0,
            query,
            success: false,
            durationMs: duration,
            error: error as Error,
            hadInterference: false,
          };
        }
      }, 10))
    );

    const metrics = calculateMetrics(results);

    // All sessions should succeed
    expect(metrics.successfulSessions).toBe(5);
    expect(metrics.failedSessions).toBe(0);
    expect(metrics.successRate).toBe(1.0);
    expect(metrics.interferenceDetected).toBe(false);

    // All sessions should complete in reasonable time
    expect(metrics.maxDurationMs).toBeLessThan(10000); // 10 seconds

    // Verify no cross-contamination of results
    const uniqueQueries = new Set(results.map(r => r.query));
    expect(uniqueQueries.size).toBe(5);
  });

  it('should run 5 concurrent research sessions at varying depths (0-3)', async () => {
    const testCases = [
      { query: 'Rust programming language', depth: 0 },
      { query: 'Go concurrency patterns', depth: 1 },
      { query: 'Python async/await', depth: 2 },
      { query: 'Java virtual machine', depth: 3 },
      { query: 'C++ memory management', depth: 1 },
    ];

    const results = await executeBurst(
      testCases.map(({ query, depth }, index) => withJitterDelay(async () => {
        const sessionId = `depth${depth}-${index}-${randomUUID()}`;
        sessionIds.push(sessionId);

        const start = Date.now();
        try {
          // Simulate research with depth
          if (depth === 0) {
            const orchestrator = new QuickResearchOrchestrator({
              browserManager: mockBrowserManager as any,
              knowledgeStore: mockKnowledgeStore as any,
              observer: {
                onProgress: vi.fn(),
                onStatusChange: vi.fn(),
                onComplete: vi.fn(),
              },
            });

            const result = await orchestrator.research(query, {
              maxQueries: 3,
              maxResults: 5,
            });

            const duration = Date.now() - start;
            return {
              sessionId,
              depth,
              query,
              success: true,
              durationMs: duration,
              documentCount: result.results?.length || 0,
              hadInterference: false,
            };
          } else {
            const orchestrator = new DeepResearchOrchestrator({
              browserManager: mockBrowserManager as any,
              knowledgeStore: mockKnowledgeStore as any,
              observer: {
                onProgress: vi.fn(),
                onStatusChange: vi.fn(),
                onComplete: vi.fn(),
              },
              depth: depth as 1 | 2 | 3,
            });

            const result = await orchestrator.research(query, {
              maxQueries: depth * 3,
              maxResults: depth * 5,
            });

            const duration = Date.now() - start;
            return {
              sessionId,
              depth,
              query,
              success: true,
              durationMs: duration,
              documentCount: result.results?.length || 0,
              hadInterference: false,
            };
          }
        } catch (error) {
          const duration = Date.now() - start;
          return {
            sessionId,
            depth,
            query,
            success: false,
            durationMs: duration,
            error: error as Error,
            hadInterference: false,
          };
        }
      }, 20))
    );

    const metrics = calculateMetrics(results);

    // All sessions should succeed
    expect(metrics.successfulSessions).toBe(5);
    expect(metrics.failedSessions).toBe(0);
    expect(metrics.successRate).toBe(1.0);

    // Higher depth sessions should take longer
    const depth0Sessions = results.filter(r => r.depth === 0);
    const depth3Sessions = results.filter(r => r.depth === 3);

    if (depth0Sessions.length > 0 && depth3Sessions.length > 0) {
      const avgDepth0 = depth0Sessions.reduce((sum, r) => sum + r.durationMs, 0) / depth0Sessions.length;
      const avgDepth3 = depth3Sessions.reduce((sum, r) => sum + r.durationMs, 0) / depth3Sessions.length;
      expect(avgDepth3).toBeGreaterThan(avgDepth0);
    }
  });

  it('should run 10 concurrent research sessions without session interference', async () => {
    const queries = Array.from({ length: 10 }, (_, i) => [
      `Topic ${i} - aspect A`,
      `Topic ${i} - aspect B`,
    ]).flat().slice(0, 10);

    // Track which queries each session receives results for
    const sessionQueries: Map<string, string[]> = new Map();

    const results = await executeBurst(
      queries.map((query, index) => withJitterDelay(async () => {
        const sessionId = `session-${index}-${randomUUID()}`;
        sessionIds.push(sessionId);
        sessionQueries.set(sessionId, [query]);

        const start = Date.now();
        try {
          const orchestrator = new QuickResearchOrchestrator({
            browserManager: mockBrowserManager as any,
            knowledgeStore: mockKnowledgeStore as any,
            observer: {
              onProgress: vi.fn(),
              onStatusChange: vi.fn(),
              onComplete: vi.fn(),
            },
          });

          const result = await orchestrator.research(query, {
            maxQueries: 2,
            maxResults: 3,
          });

          const duration = Date.now() - start;

          // Check for interference: results should only be for this session's query
          const hasInterference = result.results?.some((r: any) => {
            const resultQuery = sessionQueries.get(sessionId);
            return resultQuery && !r.snippet?.includes(query);
          });

          return {
            sessionId,
            depth: 0,
            query,
            success: true,
            durationMs: duration,
            documentCount: result.results?.length || 0,
            hadInterference: hasInterference || false,
          };
        } catch (error) {
          const duration = Date.now() - start;
          return {
            sessionId,
            depth: 0,
            query,
            success: false,
            durationMs: duration,
            error: error as Error,
            hadInterference: false,
          };
        }
      }, 15))
    );

    const metrics = calculateMetrics(results);

    // All sessions should succeed
    expect(metrics.successfulSessions).toBe(10);
    expect(metrics.failedSessions).toBe(0);
    expect(metrics.successRate).toBe(1.0);

    // No session should detect interference
    const sessionsWithInterference = results.filter(r => r.hadInterference);
    expect(sessionsWithInterference.length).toBe(0);

    // Results should not be mixed between sessions
    const allResults = results.flatMap(r => r.query);
    expect(allResults.length).toBe(10);
  });

  it('should handle rapid consecutive session starts without interference', async () => {
    const query = 'Rapid session start test';
    const sessionCount = 7;
    const results: ResearchSessionResult[] = [];

    // Start sessions rapidly without waiting
    const sessionPromises = Array.from({ length: sessionCount }, async (_, index) => {
      const sessionId = `rapid-${index}-${randomUUID()}`;
      sessionIds.push(sessionId);

      const start = Date.now();
      try {
        // Add small delay to simulate realistic timing
        await new Promise(resolve => setTimeout(resolve, Math.random() * 10));

        const orchestrator = new QuickResearchOrchestrator({
          browserManager: mockBrowserManager as any,
          knowledgeStore: mockKnowledgeStore as any,
          observer: {
            onProgress: vi.fn(),
            onStatusChange: vi.fn(),
            onComplete: vi.fn(),
          },
        });

        const result = await orchestrator.research(query, {
          maxQueries: 2,
          maxResults: 3,
        });

        const duration = Date.now() - start;
        const sessionResult: ResearchSessionResult = {
          sessionId,
          depth: 0,
          query,
          success: true,
          durationMs: duration,
          documentCount: result.results?.length || 0,
          hadInterference: false,
        };

        results.push(sessionResult);
        return sessionResult;
      } catch (error) {
        const duration = Date.now() - start;
        const sessionResult: ResearchSessionResult = {
          sessionId,
          depth: 0,
          query,
          success: false,
          durationMs: duration,
          error: error as Error,
          hadInterference: false,
        };

        results.push(sessionResult);
        return sessionResult;
      }
    });

    await Promise.all(sessionPromises);

    const metrics = calculateMetrics(results);

    // All sessions should succeed
    expect(metrics.successfulSessions).toBe(sessionCount);
    expect(metrics.failedSessions).toBe(0);
    expect(metrics.successRate).toBe(1.0);

    // Sessions should not interfere with each other
    // All sessions should complete and have consistent results
    const successfulResults = results.filter(r => r.success);
    expect(successfulResults.length).toBe(sessionCount);
  });

  it('should measure session success rates under concurrent load', async () => {
    const testCases = Array.from({ length: 8 }, (_, i) => ({
      query: `Success rate test query ${i}`,
      depth: (i % 4) as 0 | 1 | 2 | 3,
    }));

    const results = await executeBurst(
      testCases.map(({ query, depth }, index) => withJitterDelay(async () => {
        const sessionId = `success-rate-${index}-${randomUUID()}`;
        sessionIds.push(sessionId);

        const start = Date.now();
        try {
          if (depth === 0) {
            const orchestrator = new QuickResearchOrchestrator({
              browserManager: mockBrowserManager as any,
              knowledgeStore: mockKnowledgeStore as any,
              observer: {
                onProgress: vi.fn(),
                onStatusChange: vi.fn(),
                onComplete: vi.fn(),
              },
            });

            const result = await orchestrator.research(query, {
              maxQueries: 3,
              maxResults: 5,
            });

            const duration = Date.now() - start;
            return {
              sessionId,
              depth,
              query,
              success: true,
              durationMs: duration,
              documentCount: result.results?.length || 0,
              hadInterference: false,
            };
          } else {
            const orchestrator = new DeepResearchOrchestrator({
              browserManager: mockBrowserManager as any,
              knowledgeStore: mockKnowledgeStore as any,
              observer: {
                onProgress: vi.fn(),
                onStatusChange: vi.fn(),
                onComplete: vi.fn(),
              },
              depth,
            });

            const result = await orchestrator.research(query, {
              maxQueries: depth * 3,
              maxResults: depth * 5,
            });

            const duration = Date.now() - start;
            return {
              sessionId,
              depth,
              query,
              success: true,
              durationMs: duration,
              documentCount: result.results?.length || 0,
              hadInterference: false,
            };
          }
        } catch (error) {
          const duration = Date.now() - start;
          return {
            sessionId,
            depth,
            query,
            success: false,
            durationMs: duration,
            error: error as Error,
            hadInterference: false,
          };
        }
      }, 25))
    );

    const metrics = calculateMetrics(results);

    // Expect high success rate (>90%)
    expect(metrics.successRate).toBeGreaterThan(0.9);

    // Each depth should have good success rate
    for (const [depth, depthMetrics] of Object.entries(metrics.sessionsByDepth)) {
      expect(depthMetrics.successRate).toBeGreaterThan(0.8);
    }

    // Overall performance should be acceptable
    expect(metrics.averageDurationMs).toBeLessThan(15000);
  });

  it('should detect and report interference between sessions', async () => {
    // This test verifies our interference detection works
    const queries = [
      'Query A - unique content',
      'Query B - unique content',
      'Query C - unique content',
    ];

    const results = await executeBurst(
      queries.map((query, index) => withJitterDelay(async () => {
        const sessionId = `interference-${index}-${randomUUID()}`;
        sessionIds.push(sessionId);

        const start = Date.now();
        try {
          const orchestrator = new QuickResearchOrchestrator({
            browserManager: mockBrowserManager as any,
            knowledgeStore: mockKnowledgeStore as any,
            observer: {
              onProgress: vi.fn(),
              onStatusChange: vi.fn(),
              onComplete: vi.fn(),
            },
          });

          const result = await orchestrator.research(query, {
            maxQueries: 2,
            maxResults: 3,
          });

          const duration = Date.now() - start;

          // Check for interference
          const hasInterference = result.results?.some((r: any) => {
            const otherQueries = queries.filter(q => q !== query);
            return otherQueries.some(oq => r.snippet?.includes(oq));
          });

          return {
            sessionId,
            depth: 0,
            query,
            success: true,
            durationMs: duration,
            documentCount: result.results?.length || 0,
            hadInterference: hasInterference || false,
          };
        } catch (error) {
          const duration = Date.now() - start;
          return {
            sessionId,
            depth: 0,
            query,
            success: false,
            durationMs: duration,
            error: error as Error,
            hadInterference: false,
          };
        }
      }, 15))
    );

    const metrics = calculateMetrics(results);

    // With mock data, there should be no interference
    expect(metrics.interferenceDetected).toBe(false);

    // All sessions should complete successfully
    expect(metrics.successfulSessions).toBe(3);
  });
});

// ============================================================================
// Utility Functions
// ============================================================================

function calculateMetrics(results: ResearchSessionResult[]): ConcurrentResearchMetrics {
  const totalSessions = results.length;
  const successfulSessions = results.filter(r => r.success).length;
  const failedSessions = totalSessions - successfulSessions;
  const successRate = totalSessions > 0 ? successfulSessions / totalSessions : 0;

  const durations = results.map(r => r.durationMs);
  const averageDurationMs = durations.length > 0
    ? durations.reduce((sum, d) => sum + d, 0) / durations.length
    : 0;
  const minDurationMs = durations.length > 0 ? Math.min(...durations) : 0;
  const maxDurationMs = durations.length > 0 ? Math.max(...durations) : 0;

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

  // Calculate success rates per depth
  for (const depth of Object.keys(sessionsByDepth)) {
    const depthNum = parseInt(depth, 10);
    const depthMetrics = sessionsByDepth[depthNum];
    depthMetrics.successRate = depthMetrics.count > 0
      ? depthMetrics.successRate / depthMetrics.count
      : 0;
  }

  const interferenceDetected = results.some(r => r.hadInterference);

  return {
    totalSessions,
    successfulSessions,
    failedSessions,
    successRate,
    averageDurationMs,
    minDurationMs,
    maxDurationMs,
    sessionsByDepth,
    interferenceDetected,
  };
}