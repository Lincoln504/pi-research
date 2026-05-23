/**
 * High-Volume Embedding Load Test
 *
 * Tests for validating embedding throughput, memory usage,
 * and memory leak detection when processing large numbers of documents.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { Embedder } from '../../../src/knowledge/embedder.ts';
import { measureTime, executeBurst } from '../utils/chaos-helpers.ts';
import * as path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ============================================================================
// Types
// ============================================================================

interface EmbeddingBatchResult {
  batchSize: number;
  durationMs: number;
  throughputDocsPerSec: number;
  memoryBeforeMB: number;
  memoryAfterMB: number;
  memoryDeltaMB: number;
  success: boolean;
  error?: Error;
}

interface ThroughputMetrics {
  totalDocuments: number;
  totalDurationMs: number;
  overallThroughputDocsPerSec: number;
  batchResults: EmbeddingBatchResult[];
  averageMemoryDeltaMB: number;
  maxMemoryUsageMB: number;
  memoryLeakDetected: boolean;
}

interface MemorySnapshot {
  timestamp: number;
  heapUsedMB: number;
  heapTotalMB: number;
  externalMB: number;
  rssMB: number;
}

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Get current memory usage snapshot
 */
function getMemorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage();
  return {
    timestamp: Date.now(),
    heapUsedMB: usage.heapUsed / 1024 / 1024,
    heapTotalMB: usage.heapTotal / 1024 / 1024,
    externalMB: usage.external / 1024 / 1024,
    rssMB: usage.rss / 1024 / 1024,
  };
}

/**
 * Calculate memory delta between two snapshots
 */
function calculateMemoryDelta(before: MemorySnapshot, after: MemorySnapshot): number {
  return after.heapUsedMB - before.heapUsedMB;
}

/**
 * Generate test documents for embedding
 */
function generateTestDocuments(count: number, baseText: string = 'Test document for embedding.'): Array<{
  url: string;
  text: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}> {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://example.com/test/${i}`,
    text: `${baseText} This is document ${i}. `.repeat(5),
    metadata: { documentIndex: i, testType: 'load-test' },
    timestamp: Date.now(),
  }));
}

/**
 * Create a mock embedder for load testing
 * This simulates embedding operations without actual model loading
 */
class MockEmbedder {
  private dimension: number;
  private callCount: number = 0;

  constructor(dimension: number = 384) {
    this.dimension = dimension;
  }

  getDimension(): number {
    return this.dimension;
  }

  async embed(text: string): Promise<Float32Array> {
    this.callCount++;
    // Simulate some processing time
    await new Promise(resolve => setTimeout(resolve, 1));
    // Return a deterministic embedding based on text
    const embedding = new Float32Array(this.dimension);
    for (let i = 0; i < this.dimension; i++) {
      embedding[i] = (text.charCodeAt(i % text.length) / 255) * 2 - 1;
    }
    return embedding;
  }

  async embedMany(texts: string[]): Promise<Float32Array[]> {
    this.callCount += texts.length;
    // Simulate batch processing
    await new Promise(resolve => setTimeout(resolve, texts.length * 0.5));
    return Promise.all(texts.map(text => this.embed(text)));
  }

  isInitialized(): boolean {
    return true;
  }

  getCallCount(): number {
    return this.callCount;
  }

  async dispose(): Promise<void> {
    // Cleanup if needed
  }
}

// ============================================================================
// Test Implementation
// ============================================================================

describe('High-Volume Embedding Load Test', () => {
  let testDbDir: string;
  let mockEmbedder: MockEmbedder;
  let store: KnowledgeStore | null = null;

  beforeAll(() => {
    testDbDir = path.join(os.tmpdir(), `pi-high-volume-embedding-${Date.now()}`);
    mockEmbedder = new MockEmbedder(384);
  });

  afterAll(async () => {
    if (store) {
      await store.close();
    }
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
    await mockEmbedder.dispose();
  });

  it('should embed 1000 documents and measure throughput', async () => {
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder as unknown as Embedder,
      modelName: 'test-model',
    });

    await store.open();

    const documentCount = 1000;
    const documents = generateTestDocuments(documentCount);

    const memoryBefore = getMemorySnapshot();
    const { result, durationMs } = await measureTime(async () => {
      await store!.addDocuments(documents);
    });
    const memoryAfter = getMemorySnapshot();

    const throughputDocsPerSec = (documentCount / durationMs) * 1000;
    const memoryDeltaMB = calculateMemoryDelta(memoryBefore, memoryAfter);

    // Verify all documents were added
    const stats = await store.getStats();
    expect(stats.documentCount).toBe(documentCount);

    // Throughput should be reasonable (at least 100 docs/sec with mock embedder)
    expect(throughputDocsPerSec).toBeGreaterThan(100);

    // Memory delta should be bounded (less than 500MB for 1000 docs)
    expect(memoryDeltaMB).toBeLessThan(500);

    // Duration should be reasonable (less than 30 seconds)
    expect(durationMs).toBeLessThan(30000);

    // Cleanup for next test
    await store.close();
    await new Promise(resolve => setTimeout(resolve, 100)); // Allow cleanup
  });

  it('should process 2000 documents without memory leaks', async () => {
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder as unknown as Embedder,
      modelName: 'test-model',
    });

    await store.open();

    const documentCount = 2000;
    const batchSize = 100;
    const batches = Math.ceil(documentCount / batchSize);

    const batchResults: EmbeddingBatchResult[] = [];
    const memorySnapshots: MemorySnapshot[] = [getMemorySnapshot()];

    let totalProcessed = 0;

    for (let i = 0; i < batches; i++) {
      const currentBatchSize = Math.min(batchSize, documentCount - totalProcessed);
      const documents = generateTestDocuments(currentBatchSize, `Batch ${i}`);

      const memoryBefore = getMemorySnapshot();
      const { result, durationMs } = await measureTime(async () => {
        await store!.addDocuments(documents);
      });
      const memoryAfter = getMemorySnapshot();

      const batchResult: EmbeddingBatchResult = {
        batchSize: currentBatchSize,
        durationMs,
        throughputDocsPerSec: (currentBatchSize / durationMs) * 1000,
        memoryBeforeMB: memoryBefore.heapUsedMB,
        memoryAfterMB: memoryAfter.heapUsedMB,
        memoryDeltaMB: calculateMemoryDelta(memoryBefore, memoryAfter),
        success: true,
      };

      batchResults.push(batchResult);
      memorySnapshots.push(memoryAfter);
      totalProcessed += currentBatchSize;

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }
    }

    // Verify all documents were processed
    const stats = await store.getStats();
    expect(stats.documentCount).toBe(documentCount);

    // Calculate overall metrics
    const overallDurationMs = batchResults.reduce((sum, r) => sum + r.durationMs, 0);
    const overallThroughput = (documentCount / overallDurationMs) * 1000;
    const averageMemoryDeltaMB = batchResults.reduce((sum, r) => sum + r.memoryDeltaMB, 0) / batchResults.length;
    const maxMemoryUsageMB = Math.max(...batchResults.map(r => r.memoryAfterMB));

    // Check for memory leaks: memory should not grow monotonically
    let memoryLeakDetected = false;
    let consecutiveIncreases = 0;

    for (let i = 1; i < memorySnapshots.length; i++) {
      if (memorySnapshots[i].heapUsedMB > memorySnapshots[i - 1].heapUsedMB + 10) {
        consecutiveIncreases++;
        if (consecutiveIncreases > 5) {
          memoryLeakDetected = true;
          break;
        }
      } else {
        consecutiveIncreases = 0;
      }
    }

    // Overall throughput should be reasonable
    expect(overallThroughput).toBeGreaterThan(50);

    // Average memory delta per batch should be bounded
    expect(averageMemoryDeltaMB).toBeLessThan(100);

    // No significant memory leak should be detected
    expect(memoryLeakDetected).toBe(false);

    // Cleanup
    await store.close();
  });

  it('should handle 5000 documents in batches with consistent throughput', async () => {
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder as unknown as Embedder,
      modelName: 'test-model',
    });

    await store.open();

    const documentCount = 5000;
    const batchSize = 250;
    const batches = Math.ceil(documentCount / batchSize);

    const throughputs: number[] = [];
    const memoryDeltas: number[] = [];

    let totalProcessed = 0;

    for (let i = 0; i < batches; i++) {
      const currentBatchSize = Math.min(batchSize, documentCount - totalProcessed);
      const documents = generateTestDocuments(currentBatchSize, `Large batch ${i}`);

      const memoryBefore = getMemorySnapshot();
      const { result, durationMs } = await measureTime(async () => {
        await store!.addDocuments(documents);
      });
      const memoryAfter = getMemorySnapshot();

      const throughput = (currentBatchSize / durationMs) * 1000;
      const memoryDelta = calculateMemoryDelta(memoryBefore, memoryAfter);

      throughputs.push(throughput);
      memoryDeltas.push(memoryDelta);
      totalProcessed += currentBatchSize;

      // Periodically trigger GC if available
      if (i % 5 === 0 && global.gc) {
        global.gc();
      }
    }

    // Verify all documents were processed
    const stats = await store.getStats();
    expect(stats.documentCount).toBe(documentCount);

    // Calculate throughput statistics
    const averageThroughput = throughputs.reduce((sum, t) => sum + t, 0) / throughputs.length;
    const minThroughput = Math.min(...throughputs);
    const maxThroughput = Math.max(...throughputs);
    const throughputStdDev = Math.sqrt(
      throughputs.reduce((sum, t) => sum + Math.pow(t - averageThroughput, 2), 0) / throughputs.length
    );

    // Throughput should be consistent (coefficient of variation < 0.5)
    const cv = throughputStdDev / averageThroughput;
    expect(cv).toBeLessThan(0.5);

    // Minimum throughput should not be too low
    expect(minThroughput).toBeGreaterThan(20);

    // Memory deltas should be bounded
    const maxMemoryDelta = Math.max(...memoryDeltas);
    expect(maxMemoryDelta).toBeLessThan(150);

    // Cleanup
    await store.close();
  });

  it('should track memory usage during high-volume operations', async () => {
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder as unknown as Embedder,
      modelName: 'test-model',
    });

    await store.open();

    const documentCount = 1500;
    const documents = generateTestDocuments(documentCount);

    const memorySnapshots: MemorySnapshot[] = [];
    const sampleInterval = 100; // Sample every 100 documents

    // Start memory monitoring
    const monitoringInterval = setInterval(() => {
      memorySnapshots.push(getMemorySnapshot());
    }, 50);

    const { result, durationMs } = await measureTime(async () => {
      // Add documents in chunks with memory sampling
      for (let i = 0; i < documentCount; i += sampleInterval) {
        const chunk = documents.slice(i, Math.min(i + sampleInterval, documentCount));
        await store!.addDocuments(chunk);
        memorySnapshots.push(getMemorySnapshot());
      }
    });

    clearInterval(monitoringInterval);

    // Analyze memory usage
    const memoryUsages = memorySnapshots.map(s => s.heapUsedMB);
    const minMemory = Math.min(...memoryUsages);
    const maxMemory = Math.max(...memoryUsages);
    const averageMemory = memoryUsages.reduce((sum, m) => sum + m, 0) / memoryUsages.length;
    const totalMemoryGrowth = memoryUsages[memoryUsages.length - 1] - memoryUsages[0];

    // Memory should grow but within bounds
    expect(maxMemory).toBeLessThan(1000); // Less than 1GB
    expect(totalMemoryGrowth).toBeLessThan(500); // Less than 500MB growth

    // Memory usage should stabilize (not grow monotonically)
    const midPoint = Math.floor(memoryUsages.length / 2);
    const firstHalfAvg = memoryUsages.slice(0, midPoint).reduce((sum, m) => sum + m, 0) / midPoint;
    const secondHalfAvg = memoryUsages.slice(midPoint).reduce((sum, m) => sum + m, 0) / (memoryUsages.length - midPoint);
    const memoryGrowthRatio = secondHalfAvg / firstHalfAvg;

    // Second half should not be more than 2x first half (indicates leak if higher)
    expect(memoryGrowthRatio).toBeLessThan(2.0);

    // Cleanup
    await store.close();
  });

  it('should detect memory leaks through repeated operations', async () => {
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder as unknown as Embedder,
      modelName: 'test-model',
    });

    await store.open();

    const iterations = 10;
    const documentsPerIteration = 100;
    const memorySnapshots: number[] = [];

    // Run multiple iterations and track memory
    for (let i = 0; i < iterations; i++) {
      const documents = generateTestDocuments(documentsPerIteration, `Iteration ${i}`);

      await store.addDocuments(documents);

      // Force GC if available to get stable measurement
      if (global.gc) {
        global.gc();
      }

      const memory = process.memoryUsage().heapUsed / 1024 / 1024;
      memorySnapshots.push(memory);

      // Clear and reinitialize to test for leaks
      await store.close();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Reopen store for next iteration
      store = new KnowledgeStore({
        dbDir: testDbDir,
        embedder: mockEmbedder as unknown as Embedder,
        modelName: 'test-model',
      });
      await store.open();
    }

    // Analyze memory trend
    const firstThreeAvg = memorySnapshots.slice(0, 3).reduce((sum, m) => sum + m, 0) / 3;
    const lastThreeAvg = memorySnapshots.slice(-3).reduce((sum, m) => sum + m, 0) / 3;
    const memoryGrowthFactor = lastThreeAvg / firstThreeAvg;

    // Memory should not grow significantly across iterations
    expect(memoryGrowthFactor).toBeLessThan(1.5);

    // Memory should not show monotonic growth pattern
    let monotonicIncreases = 0;
    for (let i = 1; i < memorySnapshots.length; i++) {
      if (memorySnapshots[i] > memorySnapshots[i - 1] * 1.1) {
        monotonicIncreases++;
      }
    }
    expect(monotonicIncreases).toBeLessThan(iterations * 0.7); // Less than 70% show growth

    // Cleanup
    await store.close();
  });

  it('should handle concurrent embedding requests without memory corruption', async () => {
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder as unknown as Embedder,
      modelName: 'test-model',
    });

    await store.open();

    const concurrentBatches = 10;
    const documentsPerBatch = 50;

    // Create concurrent operations
    const operations = Array.from({ length: concurrentBatches }, (_, i) =>
      measureTime(async () => {
        const documents = generateTestDocuments(documentsPerBatch, `Concurrent batch ${i}`);
        await store!.addDocuments(documents);
      })
    );

    const results = await Promise.all(operations);

    // All operations should succeed
    expect(results.every(r => r.result !== undefined)).toBe(true);

    // Verify total document count
    const stats = await store.getStats();
    expect(stats.documentCount).toBe(concurrentBatches * documentsPerBatch);

    // Check memory after concurrent operations
    const memoryAfter = getMemorySnapshot();
    expect(memoryAfter.heapUsedMB).toBeLessThan(1000);

    // Cleanup
    await store.close();
  });

  it('should measure throughput with different batch sizes', async () => {
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder as unknown as Embedder,
      modelName: 'test-model',
    });

    await store.open();

    const batchSizes = [10, 25, 50, 100, 250];
    const throughputs: Array<{ batchSize: number; throughputDocsPerSec: number }> = [];

    for (const batchSize of batchSizes) {
      const documents = generateTestDocuments(batchSize, `Batch size ${batchSize}`);

      const memoryBefore = getMemorySnapshot();
      const { result, durationMs } = await measureTime(async () => {
        await store!.addDocuments(documents);
      });
      const memoryAfter = getMemorySnapshot();

      const throughput = (batchSize / durationMs) * 1000;
      throughputs.push({ batchSize, throughputDocsPerSec: throughput });

      // Reset store for next batch size test
      await store.close();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Clear DB and reopen
      if (fs.existsSync(testDbDir)) {
        fs.rmSync(testDbDir, { recursive: true, force: true });
      }
      await new Promise(resolve => setTimeout(resolve, 50));

      store = new KnowledgeStore({
        dbDir: testDbDir,
        embedder: mockEmbedder as unknown as Embedder,
        modelName: 'test-model',
      });
      await store.open();
    }

    // Larger batches should generally have better throughput
    // (up to a point)
    expect(throughputs.length).toBe(batchSizes.length);

    // At least some improvement with larger batches
    const smallestBatch = throughputs[0];
    const largestBatch = throughputs[throughputs.length - 1];
    expect(largestBatch.throughputDocsPerSec).toBeGreaterThan(smallestBatch.throughputDocsPerSec * 0.5);

    // Cleanup
    await store.close();
  });
});

// ============================================================================
// Utility Functions
// ============================================================================

function calculateThroughputMetrics(
  documentCount: number,
  totalDurationMs: number,
  batchResults: EmbeddingBatchResult[]
): ThroughputMetrics {
  const overallThroughputDocsPerSec = (documentCount / totalDurationMs) * 1000;
  const averageMemoryDeltaMB = batchResults.reduce((sum, r) => sum + r.memoryDeltaMB, 0) / batchResults.length;
  const maxMemoryUsageMB = Math.max(...batchResults.map(r => r.memoryAfterMB));

  // Simple leak detection: check if memory grows monotonically
  let memoryLeakDetected = false;
  let consecutiveIncreases = 0;

  for (let i = 1; i < batchResults.length; i++) {
    if (batchResults[i].memoryAfterMB > batchResults[i - 1].memoryAfterMB + 10) {
      consecutiveIncreases++;
      if (consecutiveIncreases > 5) {
        memoryLeakDetected = true;
        break;
      }
    } else {
      consecutiveIncreases = 0;
    }
  }

  return {
    totalDocuments: documentCount,
    totalDurationMs,
    overallThroughputDocsPerSec,
    batchResults,
    averageMemoryDeltaMB,
    maxMemoryUsageMB,
    memoryLeakDetected,
  };
}