/**
 * API Concurrency Load Test
 *
 * Tests for validating concurrent API request handling across
 * all security APIs (NVD, GitHub, OSV, CISA) and Stack Exchange.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { executeBurst, measureTime, withNetworkChaos, simulateRateLimitError } from '../utils/chaos-helpers.ts';

// ============================================================================
// Types
// ============================================================================

interface ApiRequestResult {
  apiName: string;
  endpoint: string;
  success: boolean;
  durationMs: number;
  statusCode?: number;
  error?: Error;
  retryCount?: number;
  wasRateLimited?: boolean;
}

interface ApiConcurrencyMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  rateLimitCount: number;
  apiMetrics: Record<string, {
    requestCount: number;
    successCount: number;
    averageLatencyMs: number;
    rateLimitCount: number;
  }>;
}

// ============================================================================
// Mock API Implementations
// ============================================================================

/**
 * Mock NVD API client
 */
class MockNvdClient {
  private requestCount: number = 0;
  private rateLimitTriggered: boolean = false;

  async getCve(cveId: string): Promise<any> {
    this.requestCount++;
    
    // Simulate rate limit after 50 requests
    if (this.requestCount > 50 && !this.rateLimitTriggered) {
      this.rateLimitTriggered = true;
      throw simulateRateLimitError(60);
    }

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));

    return {
      id: cveId,
      description: `Description for ${cveId}`,
      severity: 'HIGH',
      score: 8.5,
      published: new Date().toISOString(),
    };
  }

  async searchCves(query: string, limit: number = 20): Promise<any[]> {
    this.requestCount++;
    
    // Simulate rate limit
    if (this.requestCount > 50 && !this.rateLimitTriggered) {
      this.rateLimitTriggered = true;
      throw simulateRateLimitError(60);
    }

    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 150));

    return Array.from({ length: limit }, (_, i) => ({
      id: `CVE-2024-${1000 + i}`,
      description: `Result ${i} for ${query}`,
      severity: i % 3 === 0 ? 'HIGH' : 'MEDIUM',
    }));
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  reset(): void {
    this.requestCount = 0;
    this.rateLimitTriggered = false;
  }
}

/**
 * Mock GitHub Advisory API client
 */
class MockGitHubAdvisoryClient {
  private requestCount: number = 0;
  private rateLimitTriggered: boolean = false;

  async getAdvisory(ghsaId: string): Promise<any> {
    this.requestCount++;

    // Simulate GitHub rate limits (more strict)
    if (this.requestCount > 40 && !this.rateLimitTriggered) {
      this.rateLimitTriggered = true;
      throw simulateRateLimitError(60);
    }

    await new Promise(resolve => setTimeout(resolve, 80 + Math.random() * 120));

    return {
      ghsaId,
      summary: `Summary for ${ghsaId}`,
      severity: 'HIGH',
      publishedAt: new Date().toISOString(),
    };
  }

  async searchAdvisories(query: string): Promise<any[]> {
    this.requestCount++;

    if (this.requestCount > 40 && !this.rateLimitTriggered) {
      this.rateLimitTriggered = true;
      throw simulateRateLimitError(60);
    }

    await new Promise(resolve => setTimeout(resolve, 150 + Math.random() * 200));

    return Array.from({ length: 10 }, (_, i) => ({
      ghsaId: `GHSA-${1000 + i}`,
      summary: `Advisory ${i} for ${query}`,
    }));
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  reset(): void {
    this.requestCount = 0;
    this.rateLimitTriggered = false;
  }
}

/**
 * Mock OSV API client
 */
class MockOsvClient {
  private requestCount: number = 0;
  private rateLimitTriggered: boolean = false;

  async getVulnerability(vulnId: string): Promise<any> {
    this.requestCount++;

    if (this.requestCount > 60 && !this.rateLimitTriggered) {
      this.rateLimitTriggered = true;
      throw simulateRateLimitError(60);
    }

    await new Promise(resolve => setTimeout(resolve, 60 + Math.random() * 90));

    return {
      id: vulnId,
      summary: `Summary for ${vulnId}`,
      severity: 'MEDIUM',
    };
  }

  async queryVulnerabilities(packageName: string): Promise<any[]> {
    this.requestCount++;

    if (this.requestCount > 60 && !this.rateLimitTriggered) {
      this.rateLimitTriggered = true;
      throw simulateRateLimitError(60);
    }

    await new Promise(resolve => setTimeout(resolve, 120 + Math.random() * 180));

    return Array.from({ length: 15 }, (_, i) => ({
      id: `OSV-${2000 + i}`,
      summary: `Vulnerability ${i} for ${packageName}`,
    }));
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  reset(): void {
    this.requestCount = 0;
    this.rateLimitTriggered = false;
  }
}

/**
 * Mock CISA KEV API client
 */
class MockCisaKevClient {
  private requestCount: number = 0;
  private rateLimitTriggered: boolean = false;

  async getKevList(): Promise<any[]> {
    this.requestCount++;

    if (this.requestCount > 70 && !this.rateLimitTriggered) {
      this.rateLimitTriggered = true;
      throw simulateRateLimitError(60);
    }

    await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 300));

    return Array.from({ length: 50 }, (_, i) => ({
      cveID: `CVE-2024-${2000 + i}`,
      vendorProject: `Vendor ${i}`,
      product: `Product ${i}`,
    }));
  }

  async checkCve(cveId: string): Promise<boolean> {
    this.requestCount++;

    if (this.requestCount > 70 && !this.rateLimitTriggered) {
      this.rateLimitTriggered = true;
      throw simulateRateLimitError(60);
    }

    await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 80));

    // Mock: CVEs ending in even numbers are in KEV
    return parseInt(cveId.split('-').pop() || '0', 10) % 2 === 0;
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  reset(): void {
    this.requestCount = 0;
    this.rateLimitTriggered = false;
  }
}

/**
 * Mock Stack Exchange API client
 */
class MockStackExchangeClient {
  private requestCount: number = 0;
  private rateLimitTriggered: boolean = false;

  async searchQuestions(query: string, tags?: string[]): Promise<any[]> {
    this.requestCount++;

    // Stack Exchange has more lenient rate limits
    if (this.requestCount > 300 && !this.rateLimitTriggered) {
      this.rateLimitTriggered = true;
      throw simulateRateLimitError(30);
    }

    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 150));

    return Array.from({ length: 10 }, (_, i) => ({
      question_id: 1000 + i,
      title: `Question ${i} about ${query}`,
      score: Math.floor(Math.random() * 100),
      tags: tags || ['javascript', 'typescript'],
    }));
  }

  async getQuestion(questionId: number): Promise<any> {
    this.requestCount++;

    if (this.requestCount > 300 && !this.rateLimitTriggered) {
      this.rateLimitTriggered = true;
      throw simulateRateLimitError(30);
    }

    await new Promise(resolve => setTimeout(resolve, 80 + Math.random() * 120));

    return {
      question_id: questionId,
      title: `Question ${questionId}`,
      body: 'This is the question body',
      score: 50,
      answers: [
        { body: 'Answer 1', score: 10 },
        { body: 'Answer 2', score: 5 },
      ],
    };
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  reset(): void {
    this.requestCount = 0;
    this.rateLimitTriggered = false;
  }
}

// ============================================================================
// Test Implementation
// ============================================================================

describe('API Concurrency Load Test', () => {
  let nvdClient: MockNvdClient;
  let githubClient: MockGitHubAdvisoryClient;
  let osvClient: MockOsvClient;
  let cisaClient: MockCisaKevClient;
  let stackExchangeClient: MockStackExchangeClient;

  beforeAll(() => {
    nvdClient = new MockNvdClient();
    githubClient = new MockGitHubAdvisoryClient();
    osvClient = new MockOsvClient();
    cisaClient = new MockCisaKevClient();
    stackExchangeClient = new MockStackExchangeClient();
  });

  afterAll(() => {
    nvdClient.reset();
    githubClient.reset();
    osvClient.reset();
    cisaClient.reset();
    stackExchangeClient.reset();
  });

  it('should handle 50+ concurrent NVD API requests', async () => {
    const requestCount = 50;

    const results = await executeBurst(
      Array.from({ length: requestCount }, (_, i) => async () => {
        const start = Date.now();
        try {
          await nvdClient.getCve(`CVE-2024-${1000 + i}`);
          const duration = Date.now() - start;
          return {
            apiName: 'NVD',
            endpoint: `/cve/CVE-2024-${1000 + i}`,
            success: true,
            durationMs: duration,
          };
        } catch (error) {
          const duration = Date.now() - start;
          return {
            apiName: 'NVD',
            endpoint: `/cve/CVE-2024-${1000 + i}`,
            success: false,
            durationMs: duration,
            error: error as Error,
            wasRateLimited: (error as any).statusCode === 429,
          };
        }
      })
    );

    const metrics = calculateApiMetrics(results);

    // Most requests should succeed
    expect(metrics.successRate).toBeGreaterThan(0.7);

    // Rate limits should be detected
    expect(metrics.rateLimitCount).toBeGreaterThan(0);

    // Latency should be reasonable
    expect(metrics.p95LatencyMs).toBeLessThan(500);

    // Cleanup
    nvdClient.reset();
  });

  it('should handle 50+ concurrent GitHub Advisory API requests', async () => {
    const requestCount = 50;

    const results = await executeBurst(
      Array.from({ length: requestCount }, (_, i) => async () => {
        const start = Date.now();
        try {
          await githubClient.getAdvisory(`GHSA-${1000 + i}`);
          const duration = Date.now() - start;
          return {
            apiName: 'GitHub Advisory',
            endpoint: `/advisories/GHSA-${1000 + i}`,
            success: true,
            durationMs: duration,
          };
        } catch (error) {
          const duration = Date.now() - start;
          return {
            apiName: 'GitHub Advisory',
            endpoint: `/advisories/GHSA-${1000 + i}`,
            success: false,
            durationMs: duration,
            error: error as Error,
            wasRateLimited: (error as any).statusCode === 429,
          };
        }
      })
    );

    const metrics = calculateApiMetrics(results);

    // Most requests should succeed
    expect(metrics.successRate).toBeGreaterThan(0.6);

    // Rate limits should be detected (GitHub is stricter)
    expect(metrics.rateLimitCount).toBeGreaterThan(0);

    // Latency should be reasonable
    expect(metrics.p95LatencyMs).toBeLessThan(600);

    // Cleanup
    githubClient.reset();
  });

  it('should handle 50+ concurrent OSV API requests', async () => {
    const requestCount = 50;
    const requests = Array.from({ length: requestCount }, (_, i) => ({
      apiName: 'OSV',
      endpoint: `/vulnerabilities/OSV-${2000 + i}`,
      operation: () => osvClient.getVulnerability(`OSV-${2000 + i}`),
    }));

    const results = await executeBurst(
      requests.map(req =>
        measureTime(async () => {
          const start = Date.now();
          try {
            await req.operation();
            const duration = Date.now() - start;
            return {
              apiName: req.apiName,
              endpoint: req.endpoint,
              success: true,
              durationMs: duration,
            };
          } catch (error) {
            const duration = Date.now() - start;
            return {
              apiName: req.apiName,
              endpoint: req.endpoint,
              success: false,
              durationMs: duration,
              error: error as Error,
              wasRateLimited: (error as any).statusCode === 429,
            };
          }
        })
      )
    );

    const metrics = calculateApiMetrics(results);

    // Most requests should succeed
    expect(metrics.successRate).toBeGreaterThan(0.75);

    // Rate limits should be detected
    expect(metrics.rateLimitCount).toBeGreaterThan(0);

    // Latency should be reasonable
    expect(metrics.p95LatencyMs).toBeLessThan(500);

    // Cleanup
    osvClient.reset();
  });

  it('should handle 50+ concurrent CISA KEV API requests', async () => {
    const requestCount = 50;
    const requests = Array.from({ length: requestCount }, (_, i) => ({
      apiName: 'CISA KEV',
      endpoint: `/kev/CVE-2024-${3000 + i}`,
      operation: () => cisaClient.checkCve(`CVE-2024-${3000 + i}`),
    }));

    const results = await executeBurst(
      requests.map(req =>
        measureTime(async () => {
          const start = Date.now();
          try {
            await req.operation();
            const duration = Date.now() - start;
            return {
              apiName: req.apiName,
              endpoint: req.endpoint,
              success: true,
              durationMs: duration,
            };
          } catch (error) {
            const duration = Date.now() - start;
            return {
              apiName: req.apiName,
              endpoint: req.endpoint,
              success: false,
              durationMs: duration,
              error: error as Error,
              wasRateLimited: (error as any).statusCode === 429,
            };
          }
        })
      )
    );

    const metrics = calculateApiMetrics(results);

    // Most requests should succeed
    expect(metrics.successRate).toBeGreaterThan(0.8);

    // Rate limits should be detected
    expect(metrics.rateLimitCount).toBeGreaterThan(0);

    // Latency should be reasonable
    expect(metrics.p95LatencyMs).toBeLessThan(400);

    // Cleanup
    cisaClient.reset();
  });

  it('should handle 50+ concurrent Stack Exchange API requests', async () => {
    const requestCount = 50;
    const queries = Array.from({ length: requestCount }, (_, i) => `javascript async await pattern ${i}`);

    const requests = queries.map((query, i) => ({
      apiName: 'Stack Exchange',
      endpoint: `/search?q=${encodeURIComponent(query)}`,
      operation: () => stackExchangeClient.searchQuestions(query, ['javascript']),
    }));

    const results = await executeBurst(
      requests.map(req =>
        measureTime(async () => {
          const start = Date.now();
          try {
            await req.operation();
            const duration = Date.now() - start;
            return {
              apiName: req.apiName,
              endpoint: req.endpoint,
              success: true,
              durationMs: duration,
            };
          } catch (error) {
            const duration = Date.now() - start;
            return {
              apiName: req.apiName,
              endpoint: req.endpoint,
              success: false,
              durationMs: duration,
              error: error as Error,
              wasRateLimited: (error as any).statusCode === 429,
            };
          }
        })
      )
    );

    const metrics = calculateApiMetrics(results);

    // Stack Exchange should have high success rate (more lenient limits)
    expect(metrics.successRate).toBeGreaterThan(0.9);

    // Fewer rate limits expected
    expect(metrics.rateLimitCount).toBeLessThan(10);

    // Latency should be reasonable
    expect(metrics.p95LatencyMs).toBeLessThan(500);

    // Cleanup
    stackExchangeClient.reset();
  });

  it('should handle mixed concurrent requests across all APIs', async () => {
    const requestsPerApi = 15;

    const allRequests = [
      // NVD requests
      ...Array.from({ length: requestsPerApi }, (_, i) => ({
        apiName: 'NVD',
        endpoint: `/cve/CVE-2024-${1000 + i}`,
        operation: () => nvdClient.getCve(`CVE-2024-${1000 + i}`),
      })),
      // GitHub requests
      ...Array.from({ length: requestsPerApi }, (_, i) => ({
        apiName: 'GitHub Advisory',
        endpoint: `/advisories/GHSA-${1000 + i}`,
        operation: () => githubClient.getAdvisory(`GHSA-${1000 + i}`),
      })),
      // OSV requests
      ...Array.from({ length: requestsPerApi }, (_, i) => ({
        apiName: 'OSV',
        endpoint: `/vulnerabilities/OSV-${2000 + i}`,
        operation: () => osvClient.getVulnerability(`OSV-${2000 + i}`),
      })),
      // CISA requests
      ...Array.from({ length: requestsPerApi }, (_, i) => ({
        apiName: 'CISA KEV',
        endpoint: `/kev/CVE-2024-${3000 + i}`,
        operation: () => cisaClient.checkCve(`CVE-2024-${3000 + i}`),
      })),
      // Stack Exchange requests
      ...Array.from({ length: requestsPerApi }, (_, i) => ({
        apiName: 'Stack Exchange',
        endpoint: `/search?q=javascript${i}`,
        operation: () => stackExchangeClient.searchQuestions(`javascript pattern ${i}`, ['javascript']),
      })),
    ];

    const results = await executeBurst(
      allRequests.map(req =>
        measureTime(async () => {
          const start = Date.now();
          try {
            await req.operation();
            const duration = Date.now() - start;
            return {
              apiName: req.apiName,
              endpoint: req.endpoint,
              success: true,
              durationMs: duration,
            };
          } catch (error) {
            const duration = Date.now() - start;
            return {
              apiName: req.apiName,
              endpoint: req.endpoint,
              success: false,
              durationMs: duration,
              error: error as Error,
              wasRateLimited: (error as any).statusCode === 429,
            };
          }
        })
      )
    );

    const metrics = calculateApiMetrics(results);

    // Overall success rate should be good
    expect(metrics.successRate).toBeGreaterThan(0.6);

    // Each API should have handled requests
    expect(Object.keys(metrics.apiMetrics).length).toBe(5);

    // Total requests should match
    expect(metrics.totalRequests).toBe(requestsPerApi * 5);

    // Cleanup all clients
    nvdClient.reset();
    githubClient.reset();
    osvClient.reset();
    cisaClient.reset();
    stackExchangeClient.reset();
  });

  it('should measure latency under load for all APIs', async () => {
    const iterations = 3;
    const requestsPerIteration = 20;
    const allLatencies: Record<string, number[]> = {
      'NVD': [],
      'GitHub Advisory': [],
      'OSV': [],
      'CISA KEV': [],
      'Stack Exchange': [],
    };

    for (let iter = 0; iter < iterations; iter++) {
      const requests = [
        ...Array.from({ length: 4 }, (_, i) => ({
          apiName: 'NVD',
          operation: () => nvdClient.getCve(`CVE-2024-${1000 + iter * 4 + i}`),
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          apiName: 'GitHub Advisory',
          operation: () => githubClient.getAdvisory(`GHSA-${1000 + iter * 4 + i}`),
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          apiName: 'OSV',
          operation: () => osvClient.getVulnerability(`OSV-${2000 + iter * 4 + i}`),
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          apiName: 'CISA KEV',
          operation: () => cisaClient.checkCve(`CVE-2024-${3000 + iter * 4 + i}`),
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          apiName: 'Stack Exchange',
          operation: () => stackExchangeClient.searchQuestions(`query ${iter}-${i}`, ['javascript']),
        })),
      ];

      const results = await executeBurst(
        requests.map(req =>
          measureTime(async () => {
            try {
              await req.operation();
              return { apiName: req.apiName, success: true };
            } catch (error) {
              return { apiName: req.apiName, success: false };
            }
          })
        )
      );

      results.forEach(r => {
        allLatencies[r.apiName].push(r.durationMs);
      });
    }

    // Calculate statistics for each API
    for (const [apiName, latencies] of Object.entries(allLatencies)) {
      const avgLatency = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
      const maxLatency = Math.max(...latencies);

      // Average latency should be reasonable
      expect(avgLatency).toBeLessThan(500);

      // Max latency should be bounded
      expect(maxLatency).toBeLessThan(1000);
    }

    // Cleanup
    nvdClient.reset();
    githubClient.reset();
    osvClient.reset();
    cisaClient.reset();
    stackExchangeClient.reset();
  });

  it('should handle burst load patterns across all APIs', async () => {
    const burstSize = 10;
    const burstCount = 5;
    const requestsPerBurst = burstSize;

    const allResults: ApiRequestResult[] = [];

    for (let burst = 0; burst < burstCount; burst++) {
      const requests = [
        ...Array.from({ length: 2 }, (_, i) => ({
          apiName: 'NVD',
          operation: () => nvdClient.getCve(`CVE-2024-${burst * 2 + i}`),
        })),
        ...Array.from({ length: 2 }, (_, i) => ({
          apiName: 'GitHub Advisory',
          operation: () => githubClient.getAdvisory(`GHSA-${burst * 2 + i}`),
        })),
        ...Array.from({ length: 2 }, (_, i) => ({
          apiName: 'OSV',
          operation: () => osvClient.getVulnerability(`OSV-${burst * 2 + i}`),
        })),
        ...Array.from({ length: 2 }, (_, i) => ({
          apiName: 'CISA KEV',
          operation: () => cisaClient.checkCve(`CVE-2024-${burst * 2 + i}`),
        })),
        ...Array.from({ length: 2 }, (_, i) => ({
          apiName: 'Stack Exchange',
          operation: () => stackExchangeClient.searchQuestions(`burst ${burst}-${i}`, ['javascript']),
        })),
      ];

      const burstResults = await executeBurst(
        requests.map(req =>
          measureTime(async () => {
            const start = Date.now();
            try {
              await req.operation();
              const duration = Date.now() - start;
              return {
                apiName: req.apiName,
                endpoint: '',
                success: true,
                durationMs: duration,
              };
            } catch (error) {
              const duration = Date.now() - start;
              return {
                apiName: req.apiName,
                endpoint: '',
                success: false,
                durationMs: duration,
                error: error as Error,
                wasRateLimited: (error as any).statusCode === 429,
              };
            }
          })
        )
      );

      allResults.push(...burstResults);

      // Small delay between bursts
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const metrics = calculateApiMetrics(allResults);

    // Overall success rate should be good
    expect(metrics.successRate).toBeGreaterThan(0.7);

    // Each API should have participated in bursts
    expect(Object.keys(metrics.apiMetrics).length).toBe(5);

    // Total requests should match
    expect(metrics.totalRequests).toBe(burstCount * 10);

    // Cleanup
    nvdClient.reset();
    githubClient.reset();
    osvClient.reset();
    cisaClient.reset();
    stackExchangeClient.reset();
  });
});

// ============================================================================
// Utility Functions
// ============================================================================

function calculateApiMetrics(results: ApiRequestResult[]): ApiConcurrencyMetrics {
  const totalRequests = results.length;
  const successfulRequests = results.filter(r => r.success).length;
  const failedRequests = totalRequests - successfulRequests;
  const successRate = totalRequests > 0 ? successfulRequests / totalRequests : 0;

  const latencies = results.map(r => r.durationMs);
  latencies.sort((a, b) => a - b);

  const averageLatencyMs = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
  const p50LatencyMs = latencies[Math.floor(latencies.length * 0.5)];
  const p95LatencyMs = latencies[Math.floor(latencies.length * 0.95)];
  const p99LatencyMs = latencies[Math.floor(latencies.length * 0.99)];

  const rateLimitCount = results.filter(r => r.wasRateLimited).length;

  // Calculate metrics per API
  const apiMetrics: Record<string, {
    requestCount: number;
    successCount: number;
    averageLatencyMs: number;
    rateLimitCount: number;
  }> = {};

  for (const result of results) {
    if (!apiMetrics[result.apiName]) {
      apiMetrics[result.apiName] = {
        requestCount: 0,
        successCount: 0,
        averageLatencyMs: 0,
        rateLimitCount: 0,
      };
    }

    apiMetrics[result.apiName].requestCount++;
    if (result.success) {
      apiMetrics[result.apiName].successCount++;
      apiMetrics[result.apiName].averageLatencyMs += result.durationMs;
    }
    if (result.wasRateLimited) {
      apiMetrics[result.apiName].rateLimitCount++;
    }
  }

  // Calculate average latencies per API
  for (const apiName of Object.keys(apiMetrics)) {
    const metrics = apiMetrics[apiName];
    if (metrics.successCount > 0) {
      metrics.averageLatencyMs = metrics.averageLatencyMs / metrics.successCount;
    }
  }

  return {
    totalRequests,
    successfulRequests,
    failedRequests,
    successRate,
    averageLatencyMs,
    p50LatencyMs,
    p95LatencyMs,
    p99LatencyMs,
    rateLimitCount,
    apiMetrics,
  };
}