/**
 * Rate Limit Handling Under Load Test
 *
 * Tests for validating graceful handling of rate limits (HTTP 429):
 * - Validate graceful exit on 429
 * - Backoff behavior under pressure
 * - Queue overflow handling
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { executeBurst, measureTime, withRandomError, simulateRateLimitError } from '../utils/chaos-helpers.ts';

// ============================================================================
// Types
// ============================================================================

interface RateLimitTestResult {
  attemptNumber: number;
  success: boolean;
  wasRateLimited: boolean;
  durationMs: number;
  retryCount: number;
  error?: Error;
  backoffDelayMs?: number;
}

interface RateLimitMetrics {
  totalAttempts: number;
  successfulAttempts: number;
  failedAttempts: number;
  rateLimitHits: number;
  successRate: number;
  averageRetriesPerSuccess: number;
  totalBackoffTimeMs: number;
  gracefulExitCount: number;
  queueOverflowCount: number;
}

// ============================================================================
// Mock Rate-Limited API Client
// ============================================================================

/**
 * Mock API client that simulates rate limiting behavior
 */
class MockRateLimitedClient {
  private requestCount: number = 0;
  private rateLimitThreshold: number;
  private rateLimitWindowMs: number;
  private rateLimitResetTime: number = 0;
  private requestHistory: number[] = [];

  constructor(rateLimitThreshold: number = 10, rateLimitWindowMs: number = 1000) {
    this.rateLimitThreshold = rateLimitThreshold;
    this.rateLimitWindowMs = rateLimitWindowMs;
  }

  /**
   * Make a request that may be rate limited
   */
  async makeRequest(endpoint: string): Promise<any> {
    const now = Date.now();

    // Clean old requests outside the window
    this.requestHistory = this.requestHistory.filter(
      timestamp => now - timestamp < this.rateLimitWindowMs
    );

    // Check if rate limit is active
    if (now < this.rateLimitResetTime) {
      throw simulateRateLimitError(Math.ceil((this.rateLimitResetTime - now) / 1000));
    }

    // Check if we've exceeded the threshold
    if (this.requestHistory.length >= this.rateLimitThreshold) {
      // Set rate limit reset time
      this.rateLimitResetTime = now + this.rateLimitWindowMs;
      throw simulateRateLimitError(Math.ceil(this.rateLimitWindowMs / 1000));
    }

    // Record this request
    this.requestHistory.push(now);
    this.requestCount++;

    // Simulate request processing
    await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 20));

    return {
      endpoint,
      status: 'success',
      data: `Response from ${endpoint}`,
      requestNumber: this.requestCount,
    };
  }

  /**
   * Make a request with built-in retry logic
   */
  async makeRequestWithRetry(
    endpoint: string,
    maxRetries: number = 3,
    initialBackoffMs: number = 100
  ): Promise<{ success: boolean; data?: any; error?: Error; retryCount: number; backoffDelayMs: number }> {
    let retryCount = 0;
    let totalBackoffMs = 0;
    let currentBackoffMs = initialBackoffMs;

    while (retryCount <= maxRetries) {
      try {
        const data = await this.makeRequest(endpoint);
        return {
          success: true,
          data,
          retryCount,
          backoffDelayMs: totalBackoffMs,
        };
      } catch (error) {
        if ((error as any).statusCode === 429 && retryCount < maxRetries) {
          // Apply exponential backoff with jitter
          const jitter = Math.random() * currentBackoffMs * 0.1;
          const backoffDelay = currentBackoffMs + jitter;
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          totalBackoffMs += backoffDelay;
          currentBackoffMs *= 2; // Exponential backoff
          retryCount++;
        } else {
          return {
            success: false,
            error: error as Error,
            retryCount,
            backoffDelayMs: totalBackoffMs,
          };
        }
      }
    }

    return {
      success: false,
      error: new Error('Max retries exceeded'),
      retryCount,
      backoffDelayMs: totalBackoffMs,
    };
  }

  /**
   * Reset rate limit state
   */
  reset(): void {
    this.requestCount = 0;
    this.rateLimitResetTime = 0;
    this.requestHistory = [];
  }

  /**
   * Get current request count
   */
  getRequestCount(): number {
    return this.requestCount;
  }

  /**
   * Check if currently rate limited
   */
  isRateLimited(): boolean {
    return Date.now() < this.rateLimitResetTime;
  }
}

// ============================================================================
// Mock Request Queue with Overflow Handling
// ============================================================================

/**
 * Mock request queue with overflow detection
 */
class RequestQueue {
  private queue: Array<{ id: string; operation: () => Promise<any> }> = [];
  private maxQueueSize: number;
  private overflowCount: number = 0;
  private processing: boolean = false;

  constructor(maxQueueSize: number = 100) {
    this.maxQueueSize = maxQueueSize;
  }

  /**
   * Add an operation to the queue
   */
  async enqueue(id: string, operation: () => Promise<any>): Promise<{ success: boolean; wasQueued: boolean; error?: string }> {
    if (this.queue.length >= this.maxQueueSize) {
      this.overflowCount++;
      return {
        success: false,
        wasQueued: false,
        error: 'Queue overflow',
      };
    }

    this.queue.push({ id, operation });

    if (!this.processing) {
      this.process();
    }

    return {
      success: true,
      wasQueued: true,
    };
  }

  /**
   * Process the queue
   */
  private async process(): Promise<void> {
    if (this.processing) return;

    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) {
        try {
          await item.operation();
        } catch (error) {
          // Log error but continue processing
          console.error(`Error processing queue item ${item.id}:`, error);
        }
      }
    }

    this.processing = false;
  }

  /**
   * Get current queue size
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Get overflow count
   */
  getOverflowCount(): number {
    return this.overflowCount;
  }

  /**
   * Reset overflow count
   */
  resetOverflowCount(): void {
    this.overflowCount = 0;
  }

  /**
   * Clear the queue
   */
  clear(): void {
    this.queue = [];
  }
}

// ============================================================================
// Test Implementation
// ============================================================================

describe('Rate Limit Handling Under Load Test', () => {
  let rateLimitedClient: MockRateLimitedClient;
  let requestQueue: RequestQueue;

  beforeAll(() => {
    rateLimitedClient = new MockRateLimitedClient(10, 1000);
    requestQueue = new RequestQueue(50);
  });

  afterAll(() => {
    rateLimitedClient.reset();
    requestQueue.clear();
  });

  it('should validate graceful exit on 429 rate limit', async () => {
    rateLimitedClient.reset();

    const results: RateLimitTestResult[] = [];
    const endpointCount = 20;

    for (let i = 0; i < endpointCount; i++) {
      const start = Date.now();
      const endpoint = `/test/graceful-exit-${i}`;

      try {
        const data = await rateLimitedClient.makeRequest(endpoint);
        const duration = Date.now() - start;
        results.push({
          attemptNumber: i + 1,
          success: true,
          wasRateLimited: false,
          durationMs: duration,
          retryCount: 0,
        });
      } catch (error) {
        const duration = Date.now() - start;
        const isRateLimit = (error as any).statusCode === 429;

        if (isRateLimit) {
          // Verify graceful exit: error should have proper structure
          expect((error as any).statusCode).toBe(429);
          expect((error as any).code).toBe('ERR_HTTP_429');
          expect((error as any).retryAfter).toBeDefined();
        }

        results.push({
          attemptNumber: i + 1,
          success: false,
          wasRateLimited: isRateLimit,
          durationMs: duration,
          retryCount: 0,
          error: error as Error,
        });
      }

      // Small delay between requests to hit rate limit
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const metrics = calculateRateLimitMetrics(results);

    // Should have hit rate limit
    expect(metrics.rateLimitHits).toBeGreaterThan(0);

    // Some requests should have succeeded
    expect(metrics.successfulAttempts).toBeGreaterThan(0);

    // Rate limit errors should be properly formatted
    const rateLimitErrors = results.filter(r => r.wasRateLimited);
    rateLimitErrors.forEach(r => {
      expect(r.error).toBeDefined();
      expect((r.error as any).statusCode).toBe(429);
    });
  });

  it('should demonstrate backoff behavior under pressure', async () => {
    rateLimitedClient.reset();

    const results: RateLimitTestResult[] = [];
    const requestCount = 25;

    for (let i = 0; i < requestCount; i++) {
      const endpoint = `/test/backoff-${i}`;

      const start = Date.now();
      const result = await rateLimitedClient.makeRequestWithRetry(endpoint, 3, 50);
      const duration = Date.now() - start;

      results.push({
        attemptNumber: i + 1,
        success: result.success,
        wasRateLimited: !result.success && (result.error as any)?.statusCode === 429,
        durationMs: duration,
        retryCount: result.retryCount,
        backoffDelayMs: result.backoffDelayMs,
        error: result.error,
      });

      // Small delay to simulate realistic load
      await new Promise(resolve => setTimeout(resolve, 30));
    }

    const metrics = calculateRateLimitMetrics(results);
    const resultsWithRetries = results.filter(r => r.retryCount > 0);

    // Some requests should have used retries
    expect(resultsWithRetries.length).toBeGreaterThan(0);

    // Verify backoff behavior
    resultsWithRetries.forEach(r => {
      // Backoff should be applied
      expect(r.backoffDelayMs).toBeGreaterThan(0);

      // More retries should mean longer duration
      expect(r.durationMs).toBeGreaterThanOrEqual(r.backoffDelayMs);
    });

    // Calculate average backoff time
    const avgBackoffTime = resultsWithRetries.reduce((sum, r) => sum + (r.backoffDelayMs || 0), 0) / resultsWithRetries.length;
    expect(avgBackoffTime).toBeGreaterThan(0);

    // Success rate should be reasonable with retries
    expect(metrics.successRate).toBeGreaterThan(0.5);
  });

  it('should handle queue overflow under high load', async () => {
    requestQueue.clear();
    requestQueue.resetOverflowCount();

    const operationCount = 100;
    const enqueueResults: Array<{ id: string; success: boolean; wasQueued: boolean }> = [];

    // Enqueue operations rapidly
    const { durationMs: enqueueDuration } = await measureTime(async () => {
      await executeBurst(
        Array.from({ length: operationCount }, (_, i) => async () => {
          const id = `op-${i}`;
          const operation = async () => {
            await rateLimitedClient.makeRequest(`/queue-test/${i}`);
            await new Promise(resolve => setTimeout(resolve, 10)); // Simulate processing
          };

          const result = await requestQueue.enqueue(id, operation);
          enqueueResults.push({ id, success: result.success, wasQueued: result.wasQueued });
        })
      );
    });

    // Wait for queue processing to complete
    await new Promise(resolve => setTimeout(resolve, 2000));

    const successfulEnqueues = enqueueResults.filter(r => r.success && r.wasQueued);
    const overflowCount = requestQueue.getOverflowCount();

    // Some operations should have overflowed
    expect(overflowCount).toBeGreaterThan(0);

    // Most operations should have been enqueued successfully
    expect(successfulEnqueues.length).toBeGreaterThan(operationCount * 0.5);

    // Overflow count should match failed enqueues
    const failedEnqueues = enqueueResults.filter(r => !r.success || !r.wasQueued);
    expect(overflowCount).toBe(failedEnqueues.length);

    // Enqueue should be fast
    expect(enqueueDuration).toBeLessThan(5000);
  });

  it('should validate exponential backoff with jitter', async () => {
    rateLimitedClient.reset();

    const backoffDelays: number[] = [];
    const testRequests = 15;

    for (let i = 0; i < testRequests; i++) {
      const endpoint = `/test/exponential-backoff-${i}`;

      const result = await rateLimitedClient.makeRequestWithRetry(endpoint, 3, 50);

      if (result.retryCount > 0) {
        backoffDelays.push(result.backoffDelayMs);
      }

      // Small delay to trigger rate limiting
      await new Promise(resolve => setTimeout(resolve, 40));
    }

    if (backoffDelays.length > 0) {
      // Sort delays
      backoffDelays.sort((a, b) => a - b);

      // Verify delays increase with retries (exponential backoff)
      const minDelay = backoffDelays[0];
      const maxDelay = backoffDelays[backoffDelays.length - 1];

      // Max delay should be significantly larger than min (exponential growth)
      expect(maxDelay).toBeGreaterThan(minDelay * 2);

      // Verify jitter: delays shouldn't be exact powers of 2
      const hasJitter = backoffDelays.some(delay => {
        const nearestPowerOf2 = Math.pow(2, Math.round(Math.log2(delay / 50)));
        const deviation = Math.abs(delay - (nearestPowerOf2 * 50));
        return deviation > 5; // More than 5ms deviation indicates jitter
      });
      expect(hasJitter).toBe(true);
    }
  });

  it('should handle rate limit recovery after cooldown', async () => {
    rateLimitedClient.reset();

    const phase1Results: RateLimitTestResult[] = [];
    const phase2Results: RateLimitTestResult[] = [];

    // Phase 1: Hit rate limit
    for (let i = 0; i < 15; i++) {
      const endpoint = `/test/phase1-${i}`;

      try {
        await rateLimitedClient.makeRequest(endpoint);
        phase1Results.push({
          attemptNumber: i + 1,
          success: true,
          wasRateLimited: false,
          durationMs: 0,
          retryCount: 0,
        });
      } catch (error) {
        phase1Results.push({
          attemptNumber: i + 1,
          success: false,
          wasRateLimited: (error as any).statusCode === 429,
          durationMs: 0,
          retryCount: 0,
          error: error as Error,
        });
      }

      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Wait for rate limit to reset
    const isInitiallyRateLimited = rateLimitedClient.isRateLimited();
    if (isInitiallyRateLimited) {
      await new Promise(resolve => setTimeout(resolve, 1100)); // Wait for reset
    }

    // Phase 2: Requests should succeed after cooldown
    for (let i = 0; i < 10; i++) {
      const endpoint = `/test/phase2-${i}`;

      try {
        await rateLimitedClient.makeRequest(endpoint);
        phase2Results.push({
          attemptNumber: i + 1,
          success: true,
          wasRateLimited: false,
          durationMs: 0,
          retryCount: 0,
        });
      } catch (error) {
        phase2Results.push({
          attemptNumber: i + 1,
          success: false,
          wasRateLimited: (error as any).statusCode === 429,
          durationMs: 0,
          retryCount: 0,
          error: error as Error,
        });
      }

      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const phase1Metrics = calculateRateLimitMetrics(phase1Results);
    const phase2Metrics = calculateRateLimitMetrics(phase2Results);

    // Phase 1 should have rate limit hits
    expect(phase1Metrics.rateLimitHits).toBeGreaterThan(0);

    // Phase 2 should have better success rate (after cooldown)
    expect(phase2Metrics.successRate).toBeGreaterThanOrEqual(phase1Metrics.successRate);

    // Phase 2 should have fewer rate limit hits
    expect(phase2Metrics.rateLimitHits).toBeLessThanOrEqual(phase1Metrics.rateLimitHits);
  });

  it('should validate graceful degradation under sustained load', async () => {
    rateLimitedClient.reset();

    const totalRequests = 50;
    const results: RateLimitTestResult[] = [];

    for (let i = 0; i < totalRequests; i++) {
      const endpoint = `/test/sustained-load-${i}`;

      const start = Date.now();
      const result = await rateLimitedClient.makeRequestWithRetry(endpoint, 2, 75);
      const duration = Date.now() - start;

      results.push({
        attemptNumber: i + 1,
        success: result.success,
        wasRateLimited: !result.success && (result.error as any)?.statusCode === 429,
        durationMs: duration,
        retryCount: result.retryCount,
        backoffDelayMs: result.backoffDelayMs,
        error: result.error,
      });

      // Very small delay to maintain pressure
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    const metrics = calculateRateLimitMetrics(results);

    // Calculate success rate over time (in windows)
    const windowSize = 10;
    const successRatesByWindow: number[] = [];

    for (let i = 0; i < totalRequests; i += windowSize) {
      const window = results.slice(i, i + windowSize);
      const successCount = window.filter(r => r.success).length;
      successRatesByWindow.push(successCount / window.length);
    }

    // Verify graceful degradation (not total failure)
    // Success rate should remain > 0.3 even under pressure
    const minSuccessRate = Math.min(...successRatesByWindow);
    expect(minSuccessRate).toBeGreaterThan(0.3);

    // Last windows should have similar success rate to first windows
    // (indicating stable degradation, not collapse)
    const firstWindowAvg = successRatesByWindow.slice(0, 2).reduce((sum, r) => sum + r, 0) / 2;
    const lastWindowAvg = successRatesByWindow.slice(-2).reduce((sum, r) => sum + r, 0) / 2;
    expect(lastWindowAvg).toBeGreaterThan(firstWindowAvg * 0.5);
  });

  it('should handle concurrent requests with rate limiting', async () => {
    rateLimitedClient.reset();

    const concurrentRequests = 30;
    const results: RateLimitTestResult[] = [];

    const { durationMs } = await measureTime(async () => {
      await executeBurst(
        Array.from({ length: concurrentRequests }, (_, i) => async () => {
          const endpoint = `/test/concurrent-${i}`;

          const start = Date.now();
          const result = await rateLimitedClient.makeRequestWithRetry(endpoint, 2, 50);
          const duration = Date.now() - start;

          results.push({
            attemptNumber: i + 1,
            success: result.success,
            wasRateLimited: !result.success && (result.error as any)?.statusCode === 429,
            durationMs: duration,
            retryCount: result.retryCount,
            backoffDelayMs: result.backoffDelayMs,
            error: result.error,
          });
        })
      );
    });

    const metrics = calculateRateLimitMetrics(results);

    // Some requests should hit rate limits under concurrent load
    expect(metrics.rateLimitHits).toBeGreaterThan(0);

    // Most requests should eventually succeed with retries
    expect(metrics.successRate).toBeGreaterThan(0.6);

    // Total duration should be reasonable
    expect(durationMs).toBeLessThan(10000);

    // No requests should hang indefinitely
    results.forEach(r => {
      expect(r.durationMs).toBeLessThan(5000);
    });
  });

  it('should validate queue overflow recovery after processing', async () => {
    requestQueue.clear();
    requestQueue.resetOverflowCount();

    // Phase 1: Fill queue to overflow
    const initialBatchSize = 60; // More than max queue size (50)
    const phase1Results = [];

    for (let i = 0; i < initialBatchSize; i++) {
      const result = await requestQueue.enqueue(`phase1-${i}`, async () => {
        await rateLimitedClient.makeRequest(`/recovery-test-${i}`);
      });
      phase1Results.push(result);
    }

    const phase1OverflowCount = requestQueue.getOverflowCount();
    expect(phase1OverflowCount).toBeGreaterThan(0);

    // Wait for queue to process
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Phase 2: Queue should accept new requests
    const phase2Results = [];
    const phase2BatchSize = 20;

    for (let i = 0; i < phase2BatchSize; i++) {
      const result = await requestQueue.enqueue(`phase2-${i}`, async () => {
        await rateLimitedClient.makeRequest(`/recovery-test-phase2-${i}`);
      });
      phase2Results.push(result);
    }

    // Phase 2 should have fewer or no overflows
    const phase2OverflowCount = requestQueue.getOverflowCount() - phase1OverflowCount;
    expect(phase2OverflowCount).toBeLessThanOrEqual(phase1OverflowCount);

    // Most phase 2 requests should succeed
    const phase2Successes = phase2Results.filter(r => r.success && r.wasQueued);
    expect(phase2Successes.length).toBeGreaterThan(phase2BatchSize * 0.7);
  });
});

// ============================================================================
// Utility Functions
// ============================================================================

function calculateRateLimitMetrics(results: RateLimitTestResult[]): RateLimitMetrics {
  const totalAttempts = results.length;
  const successfulAttempts = results.filter(r => r.success).length;
  const failedAttempts = totalAttempts - successfulAttempts;
  const rateLimitHits = results.filter(r => r.wasRateLimited).length;
  const successRate = totalAttempts > 0 ? successfulAttempts / totalAttempts : 0;

  const successfulWithRetries = results.filter(r => r.success && r.retryCount > 0);
  const averageRetriesPerSuccess = successfulWithRetries.length > 0
    ? successfulWithRetries.reduce((sum, r) => sum + r.retryCount, 0) / successfulWithRetries.length
    : 0;

  const totalBackoffTimeMs = results.reduce((sum, r) => sum + (r.backoffDelayMs || 0), 0);

  const gracefulExitCount = results.filter(r => 
    r.wasRateLimited && r.error && (r.error as any).statusCode === 429
  ).length;

  const queueOverflowCount = results.filter(r => 
    r.error && r.error.message.includes('overflow')
  ).length;

  return {
    totalAttempts,
    successfulAttempts,
    failedAttempts,
    rateLimitHits,
    successRate,
    averageRetriesPerSuccess,
    totalBackoffTimeMs,
    gracefulExitCount,
    queueOverflowCount,
  };
}