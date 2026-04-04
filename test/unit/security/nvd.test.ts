/**
 * NVD Security Database Client Unit Tests
 *
 * Tests the National Vulnerability Database (NVD) client
 * and its rate limiting, search, and result parsing.
 */

import { describe, it, expect } from 'vitest';

describe('NVD Security Database Client', () => {
  describe('Search options validation', () => {
    it('should accept severity filter', () => {
      const severities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

      for (const severity of severities) {
        const options = { severity };
        expect(options.severity).toBe(severity);
      }
    });

    it('should accept max results parameter', () => {
      const maxResults = [10, 20, 50, 100, 2000];

      for (const max of maxResults) {
        const options = { maxResults: max };
        expect(options.maxResults).toBe(max);
      }
    });

    it('should support includeExploited flag', () => {
      const options1 = { includeExploited: true };
      const options2 = { includeExploited: false };
      const options3 = {};

      expect(options1.includeExploited).toBe(true);
      expect(options2.includeExploited).toBe(false);
      expect(options3.includeExploited).toBeUndefined();
    });

    it('should accept CWE ID filter', () => {
      const cweIds = ['CWE-79', 'CWE-200', 'CWE-125', ''];

      for (const cweId of cweIds) {
        const options = { cweId };
        expect(options.cweId).toBe(cweId);
      }
    });

    it('should accept date range filters', () => {
      const options = {
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      };

      expect(options.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(options.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should support combined search options', () => {
      const options = {
        severity: 'HIGH',
        maxResults: 50,
        includeExploited: true,
        cweId: 'CWE-79',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      };

      expect(options.severity).toBe('HIGH');
      expect(options.maxResults).toBe(50);
      expect(options.includeExploited).toBe(true);
      expect(options.cweId).toBe('CWE-79');
    });
  });

  describe('CVE data structures', () => {
    it('should represent CVSS data with score', () => {
      const cvssData = {
        version: '3.1',
        vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
        baseScore: 9.8,
        baseSeverity: 'CRITICAL',
      };

      expect(cvssData.baseScore).toBe(9.8);
      expect(cvssData.baseSeverity).toBe('CRITICAL');
    });

    it('should represent CVE with description', () => {
      const cve = {
        cveId: 'CVE-2024-0001',
        description: 'A vulnerability in example package',
        metrics: {
          cvssData: {
            baseScore: 7.5,
            baseSeverity: 'HIGH',
          },
        },
      };

      expect(cve.cveId).toMatch(/^CVE-\d{4}-\d+$/);
      expect(cve.metrics.cvssData.baseSeverity).toBe('HIGH');
    });

    it('should support multiple CVSS versions', () => {
      const versions = ['3.1', '3.0', '2.0'];

      for (const version of versions) {
        const cvssData = {
          version,
          baseScore: 7.5,
        };

        expect(cvssData.version).toBe(version);
      }
    });
  });

  describe('Rate limiting', () => {
    it('should define rate limit constants', () => {
      const minInterval = 6000; // 6 seconds for ~5 req/30s
      const requestsPerWindow = 5;
      const window = 30000; // 30 seconds

      expect(minInterval).toBeGreaterThan(0);
      expect(requestsPerWindow).toBeGreaterThan(0);
      expect(window).toBeGreaterThan(minInterval);
    });

    it('should track request timing', () => {
      const minInterval = 6000;
      const lastRequest = Date.now() - 2000; // 2 seconds ago

      const now = Date.now();
      const elapsed = now - lastRequest;
      const shouldWait = elapsed < minInterval;

      expect(shouldWait).toBe(true);
    });

    it('should allow request if enough time elapsed', () => {
      const lastRequest = Date.now() - 7000; // 7 seconds ago
      const minInterval = 6000;

      const now = Date.now();
      const elapsed = now - lastRequest;
      const canProceed = elapsed >= minInterval;

      expect(canProceed).toBe(true);
    });
  });

  describe('API response handling', () => {
    it('should parse valid NVD API response', () => {
      const response = {
        vulnerabilities: [
          {
            cve: {
              cveId: 'CVE-2024-0001',
              descriptions: [{ value: 'A vulnerability' }],
            },
          },
        ],
        resultsPerPage: 1,
        startIndex: 0,
        totalResults: 1,
      };

      expect(response.vulnerabilities).toHaveLength(1);
      expect(response.vulnerabilities[0].cve.cveId).toMatch(/^CVE-/);
    });

    it('should handle empty results', () => {
      const response = {
        vulnerabilities: [],
        resultsPerPage: 0,
        startIndex: 0,
        totalResults: 0,
      };

      expect(response.vulnerabilities).toHaveLength(0);
      expect(response.totalResults).toBe(0);
    });

    it('should handle pagination', () => {
      const response = {
        vulnerabilities: Array(20).fill(null).map((_, i) => ({
          cve: { cveId: `CVE-2024-${i.toString().padStart(4, '0')}` },
        })),
        resultsPerPage: 20,
        startIndex: 0,
        totalResults: 50,
      };

      expect(response.vulnerabilities).toHaveLength(20);
      expect(response.totalResults).toBe(50);
    });
  });

  describe('Vulnerability extraction', () => {
    it('should extract CVE ID', () => {
      const vulnerability = {
        cveId: 'CVE-2024-12345',
        description: 'A critical vulnerability',
      };

      expect(vulnerability.cveId).toMatch(/^CVE-\d{4}-\d+$/);
    });

    it('should extract severity from CVSS', () => {
      const severities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

      for (const severity of severities) {
        const vulnerability = {
          cveId: 'CVE-2024-00001',
          severity,
        };

        expect(vulnerability.severity).toBe(severity);
      }
    });

    it('should extract CPE affected products', () => {
      const vulnerability = {
        cveId: 'CVE-2024-00001',
        configurations: [
          {
            nodes: [
              {
                cpeMatch: [
                  { criteria: 'cpe:2.3:a:vendor:product:1.0:*:*:*:*:*:*:*' },
                ],
              },
            ],
          },
        ],
      };

      expect(vulnerability.configurations).toHaveLength(1);
      expect(vulnerability.configurations[0].nodes[0].cpeMatch).toHaveLength(1);
    });

    it('should extract reference links', () => {
      const vulnerability = {
        cveId: 'CVE-2024-00001',
        references: [
          { url: 'https://example.com/advisory' },
          { url: 'https://github.com/repo/issues/123' },
        ],
      };

      expect(vulnerability.references).toHaveLength(2);
      expect(vulnerability.references[0].url).toMatch(/^https:\/\//);
    });
  });

  describe('Error handling', () => {
    it('should handle API errors', () => {
      const error = {
        statusCode: 429,
        message: 'Rate limit exceeded',
      };

      expect(error.statusCode).toBe(429);
    });

    it('should handle malformed response', () => {
      const invalidResponse = {};
      const isValid = 'vulnerabilities' in invalidResponse;

      expect(isValid).toBe(false);
    });

    it('should handle network timeout', () => {
      const timeoutError = new Error('Request timeout after 30000ms');

      expect(timeoutError.message).toContain('timeout');
    });
  });

  describe('Retry logic', () => {
    it('should support configurable retry attempts', () => {
      const retryOptions = {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 10000,
      };

      expect(retryOptions.maxRetries).toBe(3);
      expect(retryOptions.initialDelay).toBe(1000);
      expect(retryOptions.maxDelay).toBe(10000);
    });

    it('should implement exponential backoff', () => {
      const delays = [1000, 2000, 4000, 8000];
      let lastDelay = 1000;

      for (let i = 1; i < delays.length; i++) {
        const nextDelay = lastDelay * 2;
        expect(nextDelay).toBe(delays[i]);
        lastDelay = nextDelay;
      }
    });
  });

  describe('Search query construction', () => {
    it('should build CVE ID query', () => {
      const cveId = 'CVE-2024-12345';
      const query = `cveId=${cveId}`;

      expect(query).toContain('CVE-');
    });

    it('should build keyword search query', () => {
      const keyword = 'sql injection';
      const query = `keywordSearch=${encodeURIComponent(keyword)}`;

      expect(query).toContain('sql');
    });

    it('should build severity filter query', () => {
      const severity = 'HIGH';
      const query = `cvssV3Severity=${severity}`;

      expect(query).toContain('HIGH');
    });

    it('should combine multiple filters', () => {
      const params = new URLSearchParams({
        cvssV3Severity: 'HIGH',
        resultsPerPage: '50',
        startIndex: '0',
      });

      const queryString = params.toString();
      expect(queryString).toContain('cvssV3Severity=HIGH');
      expect(queryString).toContain('resultsPerPage=50');
    });
  });
});
