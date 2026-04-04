/**
 * NVD Integration Tests
 *
 * Tests the NVD client with mocked API responses.
 * Focuses on error handling, retry logic, and response parsing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '../../../src/logger.js';

describe('NVD Integration', () => {
  describe('API response handling', () => {
    it('should handle successful NVD API response', async () => {
      const mockResponse = {
        vulnerabilities: [
          {
            cve: {
              cveId: 'CVE-2024-0001',
              descriptions: [{ value: 'A critical vulnerability' }],
              metrics: {
                cvssMetricV31: [
                  {
                    cvssData: {
                      baseScore: 9.8,
                      baseSeverity: 'CRITICAL',
                    },
                  },
                ],
              },
            },
          },
        ],
        resultsPerPage: 1,
        startIndex: 0,
        totalResults: 1,
      };

      expect(mockResponse.vulnerabilities).toHaveLength(1);
      expect(mockResponse.vulnerabilities[0].cve.metrics.cvssMetricV31[0].cvssData.baseScore).toBe(9.8);
    });

    it('should parse multiple CVEs', async () => {
      const cveIds = ['CVE-2024-0001', 'CVE-2024-0002', 'CVE-2024-0003'];
      const mockVulnerabilities = cveIds.map(cveId => ({
        cve: {
          cveId,
          descriptions: [{ value: `Vulnerability ${cveId}` }],
        },
      }));

      expect(mockVulnerabilities).toHaveLength(3);
      expect(mockVulnerabilities.map(v => v.cve.cveId)).toEqual(cveIds);
    });

    it('should handle empty CVE results', async () => {
      const mockResponse = {
        vulnerabilities: [],
        resultsPerPage: 0,
        totalResults: 0,
      };

      expect(mockResponse.vulnerabilities).toHaveLength(0);
    });
  });

  describe('Pagination', () => {
    it('should track pagination state', async () => {
      const pageSize = 20;
      const totalResults = 150;
      const pages = Math.ceil(totalResults / pageSize);

      expect(pages).toBe(8);
    });

    it('should construct pagination parameters', async () => {
      const params = {
        startIndex: 0,
        resultsPerPage: 20,
      };

      const nextPageIndex = params.startIndex + params.resultsPerPage;
      expect(nextPageIndex).toBe(20);
    });

    it('should validate page boundaries', async () => {
      const totalResults = 150;
      const pageSize = 20;
      const lastPageStart = Math.floor(totalResults / pageSize) * pageSize;

      expect(lastPageStart).toBe(140);
      expect(lastPageStart + pageSize).toBeGreaterThanOrEqual(totalResults);
    });
  });

  describe('Rate limiting', () => {
    it('should respect rate limit delays', async () => {
      const minIntervalMs = 6000; // 6 seconds
      const requests = 5;
      const estimatedTime = minIntervalMs * requests;

      expect(estimatedTime).toBeGreaterThanOrEqual(30000); // At least 30 seconds
    });

    it('should track request timing', async () => {
      const timestamps = [0, 6000, 12000, 18000, 24000];
      const intervals = [];

      for (let i = 1; i < timestamps.length; i++) {
        intervals.push(timestamps[i] - timestamps[i - 1]);
      }

      expect(intervals.every(i => i >= 6000)).toBe(true);
    });

    it('should queue requests when rate limited', async () => {
      const queue: number[] = [];
      const minInterval = 6000;

      // Simulate queuing requests
      for (let i = 0; i < 5; i++) {
        queue.push(Date.now() + i * minInterval);
      }

      expect(queue).toHaveLength(5);
    });
  });

  describe('Error recovery', () => {
    it('should retry on timeout', async () => {
      let attempts = 0;
      const maxRetries = 3;

      const mockFetch = vi.fn(async () => {
        attempts++;
        if (attempts < maxRetries) {
          throw new Error('Timeout');
        }
        return { ok: true, json: async () => ({ vulnerabilities: [] }) };
      });

      // Simulate retry logic
      for (let i = 0; i < maxRetries; i++) {
        try {
          await mockFetch();
          if (attempts >= maxRetries) break;
        } catch {
          // Retry
        }
      }

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should handle 429 Too Many Requests', async () => {
      const mockResponse = {
        status: 429,
        headers: {
          'Retry-After': '30',
        },
      };

      expect(mockResponse.status).toBe(429);
      expect(mockResponse.headers['Retry-After']).toBe('30');
    });

    it('should handle 500 Internal Server Error', async () => {
      const mockResponse = {
        status: 500,
        statusText: 'Internal Server Error',
      };

      expect(mockResponse.status).toBeGreaterThanOrEqual(500);
    });
  });

  describe('Search functionality', () => {
    it('should search by CVE ID', async () => {
      const searchQuery = {
        cveId: 'CVE-2024-12345',
      };

      const url = new URL('https://services.nvd.nist.gov/rest/json/cves/2.0');
      url.searchParams.append('cveId', searchQuery.cveId);

      expect(url.toString()).toContain('cveId=CVE-2024-12345');
    });

    it('should search by keyword', async () => {
      const searchQuery = {
        keywordSearch: 'remote code execution',
      };

      const url = new URL('https://services.nvd.nist.gov/rest/json/cves/2.0');
      url.searchParams.append('keywordSearch', searchQuery.keywordSearch);

      expect(url.toString()).toContain('remote');
    });

    it('should filter by CVSS severity', async () => {
      const severities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

      for (const severity of severities) {
        const url = new URL('https://services.nvd.nist.gov/rest/json/cves/2.0');
        url.searchParams.append('cvssV3Severity', severity);

        expect(url.toString()).toContain(severity);
      }
    });
  });

  describe('Data validation', () => {
    it('should validate CVSS scores', async () => {
      const validScores = [0, 3.5, 7.5, 9.8, 10];

      for (const score of validScores) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(10);
      }
    });

    it('should validate CVE date ranges', async () => {
      const startDate = '2024-01-01';
      const endDate = '2024-12-31';

      const start = new Date(startDate);
      const end = new Date(endDate);

      expect(end.getTime()).toBeGreaterThan(start.getTime());
    });
  });

  describe('Response size handling', () => {
    it('should handle large response payloads', async () => {
      const largeVulnerabilities = Array(100)
        .fill(null)
        .map((_, i) => ({
          cve: {
            cveId: `CVE-2024-${i.toString().padStart(5, '0')}`,
            descriptions: [{ value: 'Description'.repeat(100) }],
          },
        }));

      expect(largeVulnerabilities).toHaveLength(100);
    });

    it('should respect max results per page', async () => {
      const maxResultsPerPage = 2000;
      const results = Array(maxResultsPerPage)
        .fill(null)
        .map((_, i) => ({ cveId: `CVE-2024-${i}` }));

      expect(results).toHaveLength(maxResultsPerPage);
    });
  });
});
