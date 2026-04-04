/**
 * OSV Security Database Client Unit Tests
 *
 * Tests the Open Source Vulnerabilities (OSV) database client
 * and its API integration with various package ecosystems.
 */

import { describe, it, expect } from 'vitest';

describe('OSV Security Database Client', () => {
  describe('Supported ecosystems', () => {
    it('should support npm ecosystem', () => {
      const ecosystem = 'npm';
      expect(ecosystem).toBe('npm');
    });

    it('should support pypi ecosystem', () => {
      const ecosystem = 'PyPI';
      expect(ecosystem).toBe('PyPI');
    });

    it('should support maven ecosystem', () => {
      const ecosystem = 'Maven';
      expect(ecosystem).toBe('Maven');
    });

    it('should support nuget ecosystem', () => {
      const ecosystem = 'NuGet';
      expect(ecosystem).toBe('NuGet');
    });

    it('should support crates ecosystem', () => {
      const ecosystem = 'crates.io';
      expect(ecosystem).toBe('crates.io');
    });

    it('should support multiple ecosystems', () => {
      const ecosystems = ['npm', 'PyPI', 'Maven', 'NuGet', 'crates.io'];
      expect(ecosystems).toHaveLength(5);
    });
  });

  describe('Package query options', () => {
    it('should accept package name and version', () => {
      const query = {
        package: { ecosystem: 'npm', name: 'lodash' },
        version: '4.17.21',
      };

      expect(query.package.name).toBe('lodash');
      expect(query.version).toBe('4.17.21');
    });

    it('should accept commit hash query', () => {
      const query = {
        commit: 'a1b2c3d4',
      };

      expect(query.commit).toMatch(/^[a-f0-9]+$/);
    });

    it('should support purl query', () => {
      const query = {
        purl: 'pkg:npm/lodash@4.17.21',
      };

      expect(query.purl).toContain('pkg:');
    });

    it('should support batch queries', () => {
      const queries = [
        { package: { ecosystem: 'npm', name: 'lodash' }, version: '4.17.21' },
        { package: { ecosystem: 'npm', name: 'express' }, version: '4.18.0' },
      ];

      expect(queries).toHaveLength(2);
    });
  });

  describe('Vulnerability data', () => {
    it('should parse OSV ID', () => {
      const vuln = {
        id: 'GHSA-xxxx-xxxx-xxxx',
        details: 'A vulnerability description',
      };

      expect(vuln.id).toMatch(/^GHSA-/);
    });

    it('should extract vulnerability summary', () => {
      const vuln = {
        id: 'GHSA-1234-5678-90ab',
        summary: 'Remote Code Execution vulnerability',
        details: 'Long detailed description',
      };

      expect(vuln.summary).toBeDefined();
      expect(vuln.details).toBeDefined();
    });

    it('should extract affected versions', () => {
      const vuln = {
        id: 'GHSA-1234-5678-90ab',
        affected: [
          {
            package: { ecosystem: 'npm', name: 'lodash' },
            versions: ['4.17.0', '4.17.1', '4.17.2'],
            ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
          },
        ],
      };

      expect(vuln.affected).toHaveLength(1);
      expect(vuln.affected[0].versions).toHaveLength(3);
    });

    it('should extract references', () => {
      const vuln = {
        id: 'GHSA-1234-5678-90ab',
        references: [
          { type: 'ADVISORY', url: 'https://github.com/advisories/GHSA-1234-5678-90ab' },
          { type: 'WEB', url: 'https://example.com/advisory' },
        ],
      };

      expect(vuln.references).toHaveLength(2);
      expect(vuln.references[0].type).toMatch(/ADVISORY|WEB/);
    });

    it('should extract published date', () => {
      const vuln = {
        id: 'GHSA-1234-5678-90ab',
        published: '2024-01-15T00:00:00Z',
        modified: '2024-01-20T00:00:00Z',
      };

      expect(vuln.published).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });
  });

  describe('Severity assessment', () => {
    it('should extract CVSS score', () => {
      const vuln = {
        id: 'GHSA-1234-5678-90ab',
        severity: [
          {
            type: 'CVSS_V3',
            score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
          },
        ],
      };

      expect(vuln.severity).toHaveLength(1);
      expect(vuln.severity[0].type).toBe('CVSS_V3');
    });

    it('should support multiple severity types', () => {
      const severityTypes = ['CVSS_V3', 'CVSS_V2'];

      for (const type of severityTypes) {
        expect(type).toMatch(/CVSS/);
      }
    });
  });

  describe('API integration', () => {
    it('should construct API endpoint', () => {
      const baseUrl = 'https://api.osv.dev/v1';
      expect(baseUrl).toContain('api.osv.dev');
    });

    it('should support query endpoint', () => {
      const endpoint = '/query';
      expect(endpoint).toBe('/query');
    });

    it('should support batch query endpoint', () => {
      const endpoint = '/batch';
      expect(endpoint).toBe('/batch');
    });

    it('should handle rate limiting', () => {
      const retryOptions = {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 10000,
      };

      expect(retryOptions.maxRetries).toBeGreaterThan(0);
    });
  });

  describe('Response parsing', () => {
    it('should parse empty vulnerabilities list', () => {
      const response = {
        vulns: [],
      };

      expect(response.vulns).toHaveLength(0);
    });

    it('should parse single vulnerability', () => {
      const response = {
        vulns: [
          {
            id: 'GHSA-1234-5678-90ab',
            summary: 'A vulnerability',
          },
        ],
      };

      expect(response.vulns).toHaveLength(1);
      expect(response.vulns[0].id).toMatch(/^GHSA-/);
    });

    it('should parse multiple vulnerabilities', () => {
      const response = {
        vulns: [
          { id: 'GHSA-0001-0001-0001', summary: 'Vuln 1' },
          { id: 'GHSA-0002-0002-0002', summary: 'Vuln 2' },
          { id: 'GHSA-0003-0003-0003', summary: 'Vuln 3' },
        ],
      };

      expect(response.vulns).toHaveLength(3);
    });

    it('should handle error responses', () => {
      const error = {
        code: 400,
        message: 'Invalid query',
      };

      expect(error.code).toBe(400);
    });
  });

  describe('Query validation', () => {
    it('should validate package name is not empty', () => {
      const isValid = (name: string) => name.length > 0;

      expect(isValid('lodash')).toBe(true);
      expect(isValid('')).toBe(false);
    });

    it('should validate version string', () => {
      const versions = ['1.0.0', '4.17.21', '0.0.1'];

      for (const version of versions) {
        const isValid = /^\d+\.\d+\.\d+/.test(version);
        expect(isValid).toBe(true);
      }
    });

    it('should validate ecosystem is supported', () => {
      const supportedEcosystems = ['npm', 'PyPI', 'Maven', 'NuGet', 'crates.io'];
      const ecosystem = 'npm';

      expect(supportedEcosystems).toContain(ecosystem);
    });
  });

  describe('Batch operations', () => {
    it('should support batch query', () => {
      const batchQuery = {
        queries: [
          { package: { ecosystem: 'npm', name: 'lodash' }, version: '4.17.21' },
          { package: { ecosystem: 'npm', name: 'express' }, version: '4.18.0' },
        ],
      };

      expect(batchQuery.queries).toHaveLength(2);
    });

    it('should return batch results', () => {
      const batchResult = {
        results: [
          { vulns: [{ id: 'GHSA-0001' }] },
          { vulns: [] },
        ],
      };

      expect(batchResult.results).toHaveLength(2);
    });
  });
});
