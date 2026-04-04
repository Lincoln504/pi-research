/**
 * Security Search Tool Unit Tests
 *
 * Tests the createSecuritySearchTool function and core behaviors.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSecuritySearchTool } from '../../../src/tools/security';

// Mock the search function
vi.mock('../../../src/security/index.js', () => ({
  searchSecurityDatabases: vi.fn(),
}));

describe('tools/security', () => {
  const createMockContext = () => ({
    settingsManager: {
      get: vi.fn(),
      set: vi.fn(),
    },
  } as any);

  describe('createSecuritySearchTool', () => {
    it('should create tool with correct name', () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect(tool.name).toBe('security_search');
    });

    it('should create tool with correct label', () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect(tool.label).toBe('Security Search');
    });

    it('should create tool with correct description', () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect(tool.description).toContain('security vulnerability');
      expect(tool.description).toContain('NVD');
      expect(tool.description).toContain('CISA');
      expect(tool.description).toContain('GitHub');
      expect(tool.description).toContain('OSV');
    });

    it('should have prompt snippet', () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect(tool.promptSnippet).toBeDefined();
      expect(tool.promptSnippet!.toLowerCase()).toContain('security');
      expect(tool.promptSnippet!.toLowerCase()).toContain('cve');
    });

    it('should have prompt guidelines', () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect(tool.promptGuidelines).toBeDefined();
      expect(Array.isArray(tool.promptGuidelines)).toBe(true);
      expect(tool.promptGuidelines!.length).toBeGreaterThan(0);
    });

    it('should have prompt guidelines mentioning NVD, CISA, GitHub, OSV', () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const guidelines = tool.promptGuidelines!.join(' ');
      expect(guidelines).toContain('NVD');
      expect(guidelines).toContain('CISA');
      expect(guidelines).toContain('GitHub');
      expect(guidelines).toContain('OSV');
    });

    it('should have prompt guidelines mentioning filters', () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const guidelines = tool.promptGuidelines!.join(' ');
      expect(guidelines).toContain('severity');
      expect(guidelines).toContain('CVE ID');
      expect(guidelines).toContain('package');
    });
  });

  describe('parameters', () => {
    it('should require terms parameter', () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect(tool.parameters).toBeDefined();
      expect((tool.parameters as any).properties).toHaveProperty('terms');
    });

    it('should have terms as array of strings', () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const termsParam = (tool.parameters as any).properties.terms;
      expect(termsParam).toBeDefined();
    });

    it('should have optional databases parameter', () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect((tool.parameters as any).properties).toHaveProperty('databases');
    });

    it('should have optional severity parameter', () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect((tool.parameters as any).properties).toHaveProperty('severity');
    });

    it('should have optional maxResults parameter', () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect((tool.parameters as any).properties).toHaveProperty('maxResults');
    });

    it('should have optional includeExploited parameter', () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect((tool.parameters as any).properties).toHaveProperty('includeExploited');
    });

    it('should have optional ecosystem parameter', () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect((tool.parameters as any).properties).toHaveProperty('ecosystem');
    });

    it('should have optional githubRepo parameter', () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect((tool.parameters as any).properties).toHaveProperty('githubRepo');
    });
  });

  describe('execute - parameter validation', () => {
    it('should throw error when params is not valid', async () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      await expect(
        tool.execute('test-id', {} as any, undefined, undefined, undefined as any)
      ).rejects.toThrow('Invalid parameters for security_search');
    });

    it('should throw error when terms array is empty', async () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      await expect(
        tool.execute('test-id', { terms: [] }, undefined, undefined, undefined as any)
      ).rejects.toThrow('At least one search term is required');
    });

    it('should throw error when terms is missing', async () => {
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      await expect(
        tool.execute('test-id', { databases: ['nvd'] }, undefined, undefined, undefined as any)
      ).rejects.toThrow('Invalid parameters for security_search');
    });

    it('should accept single term', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.js');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalDatabases: 1,
        totalVulnerabilities: 0,
        duration: 0,
        results: {},
      } as any);

      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { terms: ['CVE-2024-1234'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it('should accept multiple terms', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.js');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalDatabases: 1,
        totalVulnerabilities: 0,
        duration: 0,
        results: {},
      } as any);

      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { terms: ['CVE-2024-1234', 'openssl'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(result).toBeDefined();
    });
  });

  describe('execute - database selection', () => {
    it('should search all databases by default', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.js');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalDatabases: 4,
        totalVulnerabilities: 0,
        duration: 0,
        results: {},
      } as any);

      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      await tool.execute(
        'test-id',
        { terms: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(searchSecurityDatabases).toHaveBeenCalledWith(
        expect.objectContaining({
          databases: ['nvd', 'cisa_kev', 'github', 'osv'],
        })
      );
    });

    it('should search specific databases when provided', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.js');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalDatabases: 1,
        totalVulnerabilities: 0,
        duration: 0,
        results: {},
      } as any);

      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      await tool.execute(
        'test-id',
        { terms: ['test'], databases: ['nvd', 'github'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(searchSecurityDatabases).toHaveBeenCalledWith(
        expect.objectContaining({
          databases: ['nvd', 'github'],
        })
      );
    });
  });

  describe('execute - result formatting', () => {
    it('should return text content', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.js');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalDatabases: 1,
        totalVulnerabilities: 0,
        duration: 0,
        results: {},
      } as any);

      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { terms: ['CVE-2024-1234'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(result.content[0]?.type).toBe('text');
      expect((result.content[0] as any)?.text).toBeDefined();
    });

    it('should include terms in output', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.js');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalDatabases: 1,
        totalVulnerabilities: 0,
        duration: 0,
        results: {},
      } as any);

      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { terms: ['CVE-2024-1234', 'openssl'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('CVE-2024-1234');
      expect((result.content[0] as any)?.text).toContain('openssl');
    });

    it('should include duration in output', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.js');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalDatabases: 1,
        totalVulnerabilities: 0,
        duration: 0,
        results: {},
      } as any);

      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { terms: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('Duration');
      expect((result.content[0] as any)?.text).toContain('s');
    });
  });

  describe('execute - NVD results', () => {
    it('should format NVD results', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.js');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalDatabases: 1,
        totalVulnerabilities: 2,
        duration: 0,
        results: {
          nvd: {
            count: 2,
            vulnerabilities: [
              {
                id: 'CVE-2024-1234',
                severity: 'HIGH',
                cvssScore: 8.5,
                cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
                description: 'A vulnerability in...',
                knownExploited: false,
                published: '2024-01-15',
              },
              {
                id: 'CVE-2024-5678',
                severity: 'CRITICAL',
                cvssScore: 9.8,
                cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
                description: 'Another vulnerability...',
                knownExploited: true,
                cwes: ['CWE-79', 'CWE-89'],
                published: '2024-02-01',
              },
            ],
          },
        },
      } as any);

      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { terms: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('NIST NVD');
      expect((result.content[0] as any)?.text).toContain('CVE-2024-1234');
      expect((result.content[0] as any)?.text).toContain('CVE-2024-5678');
      expect((result.content[0] as any)?.text).toContain('HIGH');
      expect((result.content[0] as any)?.text).toContain('CRITICAL');
      expect((result.content[0] as any)?.text).toContain('Actively Exploited');
    });

    it('should handle NVD errors', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.js');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalDatabases: 1,
        totalVulnerabilities: 0,
        duration: 0,
        results: {
          nvd: {
            count: 0,
            vulnerabilities: [],
            error: 'Network timeout',
          },
        },
      } as any);

      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { terms: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('NIST NVD');
      expect((result.content[0] as any)?.text).toContain('❌');
      expect((result.content[0] as any)?.text).toContain('Error');
    });
  });

  describe('execute - CISA KEV results', () => {
    it('should format CISA KEV results', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.js');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalDatabases: 1,
        totalVulnerabilities: 1,
        duration: 0,
        results: {
          cisa_kev: {
            count: 1,
            vulnerabilities: [
              {
                id: 'CVE-2024-5678',
                vendor: 'Test Vendor',
                product: 'Test Product',
                description: 'Actively exploited vulnerability...',
                dueDate: '2024-03-15',
                requiredAction: 'Apply patch immediately',
              },
            ],
          },
        },
      } as any);

      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { terms: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('CISA Known Exploited Vulnerabilities');
      expect((result.content[0] as any)?.text).toContain('CVE-2024-5678');
      expect((result.content[0] as any)?.text).toContain('Test Vendor');
      expect((result.content[0] as any)?.text).toContain('Test Product');
      expect((result.content[0] as any)?.text).toContain('Due Date');
      expect((result.content[0] as any)?.text).toContain('Required Action');
    });
  });

  describe('execute - details object', () => {
    it('should include results in details', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.js');
      const mockResults = {
        totalDatabases: 1,
        totalVulnerabilities: 2,
        duration: 0,
        results: {},
      };
      vi.mocked(searchSecurityDatabases).mockResolvedValue(mockResults as any);

      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { terms: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(result.details).toBeDefined();
      expect((result.details as any).results).toEqual(mockResults);
    });

    it('should include totalDatabases in details', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.js');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalDatabases: 3,
        totalVulnerabilities: 0,
        duration: 0,
        results: {},
      } as any);

      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { terms: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.details as any).totalDatabases).toBe(3);
    });

    it('should include totalVulnerabilities in details', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.js');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalDatabases: 1,
        totalVulnerabilities: 42,
        duration: 0,
        results: {},
      } as any);

      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { terms: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.details as any).totalVulnerabilities).toBe(42);
    });

    it('should include duration in details', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.js');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalDatabases: 1,
        totalVulnerabilities: 0,
        duration: 0,
        results: {},
      } as any);

      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { terms: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.details as any).duration).toBeDefined();
      expect(typeof (result.details as any).duration).toBe('number');
      expect((result.details as any).duration).toBeGreaterThanOrEqual(0);
    });
  });
});
