/**
 * Chaos Engineering Test Helpers
 *
 * Utilities for simulating failures, delays, and chaotic conditions
 * in tests. These helpers make chaos engineering tests deterministic
 * and reusable across different test suites.
 */

import { vi } from 'vitest';

// ============================================================================
// Randomized Delay Injection
// ============================================================================

export interface DelayOptions {
  /** Minimum delay in milliseconds (default: 0) */
  min?: number;
  /** Maximum delay in milliseconds (default: 100) */
  max?: number;
  /** Seed for deterministic randomness (default: random) */
  seed?: number;
}

/**
 * Simple seeded random number generator for deterministic tests
 */
class SeededRandom {
  private state: number;

  constructor(seed: number = Date.now()) {
    this.state = seed;
  }

  next(): number {
    this.state = (this.state * 9301 + 49297) % 233280;
    return this.state / 233280;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  nextFloat(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }
}

/**
 * Create a function that injects random delays before or after execution
 */
export function withRandomDelay<T>(
  fn: () => Promise<T> | T,
  options: DelayOptions = {}
): () => Promise<T> {
  const rng = new SeededRandom(options.seed);
  const min = options.min ?? 0;
  const max = options.max ?? 100;

  return async () => {
    const delay = rng.nextFloat(min, max);
    await new Promise(resolve => setTimeout(resolve, delay));
    const result = await fn();
    await new Promise(resolve => setTimeout(resolve, rng.nextFloat(min, max)));
    return result;
  };
}

/**
 * Create a function that injects delays with jitter before execution
 */
export function withJitterDelay<T>(
  fn: () => Promise<T> | T,
  baseDelay: number,
  jitterPercent: number = 0.5
): () => Promise<T> {
  return async () => {
    const jitter = baseDelay * jitterPercent * (Math.random() * 2 - 1);
    const delay = Math.max(0, baseDelay + jitter);
    await new Promise(resolve => setTimeout(resolve, delay));
    return await fn();
  };
}

// ============================================================================
// Error Injection
// ============================================================================

export interface ErrorInjectionOptions {
  /** Probability of throwing an error (0-1, default: 0.5) */
  errorProbability?: number;
  /** Error to throw (default: Error('Chaos injection')) */
  error?: Error;
  /** Only inject error on specific attempt numbers (1-indexed) */
  onAttempts?: number[];
  /** Only inject error after N attempts */
  afterAttempts?: number;
  /** Seed for deterministic randomness */
  seed?: number;
}

/**
 * Create a function that randomly throws errors based on probability
 */
export function withRandomError<T>(
  fn: () => Promise<T> | T,
  options: ErrorInjectionOptions = {}
): () => Promise<T> {
  const rng = new SeededRandom(options.seed);
  const errorProbability = options.errorProbability ?? 0.5;
  const error = options.error ?? new Error('Chaos injection: random error');
  const onAttempts = options.onAttempts;
  const afterAttempts = options.afterAttempts ?? 0;

  let attemptCount = 0;

  return async () => {
    attemptCount++;

    // Check if this attempt should error
    const shouldError = (() => {
      // Check onAttempts filter
      if (onAttempts && !onAttempts.includes(attemptCount)) {
        return false;
      }

      // Check afterAttempts threshold
      if (attemptCount <= afterAttempts) {
        return false;
      }

      // Random probability
      return rng.next() < errorProbability;
    })();

    if (shouldError) {
      throw error;
    }

    return await fn();
  };
}

/**
 * Create a function that throws an error on first N attempts, then succeeds
 */
export function withInitialFailures<T>(
  fn: () => Promise<T> | T,
  failureCount: number,
  error: Error = new Error('Chaos injection: initial failure')
): () => Promise<T> {
  let attempts = 0;

  return async () => {
    attempts++;
    if (attempts <= failureCount) {
      throw error;
    }
    return await fn();
  };
}

/**
 * Create a function that fails on alternating attempts
 */
export function withAlternatingFailures<T>(
  fn: () => Promise<T> | T,
  error: Error = new Error('Chaos injection: alternating failure')
): () => Promise<T> {
  let attemptCount = 0;

  return async () => {
    attemptCount++;
    if (attemptCount % 2 === 0) {
      throw error;
    }
    return await fn();
  };
}

// ============================================================================
// Process/Resource Failure Simulation
// ============================================================================

/**
 * Simulate a process crash by throwing an uncatchable error
 * For tests, this is intercepted before it crashes the actual process
 */
export function simulateProcessCrash(message: string = 'Simulated process crash'): Error {
  const error = new Error(message);
  (error as any).isSimulatedCrash = true;
  return error;
}

/**
 * Simulate an out-of-memory condition
 */
export function simulateOomError(): Error {
  const error = new Error('Simulated OOM: JavaScript heap out of memory');
  (error as any).code = 'ERR_WORKER_OUT_OF_MEMORY';
  return error;
}

/**
 * Simulate a file system error
 */
export function simulateFsError(code: string = 'EIO', path?: string): Error {
  const error = new Error(path ? `Simulated FS error on ${path}` : 'Simulated FS error');
  (error as any).code = code;
  if (path) (error as any).path = path;
  return error;
}

/**
 * Simulate a network timeout
 */
export function simulateNetworkTimeout(url?: string): Error {
  const error = new Error(url 
    ? `Simulated network timeout for ${url}`
    : 'Simulated network timeout'
  );
  (error as any).code = 'ETIMEDOUT';
  return error;
}

/**
 * Simulate a connection reset
 */
export function simulateConnectionReset(): Error {
  const error = new Error('Simulated connection reset');
  (error as any).code = 'ECONNRESET';
  return error;
}

/**
 * Simulate a connection refused
 */
export function simulateConnectionRefused(): Error {
  const error = new Error('Simulated connection refused');
  (error as any).code = 'ECONNREFUSED';
  return error;
}

/**
 * Simulate a rate limit error (HTTP 429)
 */
export function simulateRateLimitError(retryAfter?: number): Error {
  const error = new Error('HTTP 429: Too Many Requests');
  (error as any).statusCode = 429;
  (error as any).code = 'ERR_HTTP_429';
  if (retryAfter !== undefined) {
    (error as any).retryAfter = retryAfter;
  }
  return error;
}

// ============================================================================
// Network Failure Simulation
// ============================================================================

export interface NetworkChaosOptions {
  /** Probability of failure (0-1) */
  failureProbability?: number;
  /** Types of failures to simulate */
  failureTypes?: ('timeout' | 'reset' | 'refused' | 'dns')[];
  /** Latency to add in milliseconds */
  addedLatency?: { min: number; max: number };
  /** Whether to simulate slow responses (slowloris-style) */
  slowResponse?: boolean;
  /** Seed for deterministic randomness */
  seed?: number;
}

/**
 * Create a function that simulates network chaos
 */
export function withNetworkChaos<T>(
  fn: () => Promise<T> | T,
  options: NetworkChaosOptions = {}
): () => Promise<T> {
  const rng = new SeededRandom(options.seed);
  const failureProbability = options.failureProbability ?? 0.3;
  const failureTypes = options.failureTypes ?? ['timeout', 'reset', 'refused', 'dns'];
  const addedLatency = options.addedLatency;

  return async () => {
    // Add latency if configured
    if (addedLatency) {
      const delay = rng.nextFloat(addedLatency.min, addedLatency.max);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    // Randomly inject network failure
    if (rng.next() < failureProbability) {
      const failureType = failureTypes[rng.nextInt(0, failureTypes.length - 1)];
      
      switch (failureType) {
        case 'timeout':
          throw simulateNetworkTimeout();
        case 'reset':
          throw simulateConnectionReset();
        case 'refused':
          throw simulateConnectionRefused();
        case 'dns':
          const dnsError = new Error('Simulated DNS resolution failure');
          (dnsError as any).code = 'ENOTFOUND';
          throw dnsError;
        default:
          throw simulateNetworkTimeout();
      }
    }

    return await fn();
  };
}

// ============================================================================
// Race Condition Simulation
// ============================================================================

/**
 * Execute multiple promises concurrently and ensure they're all started
 * before any resolve, to maximize race condition exposure
 */
export async function raceConcurrent<T>(
  operations: Array<() => Promise<T>>,
  options: { maxConcurrency?: number; jitterMs?: number } = {}
): Promise<T[]> {
  const { maxConcurrency = Infinity, jitterMs = 0 } = options;

  const results: Array<{ index: number; value: T }> = [];
  const errors: Array<{ index: number; error: Error }> = [];

  // Add jitter to start times to increase race likelihood
  const startDelays = operations.map(() => 
    jitterMs > 0 ? Math.random() * jitterMs : 0
  );

  const promises = operations.map(async (op, index) => {
    if (startDelays[index] > 0) {
      await new Promise(resolve => setTimeout(resolve, startDelays[index]));
    }

    try {
      const value = await op();
      results.push({ index, value });
    } catch (error) {
      errors.push({ index, error: error as Error });
    }
  });

  await Promise.all(promises);

  if (errors.length > 0) {
    throw new AggregateError(
      errors.map(e => e.error),
      `${errors.length} operations failed`
    );
  }

  return results.sort((a, b) => a.index - b.index).map(r => r.value);
}

/**
 * Execute operations in a "burst" pattern - all start nearly simultaneously
 */
export async function executeBurst<T>(
  operations: Array<() => Promise<T>>,
  burstSize: number = operations.length
): Promise<T[]> {
  const results: T[] = [];
  const errors: Error[] = [];

  for (let i = 0; i < operations.length; i += burstSize) {
    const batch = operations.slice(i, i + burstSize);
    const batchResults = await Promise.allSettled(
      batch.map(op => op())
    );

    batchResults.forEach(result => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        errors.push(result.reason);
      }
    });
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} operations failed in burst`);
  }

  return results;
}

// ============================================================================
// Timing and Monitoring Helpers
// ============================================================================

/**
 * Measure execution time of an async operation
 */
export async function measureTime<T>(
  fn: () => Promise<T>
): Promise<{ result: T; durationMs: number }> {
  const start = Date.now();
  const result = await fn();
  const durationMs = Date.now() - start;
  return { result, durationMs };
}

/**
 * Create a timeout that can be reset
 */
export class ResettableTimeout {
  private timeoutId: NodeJS.Timeout | null = null;
  private readonly timeoutMs: number;
  private readonly callback: () => void;

  constructor(timeoutMs: number, callback: () => void) {
    this.timeoutMs = timeoutMs;
    this.callback = callback;
  }

  start(): void {
    this.clear();
    this.timeoutId = setTimeout(() => {
      this.callback();
      this.timeoutId = null;
    }, this.timeoutMs);
  }

  reset(): void {
    this.start();
  }

  clear(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  isPending(): boolean {
    return this.timeoutId !== null;
  }
}

// ============================================================================
// Mock Utilities
// ============================================================================

/**
 * Create a mock that fails after N successful calls
 */
export function createFailingMock<T>(
  successCount: number,
  error: Error = new Error('Mock failure after threshold')
): {
  mock: vi.Mock<Promise<T>>;
  verify: () => void;
} {
  const mock = vi.fn<Promise<T>>();
  let calls = 0;

  mock.mockImplementation(async () => {
    calls++;
    if (calls > successCount) {
      throw error;
    }
    return {} as T;
  });

  return {
    mock,
    verify: () => {
      expect(calls).toBe(successCount + 1);
      expect(mock).toHaveBeenCalledTimes(successCount + 1);
    }
  };
}

/**
 * Create a mock with configurable delay
 */
export function createDelayedMock<T>(
  delayMs: number,
  value: T
): vi.Mock<Promise<T>> {
  return vi.fn<Promise<T>>().mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return value;
  });
}

/**
 * Create a mock that fails intermittently
 */
export function createIntermittentMock<T>(
  successProbability: number,
  successValue: T,
  error: Error = new Error('Intermittent mock failure')
): vi.Mock<Promise<T>> {
  return vi.fn<Promise<T>>().mockImplementation(async () => {
    if (Math.random() < successProbability) {
      return successValue;
    }
    throw error;
  });
}

// ============================================================================
// Test Data Generators
// ============================================================================

/**
 * Generate random test data of given size
 */
export function generateRandomData(size: number): Buffer {
  const buffer = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    buffer[i] = Math.floor(Math.random() * 256);
  }
  return buffer;
}

/**
 * Generate a random test string
 */
export function generateRandomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}