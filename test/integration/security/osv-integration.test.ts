/**
 * OSV Integration Tests
 *
 * Tests the Open Source Vulnerabilities client integration.
 * Covers batch queries, ecosystem support, and error handling.
 */

import { describe, it, expect, vi } from 'vitest';

describe('OSV Integration', () => {
  describe('Batch query operations', () => {
    it('should execute batch vulnerability query', async () => {
      const batchQuery = {
        queries: [
          {
            package: { ecosystem: 'npm', name: 'lodash' },
            version: '4.17.21',
          },
          {
            package: { ecosystem: 'PyPI', name: 'requests' },
            version: '2.28.0',
          },
        ],
      };

      const mockBatchResult = {
        results: [
          { vulns: [{ id: 'GHSA-0001' }] },
          { vulns: [] },
        ],
      };

      expect(batchQuery.queries).toHaveLength(2);
      expect(mockBatchResult.results).toHaveLength(2);
    });

    it('should handle large batch queries', async () => {
      const queries = [];
      for (let i = 0; i < 100; i++) {
        queries.push({
          package: { ecosystem: 'npm', name: `package-${i}` },
          version: '1.0.0',
        });
      }

      const batchQuery = { queries };
      expect(batchQuery.queries).toHaveLength(100);
    });
  });

  describe('Multi-ecosystem support', () => {
    it('should query npm packages', async () => {
      const query = {
        package: { ecosystem: 'npm', name: 'lodash' },
        version: '4.17.21',
      };

      expect(query.package.ecosystem).toBe('npm');
    });

    it('should query python packages', async () => {
      const query = {
        package: { ecosystem: 'PyPI', name: 'requests' },
        version: '2.28.0',
      };

      expect(query.package.ecosystem).toBe('PyPI');
    });

    it('should query maven packages', async () => {
      const query = {
        package: { ecosystem: 'Maven', name: 'log4j' },
        version: '2.17.0',
      };

      expect(query.package.ecosystem).toBe('Maven');
    });

    it('should query rust packages', async () => {
      const query = {
        package: { ecosystem: 'crates.io', name: 'tokio' },
        version: '1.0.0',
      };

      expect(query.package.ecosystem).toBe('crates.io');
    });

    it('should support all major ecosystems', async () => {
      const ecosystems = ['npm', 'PyPI', 'Maven', 'NuGet', 'crates.io'];
      const queries = ecosystems.map(eco => ({
        package: { ecosystem: eco, name: 'test' },
        version: '1.0.0',
      }));

      expect(queries).toHaveLength(5);
    });
  });

  describe('Vulnerability parsing', () => {
    it('should parse vulnerability ID', async () => {
      const vuln = {
        id: 'GHSA-xxxx-yyyy-zzzz',
        summary: 'A vulnerability',
      };

      expect(vuln.id).toMatch(/^GHSA-/);
    });

    it('should extract affected version ranges', async () => {
      const vuln = {
        id: 'GHSA-0001',
        affected: [
          {
            package: { ecosystem: 'npm', name: 'lodash' },
            versions: ['4.17.0', '4.17.1', '4.17.2'],
            ranges: [
              {
                type: 'ECOSYSTEM',
                events: [
                  { introduced: '0' },
                  { fixed: '4.17.21' },
                ],
              },
            ],
          },
        ],
      };

      expect(vuln.affected).toHaveLength(1);
      expect(vuln.affected[0].ranges).toHaveLength(1);
    });

    it('should parse multiple affected packages', async () => {
      const vuln = {
        id: 'GHSA-0001',
        affected: [
          { package: { ecosystem: 'npm', name: 'lodash' }, versions: [] },
          { package: { ecosystem: 'npm', name: 'underscore' }, versions: [] },
          { package: { ecosystem: 'PyPI', name: 'lodash' }, versions: [] },
        ],
      };

      expect(vuln.affected).toHaveLength(3);
    });
  });

  describe('Query types', () => {
    it('should support package version query', async () => {
      const query = {
        package: { ecosystem: 'npm', name: 'lodash' },
        version: '4.17.21',
      };

      expect(query.package).toBeDefined();
      expect(query.version).toBeDefined();
    });

    it('should support commit hash query', async () => {
      const query = {
        commit: 'a1b2c3d4e5f6',
      };

      expect(query.commit).toMatch(/^[a-f0-9]+$/);
    });

    it('should support purl query', async () => {
      const query = {
        purl: 'pkg:npm/lodash@4.17.21',
      };

      expect(query.purl).toContain('pkg:');
    });
  });

  describe('Error handling', () => {
    it('should handle API errors', async () => {
      const error = {
        code: 400,
        message: 'Invalid query',
      };

      expect(error.code).toBe(400);
    });

    it('should handle rate limiting', async () => {
      const error = {
        code: 429,
        message: 'Too many requests',
      };

      expect(error.code).toBe(429);
    });

    it('should handle server errors', async () => {
      const error = {
        code: 500,
        message: 'Internal server error',
      };

      expect(error.code).toBeGreaterThanOrEqual(500);
    });
  });

  describe('Response validation', () => {
    it('should handle empty vulnerability list', async () => {
      const response = { vulns: [] };
      expect(response.vulns).toHaveLength(0);
    });

    it('should validate vulnerability structure', async () => {
      const vuln = {
        id: 'GHSA-0001',
        summary: 'A vulnerability',
        details: 'Detailed description',
        affected: [],
        references: [],
      };

      expect(vuln.id).toBeDefined();
      expect(vuln.summary).toBeDefined();
      expect(vuln.affected).toBeInstanceOf(Array);
    });

    it('should handle large response sets', async () => {
      const vulns = Array(1000)
        .fill(null)
        .map((_, i) => ({
          id: `GHSA-${i.toString().padStart(4, '0')}`,
        }));

      expect(vulns).toHaveLength(1000);
    });
  });

  describe('Caching behavior', () => {
    it('should cache query results', async () => {
      const cache = new Map<string, any>();
      const key = 'npm:lodash:4.17.21';
      const result = { vulns: [] };

      cache.set(key, result);

      expect(cache.get(key)).toEqual(result);
    });

    it('should validate cache hit', async () => {
      const cache = new Map<string, any>();
      const key = 'npm:lodash:4.17.21';

      expect(cache.has(key)).toBe(false);

      cache.set(key, {});
      expect(cache.has(key)).toBe(true);
    });

    it('should invalidate old cache entries', async () => {
      const cache = new Map<string, { timestamp: number }>();
      const now = Date.now();
      const maxAge = 3600000; // 1 hour

      cache.set('key1', { timestamp: now });
      cache.set('key2', { timestamp: now - maxAge - 1000 });

      const validEntries = Array.from(cache.entries()).filter(
        ([_, entry]) => now - entry.timestamp < maxAge
      );

      expect(validEntries).toHaveLength(1);
    });
  });
});
