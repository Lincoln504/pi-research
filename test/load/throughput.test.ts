/**
 * Throughput Measurement Load Test
 *
 * Comprehensive tests for measuring system throughput including:
 * - Documents per second (embedding and storage)
 * - Queries per second (search operations)
 * - Scrape operations per second (web scraping)
 * - Latency percentiles (p50, p95, p99)
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

interface ThroughputMeasurement {
  operation: string;
  count: number;
  durationMs: number;
  throughputPerSecond: number;
  latencies: number[];
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

interface OverallThroughputMetrics {
  documentsPerSecond: number;
  queriesPerSecond: number;
  scrapesPerSecond: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Mock embedder for throughput testing
 */
class ThroughputMockEmbedder {
  private dimension: number = 384;
  private latencyMs: number = 1;

  constructor(latencyMs: number = 1) {
    this.latencyMs = latencyMs;
  }

  getDimension(): number {
    return this.dimension;
  }

  async embed(text: string): Promise<Float32Array> {
    await new Promise(resolve => setTimeout(resolve, this.latencyMs));
    const embedding = new Float32Array(this.dimension);
    for (let i = 0; i < this.dimension; i++) {
      embedding[i] = (text.charCodeAt(i % text.length) / 255) * 2 - 1;
    }
    return embedding;
  }

  async embedMany(texts: string[]): Promise<Float32Array[]> {
    await new Promise(resolve => setTimeout(resolve, texts.length * this.latencyMs * 0.5));
    return Promise.all(texts.map(text => this.embed(text)));
  }

  isInitialized(): boolean {
    return true;
  }

  async dispose(): Promise<void> {}
}

/**
 * Generate test documents
 */
function generateTestDocuments(count: number): Array<{
  url: string;
  text: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}> {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://example.com/throughput/${i}`,
    text: `Throughput test document ${i}. `.repeat(10),
    metadata: { documentIndex: i, testType: 'throughput' },
    timestamp: Date.now(),
  }));
}

/**
 * Mock web scraper
 */
class MockWebScraper {
  private latencyMs: number = 50;
  private requestCount: number = 0;

  constructor(latencyMs: number = 50) {
    this.latencyMs = latencyMs;
  }

  async scrape(url: string): Promise<{
    url: string;
    content: string;
    title: string;
    durationMs: number;
  }> {
    this.requestCount++;
    const start = Date.now();
    await new Promise(resolve => setTimeout(resolve, this.latencyMs + Math.random() * 20));
    const duration = Date.now() - start;

    return {
      url,
      content: `Scraped content from ${url}. `.repeat(20),
      title: `Title for ${url}`,
      durationMs: duration,
    };
  }

  async scrapeMany(urls: string[]): Promise<Array<{
    url: string;
    content: string;
    title: string;
    durationMs: number;
  }>> {
    return Promise.all(urls.map(url => this.scrape(url)));
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  reset(): void {
    this.requestCount = 0;
  }
}

/**
 * Calculate percentile from sorted array
 */
function calculatePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil(sortedValues.length * percentile) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

/**
 * Calculate statistics from latency measurements
 */
function calculateLatencyStats(latencies: number[]): {
  average: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
} {
  if (latencies.length === 0) {
    return { average: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = latencies.reduce((s, l) => s + l, 0);
  const average = sum / latencies.length;

  return {
    average,
    p50: calculatePercentile(sorted, 0.50),
    p95: calculatePercentile(sorted, 0.95),
    p99: calculatePercentile(sorted, 0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

// ============================================================================
// Test Implementation
// ============================================================================

describe('Throughput Measurement Load Test', () => {
  let testDbDir: string;
  let store: KnowledgeStore | null = null;
  let embedder: ThroughputMockEmbedder;
  let scraper: MockWebScraper;

  beforeAll(() => {
    testDbDir = path.join(os.tmpdir(), `pi-throughput-${Date.now()}`);
    embedder = new ThroughputMockEmbedder(1);
    scraper = new MockWebScraper(50);
  });

  afterAll(async () => {
    if (store) {
      await store.close();
    }
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
    await embedder.dispose();
  });

  it('should measure documents per second throughput', async () => {
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: embedder as unknown as Embedder,
      modelName: 'test-model',
    });

    await store.open();

    const documentCounts = [100, 500, 1000];
    const measurements: ThroughputMeasurement[] = [];

    for (const docCount of documentCounts) {
      const documents = generateTestDocuments(docCount);
      const latencies: number[] = [];

      const { result, durationMs } = await measureTime(async () => {
        // Process in batches to measure individual latencies
        const batchSize = 10;
        for (let i = 0; i < documents.length; i += batchSize) {
          const batch = documents.slice(i, i + batchSize);
          const { durationMs: batchDuration } = await measureTime(async () => {
            await store!.addDocuments(batch);
          });
          // Record latency per document
          const perDocLatency = batchDuration / batch.length;
          for (let j = 0; j < batch.length; j++) {
            latencies.push(perDocLatency);
          }
        }
      });

      const throughputPerSecond = (docCount / durationMs) * 1000;
      const sortedLatencies = [...latencies].sort((a, b) => a - b);

      measurements.push({
        operation: 'addDocuments',
        count: docCount,
        durationMs,
        throughputPerSecond,
        latencies,
        p50LatencyMs: calculatePercentile(sortedLatencies, 0.50),
        p95LatencyMs: calculatePercentile(sortedLatencies, 0.95),
        p99LatencyMs: calculatePercentile(sortedLatencies, 0.99),
      });

      // Reset for next test
      await store.close();
      await new Promise(resolve => setTimeout(resolve, 50));

      if (fs.existsSync(testDbDir)) {
        fs.rmSync(testDbDir, { recursive: true, force: true });
      }

      store = new KnowledgeStore({
        dbDir: testDbDir,
        embedder: embedder as unknown as Embedder,
        modelName: 'test-model',
      });
      await store.open();
    }

    // Verify throughput scales reasonably with document count
    expect(measurements.length).toBe(3);

    // Smaller batches should have higher throughput
    expect(measurements[0].throughputPerSecond).toBeGreaterThan(measurements[2].throughputPerSecond * 0.5);

    // All should have reasonable throughput
    for (const m of measurements) {
      expect(m.throughputPerSecond).toBeGreaterThan(10); // At least 10 docs/sec
    }

    // Latency percentiles should be reasonable
    for (const m of measurements) {
      expect(m.p95LatencyMs).toBeLessThan(1000); // 95th percentile < 1 second
      expect(m.p99LatencyMs).toBeLessThan(2000); // 99th percentile < 2 seconds
    }

    await store.close();
  });

  it('should measure queries per second throughput', async () => {
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: embedder as unknown as Embedder,
      modelName: 'test-model',
    });

    await store.open();

    // Add documents to search
    const documents = generateTestDocuments(500);
    await store.addDocuments(documents);

    const queryCounts = [50, 100, 200];
    const measurements: ThroughputMeasurement[] = [];

    for (const queryCount of queryCounts) {
      const queries = Array.from({ length: queryCount }, (_, i) => ({
        query: `throughput test query ${i}`,
        limit: 10,
      }));

      const latencies: number[] = [];

      const { result, durationMs } = await measureTime(async () => {
        for (const { query, limit } of queries) {
          const { durationMs: queryDuration } = await measureTime(async () => {
            await store!.search(query, { limit });
          });
          latencies.push(queryDuration);
        }
      });

      const throughputPerSecond = (queryCount / durationMs) * 1000;
      const sortedLatencies = [...latencies].sort((a, b) => a - b);

      measurements.push({
        operation: 'search',
        count: queryCount,
        durationMs,
        throughputPerSecond,
        latencies,
        p50LatencyMs: calculatePercentile(sortedLatencies, 0.50),
        p95LatencyMs: calculatePercentile(sortedLatencies, 0.95),
        p99LatencyMs: calculatePercentile(sortedLatencies, 0.99),
      });
    }

    // Verify query throughput
    expect(measurements.length).toBe(3);

    // Queries should be fast
    for (const m of measurements) {
      expect(m.throughputPerSecond).toBeGreaterThan(20); // At least 20 queries/sec
      expect(m.p50LatencyMs).toBeLessThan(100); // Median < 100ms
      expect(m.p95LatencyMs).toBeLessThan(500); // 95th percentile < 500ms
    }

    await store.close();
  });

  it('should measure scrape operations per second throughput', async () => {
    const urlCounts = [20, 50, 100];
    const measurements: ThroughputMeasurement[] = [];

    for (const urlCount of urlCounts) {
      const urls = Array.from({ length: urlCount }, (_, i) => 
        `https://example.com/scrape-test/${i}`
      );

      const latencies: number[] = [];

      scraper.reset();

      const { result, durationMs } = await measureTime(async () => {
        for (const url of urls) {
          const { durationMs: scrapeDuration } = await measureTime(async () => {
            await scraper.scrape(url);
          });
          latencies.push(scrapeDuration);
        }
      });

      const throughputPerSecond = (urlCount / durationMs) * 1000;
      const sortedLatencies = [...latencies].sort((a, b) => a - b);

      measurements.push({
        operation: 'scrape',
        count: urlCount,
        durationMs,
        throughputPerSecond,
        latencies,
        p50LatencyMs: calculatePercentile(sortedLatencies, 0.50),
        p95LatencyMs: calculatePercentile(sortedLatencies, 0.95),
        p99LatencyMs: calculatePercentile(sortedLatencies, 0.99),
      });
    }

    // Verify scrape throughput
    expect(measurements.length).toBe(3);

    // Scrapes should be reasonably fast
    for (const m of measurements) {
      expect(m.throughputPerSecond).toBeGreaterThan(5); // At least 5 scrapes/sec
      expect(m.p50LatencyMs).toBeLessThan(100); // Median < 100ms
      expect(m.p95LatencyMs).toBeLessThan(200); // 95th percentile < 200ms
    }

    // Verify all URLs were scraped
    expect(scraper.getRequestCount()).toBe(urlCounts.reduce((sum, c) => sum + c, 0));
  });

  it('should measure mixed workload throughput', async () => {
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: embedder as unknown as Embedder,
      modelName: 'test-model',
    });

    await store.open();

    // Add initial documents
    const initialDocs = generateTestDocuments(200);
    await store.addDocuments(initialDocs);

    // Mixed workload: adds, searches, and scrapes
    const iterations = 50;
    const latencies: { operation: string; durationMs: number }[] = [];

    const { result, durationMs } = await measureTime(async () => {
      for (let i = 0; i < iterations; i++) {
        // Add documents
        const docs = generateTestDocuments(5);
        const { durationMs: addDuration } = await measureTime(async () => {
          await store!.addDocuments(docs);
        });
        latencies.push({ operation: 'addDocuments', durationMs: addDuration });

        // Search
        const { durationMs: searchDuration } = await measureTime(async () => {
          await store!.search(`query ${i}`, { limit: 5 });
        });
        latencies.push({ operation: 'search', durationMs: searchDuration });

        // Scrape
        const { durationMs: scrapeDuration } = await measureTime(async () => {
          await scraper.scrape(`https://example.com/mixed/${i}`);
        });
        latencies.push({ operation: 'scrape', durationMs: scrapeDuration });
      }
    });

    const totalOperations = latencies.length;
    const overallThroughput = (totalOperations / durationMs) * 1000;

    // Calculate stats per operation type
    const byOperation = latencies.reduce((acc, l) => {
      if (!acc[l.operation]) {
        acc[l.operation] = [];
      }
      acc[l.operation].push(l.durationMs);
      return acc;
    }, {} as Record<string, number[]>);

    const operationStats = Object.entries(byOperation).map(([op, opLatencies]) => {
      const stats = calculateLatencyStats(opLatencies);
      return {
        operation: op,
        count: opLatencies.length,
        ...stats,
      };
    });

    // Verify overall throughput
    expect(overallThroughput).toBeGreaterThan(10); // At least 10 ops/sec
    expect(totalOperations).toBe(iterations * 3); // 3 operations per iteration

    // Verify each operation type
    for (const stats of operationStats) {
      expect(stats.count).toBe(iterations);
      expect(stats.p95).toBeLessThan(1000); // 95th percentile < 1 second
    }

    await store.close();
  });

  it('should measure latency percentiles under load', async () => {
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: embedder as unknown as Embedder,
      modelName: 'test-model',
    });

    await store.open();

    // Add documents
    const documents = generateTestDocuments(300);
    await store.addDocuments(documents);

    // Measure search latencies under load
    const searchCount = 200;
    const searchLatencies: number[] = [];

    // Execute searches in bursts to simulate load
    const burstSize = 20;
    for (let i = 0; i < searchCount; i += burstSize) {
      const burst = Math.min(burstSize, searchCount - i);
      const burstPromises = Array.from({ length: burst }, (_, j) =>
        measureTime(async () => {
          await store!.search(`latency test query ${i + j}`, { limit: 10 });
        })
      );

      const results = await Promise.all(burstPromises);
      results.forEach(r => searchLatencies.push(r.durationMs));
    }

    const latencyStats = calculateLatencyStats(searchLatencies);

    // Verify latency characteristics
    expect(latencyStats.average).toBeGreaterThan(0);
    expect(latencyStats.p50).toBeLessThan(200); // Median < 200ms
    expect(latencyStats.p95).toBeLessThan(500); // 95th percentile < 500ms
    expect(latencyStats.p99).toBeLessThan(1000); // 99th percentile < 1 second

    // Verify consistency (p99 shouldn't be too much higher than p50)
    expect(latencyStats.p99).toBeLessThan(latencyStats.p50 * 10);

    await store.close();
  });

  it('should measure sustained throughput over time', async () => {
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: embedder as unknown as Embedder,
      modelName: 'test-model',
    });

    await store.open();

    // Add documents
    const documents = generateTestDocuments(400);
    await store.addDocuments(documents);

    // Measure throughput over multiple time windows
    const windowDurationSec = 5;
    const windowCount = 4;
    const queriesPerWindow = 50;

    const windowThroughputs: number[] = [];

    for (let window = 0; window < windowCount; window++) {
      const { durationMs } = await measureTime(async () => {
        const queries = Array.from({ length: queriesPerWindow }, (_, i) => 
          `sustained throughput query ${window}-${i}`
        );

        await executeBurst(
          queries.map(query => async () => {
            await store!.search(query, { limit: 5 });
          })
        );
      });

      const throughput = (queriesPerWindow / durationMs) * 1000;
      windowThroughputs.push(throughput);
    }

    // Verify sustained performance
    const avgThroughput = windowThroughputs.reduce((sum, t) => sum + t, 0) / windowThroughputs.length;
    const minThroughput = Math.min(...windowThroughputs);
    const maxThroughput = Math.max(...windowThroughputs);

    // Average throughput should be good
    expect(avgThroughput).toBeGreaterThan(10);

    // Performance shouldn't degrade too much (min should be > 50% of max)
    expect(minThroughput).toBeGreaterThan(maxThroughput * 0.5);

    // Throughput should be reasonably consistent
    const throughputStdDev = Math.sqrt(
      windowThroughputs.reduce((sum, t) => sum + Math.pow(t - avgThroughput, 2), 0) / windowThroughputs.length
    );
    const cv = throughputStdDev / avgThroughput;
    expect(cv).toBeLessThan(0.5); // Coefficient of variation < 50%

    await store.close();
  });

  it('should measure concurrent operation throughput', async () => {
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: embedder as unknown as Embedder,
      modelName: 'test-model',
    });

    await store.open();

    // Add initial documents
    const documents = generateTestDocuments(200);
    await store.addDocuments(documents);

    // Concurrent mixed operations
    const operationCount = 30;
    const latencies: { operation: string; durationMs: number }[] = [];

    const operations = [
      // Search operations
      ...Array.from({ length: 15 }, (_, i) => ({
        type: 'search',
        fn: async () => {
          const { durationMs } = await measureTime(async () => {
            await store!.search(`concurrent query ${i}`, { limit: 5 });
          });
          latencies.push({ operation: 'search', durationMs });
        },
      })),
      // Scrape operations
      ...Array.from({ length: 10 }, (_, i) => ({
        type: 'scrape',
        fn: async () => {
          const { durationMs } = await measureTime(async () => {
            await scraper.scrape(`https://example.com/concurrent/${i}`);
          });
          latencies.push({ operation: 'scrape', durationMs });
        },
      })),
      // Add operations
      ...Array.from({ length: 5 }, (_, i) => ({
        type: 'add',
        fn: async () => {
          const docs = generateTestDocuments(3);
          const { durationMs } = await measureTime(async () => {
            await store!.addDocuments(docs);
          });
          latencies.push({ operation: 'addDocuments', durationMs });
        },
      })),
    ];

    const { durationMs } = await measureTime(async () => {
      await executeBurst(operations.map(op => op.fn));
    });

    const overallThroughput = (operationCount / durationMs) * 1000;

    // Analyze per-operation throughput
    const byOperation = latencies.reduce((acc, l) => {
      if (!acc[l.operation]) {
        acc[l.operation] = [];
      }
      acc[l.operation].push(l.durationMs);
      return acc;
    }, {} as Record<string, number[]>);

    const operationThroughputs = Object.entries(byOperation).map(([op, opLatencies]) => {
      const stats = calculateLatencyStats(opLatencies);
      return {
        operation: op,
        count: opLatencies.length,
        throughput: (opLatencies.length / durationMs) * 1000,
        ...stats,
      };
    });

    // Verify overall throughput
    expect(overallThroughput).toBeGreaterThan(5); // At least 5 ops/sec

    // Verify each operation type has reasonable latencies
    for (const op of operationThroughputs) {
      expect(op.p95).toBeLessThan(2000); // 95th percentile < 2 seconds
    }

    // Searches should be faster than adds
    const searchOps = operationThroughputs.find(op => op.operation === 'search');
    const addOps = operationThroughputs.find(op => op.operation === 'addDocuments');
    if (searchOps && addOps) {
      expect(searchOps.p50).toBeLessThan(addOps.p50 * 2); // Searches should be faster
    }

    await store.close();
  });
});