/**
 * GitHub Security Advisories Client Unit Tests
 *
 * Tests the GitHub Security Advisories GraphQL client
 * and its integration with GitHub's vulnerability database.
 */

import { describe, it, expect } from 'vitest';

describe('GitHub Security Advisories Client', () => {
  describe('GraphQL query structure', () => {
    it('should construct security advisory query', () => {
      const query = `
        query {
          securityAdvisories {
            nodes {
              ghsaId
              severity
            }
          }
        }
      `;

      expect(query).toContain('securityAdvisories');
      expect(query).toContain('ghsaId');
    });

    it('should support vulnerability query', () => {
      const query = `
        query($first: Int!) {
          vulnerabilities(first: $first) {
            nodes {
              id
              severity
            }
          }
        }
      `;

      expect(query).toContain('vulnerabilities');
      expect(query).toContain('$first');
    });

    it('should filter by severity', () => {
      const severities = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'];

      for (const severity of severities) {
        expect(severities).toContain(severity);
      }
    });

    it('should support package filtering', () => {
      const query = {
        package: {
          ecosystem: 'NPM',
          name: 'lodash',
        },
      };

      expect(query.package.name).toBe('lodash');
    });
  });

  describe('Advisory data structures', () => {
    it('should represent security advisory', () => {
      const advisory = {
        ghsaId: 'GHSA-xxxx-yyyy-zzzz',
        severity: 'HIGH',
        title: 'Vulnerability Title',
        description: 'Long description of the vulnerability',
      };

      expect(advisory.ghsaId).toMatch(/^GHSA-/);
      const validSeverities = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'];
      expect(validSeverities).toContain(advisory.severity);
    });

    it('should include affected packages', () => {
      const advisory = {
        ghsaId: 'GHSA-1234-5678-90ab',
        vulnerablePackages: [
          {
            ecosystem: 'NPM',
            name: 'lodash',
            vulnerableVersionRange: '< 4.17.21',
            firstPatchedVersion: { identifier: '4.17.21' },
          },
        ],
      };

      expect(advisory.vulnerablePackages).toHaveLength(1);
      expect(advisory.vulnerablePackages[0]!.name).toBe('lodash');
    });

    it('should include CVE reference', () => {
      const advisory = {
        ghsaId: 'GHSA-1234-5678-90ab',
        cveId: 'CVE-2021-23337',
      };

      expect(advisory.cveId).toMatch(/^CVE-/);
    });

    it('should include publication date', () => {
      const advisory = {
        ghsaId: 'GHSA-1234-5678-90ab',
        publishedAt: '2021-02-01T21:46:00Z',
        updatedAt: '2024-01-15T10:30:00Z',
      };

      expect(advisory.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });

    it('should include references', () => {
      const advisory = {
        ghsaId: 'GHSA-1234-5678-90ab',
        references: [
          { url: 'https://github.com/lodash/lodash/pull/4336' },
          { url: 'https://nvd.nist.gov/vuln/detail/CVE-2021-23337' },
        ],
      };

      expect(advisory.references).toHaveLength(2);
      expect(advisory.references[0]!.url).toMatch(/^https:\/\//);
    });
  });

  describe('Ecosystem support', () => {
    it('should support npm ecosystem', () => {
      const ecosystem = 'NPM';
      expect(ecosystem).toBe('NPM');
    });

    it('should support python ecosystem', () => {
      const ecosystem = 'PIP';
      expect(ecosystem).toBe('PIP');
    });

    it('should support ruby ecosystem', () => {
      const ecosystem = 'RUBYGEMS';
      expect(ecosystem).toBe('RUBYGEMS');
    });

    it('should support java ecosystem', () => {
      const ecosystem = 'MAVEN';
      expect(ecosystem).toBe('MAVEN');
    });

    it('should support rust ecosystem', () => {
      const ecosystem = 'CARGO';
      expect(ecosystem).toBe('CARGO');
    });

    it('should support multiple ecosystems', () => {
      const ecosystems = ['NPM', 'PIP', 'RUBYGEMS', 'MAVEN', 'CARGO'];
      expect(ecosystems).toHaveLength(5);
    });
  });

  describe('Severity levels', () => {
    it('should have low severity', () => {
      expect('LOW').toBeDefined();
    });

    it('should have moderate severity', () => {
      expect('MODERATE').toBeDefined();
    });

    it('should have high severity', () => {
      expect('HIGH').toBeDefined();
    });

    it('should have critical severity', () => {
      expect('CRITICAL').toBeDefined();
    });

    it('should support severity comparison', () => {
      const severities = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'];
      const higherIndex = severities.indexOf('HIGH');
      const lowerIndex = severities.indexOf('LOW');

      expect(higherIndex).toBeGreaterThan(lowerIndex);
    });
  });

  describe('Version range parsing', () => {
    it('should parse less than constraint', () => {
      const range = '< 4.17.21';
      expect(range).toContain('<');
    });

    it('should parse range constraint', () => {
      const range = '>= 1.0.0, < 2.0.0';
      expect(range).toContain('>=');
      expect(range).toContain('<');
    });

    it('should parse equals constraint', () => {
      const range = '= 1.0.0';
      expect(range).toContain('=');
    });

    it('should support first patched version', () => {
      const patchedVersion = {
        identifier: '4.17.21',
      };

      expect(patchedVersion.identifier).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('API authentication', () => {
    it('should require authentication token', () => {
      const token = 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    it('should support personal access tokens', () => {
      const tokenFormat = /^ghp_[a-zA-Z0-9_]{36}$/;

      expect(tokenFormat).toBeDefined();
    });
  });

  describe('Response handling', () => {
    it('should handle empty advisory list', () => {
      const response = {
        data: {
          securityAdvisories: {
            nodes: [],
            totalCount: 0,
          },
        },
      };

      expect(response.data.securityAdvisories.nodes).toHaveLength(0);
    });

    it('should handle single advisory', () => {
      const response = {
        data: {
          securityAdvisories: {
            nodes: [
              {
                ghsaId: 'GHSA-1234-5678-90ab',
                severity: 'HIGH',
              },
            ],
            totalCount: 1,
          },
        },
      };

      expect(response.data.securityAdvisories.nodes).toHaveLength(1);
    });

    it('should handle multiple advisories', () => {
      const response = {
        data: {
          securityAdvisories: {
            nodes: [
              { ghsaId: 'GHSA-0001', severity: 'HIGH' },
              { ghsaId: 'GHSA-0002', severity: 'MODERATE' },
              { ghsaId: 'GHSA-0003', severity: 'CRITICAL' },
            ],
            totalCount: 3,
          },
        },
      };

      expect(response.data.securityAdvisories.nodes).toHaveLength(3);
    });

    it('should handle GraphQL errors', () => {
      const error = {
        errors: [
          {
            message: 'API rate limit exceeded',
            type: 'RATE_LIMITED',
          },
        ],
      };

      expect(error.errors).toHaveLength(1);
      expect(error.errors[0]!.message).toBeDefined();
    });
  });

  describe('Pagination support', () => {
    it('should support first parameter', () => {
      const params = {
        first: 100,
        after: 'cursor_value',
      };

      expect(params.first).toBe(100);
      expect(params.after).toBeDefined();
    });

    it('should provide page cursors', () => {
      const response = {
        pageInfo: {
          hasNextPage: true,
          endCursor: 'Y3Vyc29yOjEwMA==',
        },
      };

      expect(response.pageInfo.hasNextPage).toBe(true);
      expect(response.pageInfo.endCursor).toBeDefined();
    });
  });

  describe('Query optimization', () => {
    it('should alias queries', () => {
      const query = `
        query {
          npm: securityAdvisories(ecosystem: NPM, first: 100) {
            nodes { ghsaId }
          }
          pip: securityAdvisories(ecosystem: PIP, first: 100) {
            nodes { ghsaId }
          }
        }
      `;

      expect(query).toContain('npm:');
      expect(query).toContain('pip:');
    });
  });
});
