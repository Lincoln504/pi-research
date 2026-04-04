/**
 * Security Searcher Unit Tests
 *
 * Tests the refactored security searcher with dependency injection.
 * Uses mock implementations for all API clients to test without real API calls.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  SecuritySearcher,
  createSecuritySearcher,
  getSecuritySearcher,
  setSecuritySearcher,
  resetSecuritySearcher,
  type SecuritySearcherConfig,
  searchSecurityDatabases,
  getDatabaseInfo,
} from '../../../src/security/index';
import type {
  SecuritySearchParams,
  INVDClient,
  ICisaKevClient,
  IGitHubAdvisoriesClient,
  IOSVClient,
  Vulnerability,
  Advisory,
  NVDResult,
  CisaKevResult,
  GitHubResult,
  OSVResult,
  NVDSearchOptions,
  CisaKevSearchOptions,
  GitHubSearchOptions,
  OSVSearchOptions,
} from '../../../src/security/types';

// Mock implementations of API clients

class MockNVDClient implements INVDClient {
  private readonly mockResults: Map<string, NVDResult> = new Map();
  private readonly mockById: Map<string, Vulnerability | null> = new Map();
  private searchCalls: Array<{ terms: readonly string[]; options?: NVDSearchOptions }> = [];

  setMockResult(key: string, result: NVDResult): void {
    this.mockResults.set(key, result);
  }

  setMockById(id: string, result: Vulnerability | null): void {
    this.mockById.set(id, result);
  }

  getSearchCalls() {
    return this.searchCalls;
  }

  clear(): void {
    this.mockResults.clear();
    this.mockById.clear();
    this.searchCalls = [];
  }

  async search(terms: readonly string[], options?: NVDSearchOptions): Promise<NVDResult> {
    this.searchCalls.push({ terms, options });
    const key = terms.join(',') + JSON.stringify(options ?? {});
    // Try with full options first, then fall back to just terms
    return this.mockResults.get(key) ?? this.mockResults.get(terms.join(',')) ?? { count: 0, vulnerabilities: [] };
  }

  async getById(cveId: string): Promise<Vulnerability | null> {
    return this.mockById.get(cveId) ?? null;
  }
}

class MockCisaKevClient implements ICisaKevClient {
  private readonly mockResults: Map<string, CisaKevResult> = new Map();
  private searchCalls: Array<{ terms: readonly string[]; options?: CisaKevSearchOptions }> = [];

  setMockResult(key: string, result: CisaKevResult): void {
    this.mockResults.set(key, result);
  }

  getSearchCalls() {
    return this.searchCalls;
  }

  clear(): void {
    this.mockResults.clear();
    this.searchCalls = [];
  }

  async search(terms: readonly string[], options?: CisaKevSearchOptions): Promise<CisaKevResult> {
    this.searchCalls.push({ terms, options });
    const key = terms.join(',') + JSON.stringify(options ?? {});
    return this.mockResults.get(key) ?? this.mockResults.get(terms.join(',')) ?? { count: 0, vulnerabilities: [] };
  }
}

class MockGitHubClient implements IGitHubAdvisoriesClient {
  private readonly mockResults: Map<string, GitHubResult> = new Map();
  private readonly mockById: Map<string, Advisory | null> = new Map();
  private searchCalls: Array<{ terms: readonly string[]; options?: GitHubSearchOptions }> = [];

  setMockResult(key: string, result: GitHubResult): void {
    this.mockResults.set(key, result);
  }

  setMockById(id: string, result: Advisory | null): void {
    this.mockById.set(id, result);
  }

  getSearchCalls() {
    return this.searchCalls;
  }

  clear(): void {
    this.mockResults.clear();
    this.mockById.clear();
    this.searchCalls = [];
  }

  async search(terms: readonly string[], options?: GitHubSearchOptions): Promise<GitHubResult> {
    this.searchCalls.push({ terms, options });
    const key = terms.join(',') + JSON.stringify(options ?? {});
    return this.mockResults.get(key) ?? this.mockResults.get(terms.join(',')) ?? { count: 0, advisories: [] };
  }

  async getById(id: string): Promise<Advisory | null> {
    return this.mockById.get(id) ?? null;
  }
}

class MockOSVClient implements IOSVClient {
  private readonly mockResults: Map<string, OSVResult> = new Map();
  private readonly mockById: Map<string, Vulnerability | null> = new Map();
  private searchCalls: Array<{ terms: readonly string[]; options?: OSVSearchOptions }> = [];

  setMockResult(key: string, result: OSVResult): void {
    this.mockResults.set(key, result);
  }

  setMockById(id: string, result: Vulnerability | null): void {
    this.mockById.set(id, result);
  }

  getSearchCalls() {
    return this.searchCalls;
  }

  clear(): void {
    this.mockResults.clear();
    this.mockById.clear();
    this.searchCalls = [];
  }

  async search(terms: readonly string[], options?: OSVSearchOptions): Promise<OSVResult> {
    this.searchCalls.push({ terms, options });
    const key = terms.join(',') + JSON.stringify(options ?? {});
    return this.mockResults.get(key) ?? this.mockResults.get(terms.join(',')) ?? { count: 0, vulnerabilities: [] };
  }

  async getById(osvId: string): Promise<Vulnerability | null> {
    return this.mockById.get(osvId) ?? null;
  }
}

// Mock data helpers
function createMockVulnerability(overrides: Partial<Vulnerability> = {}): Vulnerability {
  return {
    id: 'CVE-2023-1234',
    source: 'nvd',
    severity: 'HIGH',
    description: 'Test vulnerability',
    published: '2023-01-01',
    modified: '2023-01-02',
    cvssScore: 8.5,
    cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    cwes: ['CWE-79'],
    references: ['https://example.com'],
    affectedProducts: ['product:v1.0'],
    fixes: [],
    ...overrides,
  };
}

function createMockAdvisory(overrides: Partial<Advisory> = {}): Advisory {
  return {
    id: 'GHSA-abc1-23de-fg45',
    source: 'github',
    severity: 'HIGH',
    summary: 'Test advisory',
    description: 'Test advisory description',
    published: '2023-01-01',
    modified: '2023-01-02',
    cveId: 'CVE-2023-1234',
    references: ['https://github.com'],
    affectedPackages: ['npm/package'],
    ...overrides,
  };
}

/**
 * Helper to create a SecuritySearcher with no request delay for fast tests
 */
function createFastSearcher(config?: Partial<SecuritySearcherConfig>): SecuritySearcher {
  return new SecuritySearcher({
    requestDelay: 0,
    ...config,
  });
}

describe('SecuritySearcher', () => {
  afterEach(() => {
    resetSecuritySearcher();
  });

  describe('constructor', () => {
    it('should create searcher with default config', () => {
      const searcher = createFastSearcher();

      expect(searcher).toBeDefined();
    });

    it('should create searcher with custom clients', () => {
      const mockNVD = new MockNVDClient();
      const mockCisa = new MockCisaKevClient();
      const mockGitHub = new MockGitHubClient();
      const mockOSV = new MockOSVClient();

      const searcher = createFastSearcher({
        nvdClient: mockNVD,
        cisaKevClient: mockCisa,
        githubAdvisoriesClient: mockGitHub,
        osvClient: mockOSV,
      });

      expect(searcher).toBeDefined();
    });

    it('should create searcher with custom request delay', () => {
      const searcher = createFastSearcher({ requestDelay: 1000 });

      expect(searcher).toBeDefined();
    });
  });

  describe('search with NVD', () => {
    it('should search NVD database', async () => {
      const mockNVD = new MockNVDClient();
      mockNVD.setMockResult('test', {
        count: 1,
        vulnerabilities: [createMockVulnerability()],
      });

      const searcher = createFastSearcher({ nvdClient: mockNVD });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['nvd'],
      };

      const result = await searcher.search(params);

      expect(result.totalDatabases).toBe(1);
      expect(result.totalVulnerabilities).toBe(1);
      expect(result.results.nvd?.count).toBe(1);
      expect(result.results.nvd?.vulnerabilities).toHaveLength(1);
    });

    it('should pass search options to NVD client', async () => {
      const mockNVD = new MockNVDClient();
      mockNVD.setMockResult('test{"severity":"HIGH","maxResults":10}', {
        count: 1,
        vulnerabilities: [createMockVulnerability()],
      });

      const searcher = createFastSearcher({ nvdClient: mockNVD });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['nvd'],
        severity: 'HIGH',
        maxResults: 10,
        includeExploited: true,
      };

      await searcher.search(params);

      const calls = mockNVD.getSearchCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.terms).toEqual(['test']);
      expect(calls[0]!.options?.severity).toBe('HIGH');
      expect(calls[0]!.options?.maxResults).toBe(10);
      expect(calls[0]!.options?.includeExploited).toBe(true);
    });

    it('should handle NVD errors', async () => {
      const mockNVD = new MockNVDClient();
      mockNVD.setMockResult('test', {
        count: 0,
        vulnerabilities: [],
        error: 'NVD API error',
      });

      const searcher = createFastSearcher({ nvdClient: mockNVD });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['nvd'],
      };

      const result = await searcher.search(params);

      expect(result.totalDatabases).toBe(1);
      expect(result.results.nvd?.error).toBe('NVD API error');
    });

    it('should catch NVD exceptions', async () => {
      const mockNVD = new MockNVDClient();
      mockNVD.search = vi.fn().mockRejectedValue(new Error('Network error'));

      const searcher = createFastSearcher({ nvdClient: mockNVD });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['nvd'],
      };

      const result = await searcher.search(params);

      // Should complete without throwing
      expect(result).toBeDefined();
      expect(result.totalDatabases).toBe(0);
    });
  });

  describe('search with CISA KEV', () => {
    it('should search CISA KEV database', async () => {
      const mockCisa = new MockCisaKevClient();
      mockCisa.setMockResult('test{}', {
        count: 2,
        vulnerabilities: [
          createMockVulnerability({ id: 'CVE-2023-1001', source: 'cisa_kev' }),
          createMockVulnerability({ id: 'CVE-2023-1002', source: 'cisa_kev' }),
        ],
      });

      const searcher = createFastSearcher({ cisaKevClient: mockCisa });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['cisa_kev'],
      };

      const result = await searcher.search(params);

      expect(result.totalDatabases).toBe(1);
      expect(result.totalVulnerabilities).toBe(2);
      expect(result.results.cisa_kev?.count).toBe(2);
    });

    it('should pass search options to CISA KEV client', async () => {
      const mockCisa = new MockCisaKevClient();
      mockCisa.setMockResult('test{"vendor":"vendor1","product":"product1"}', {
        count: 1,
        vulnerabilities: [createMockVulnerability()],
      });

      const searcher = createFastSearcher({ cisaKevClient: mockCisa });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['cisa_kev'],
      };

      await searcher.search(params);

      const calls = mockCisa.getSearchCalls();
      expect(calls).toHaveLength(1);
    });
  });

  describe('search with GitHub', () => {
    it('should search GitHub Advisories', async () => {
      const mockGitHub = new MockGitHubClient();
      mockGitHub.setMockResult('test{}', {
        count: 1,
        advisories: [createMockAdvisory()],
      });

      const searcher = createFastSearcher({ githubAdvisoriesClient: mockGitHub });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['github'],
      };

      const result = await searcher.search(params);

      expect(result.totalDatabases).toBe(1);
      expect(result.results.github?.count).toBe(1);
      expect(result.results.github?.advisories).toHaveLength(1);
    });

    it('should pass search options to GitHub client', async () => {
      const mockGitHub = new MockGitHubClient();
      mockGitHub.setMockResult('test{"ecosystem":"npm","maxResults":10}', {
        count: 1,
        advisories: [createMockAdvisory()],
      });

      const searcher = createFastSearcher({ githubAdvisoriesClient: mockGitHub });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['github'],
        ecosystem: 'npm',
        maxResults: 10,
        githubRepo: 'owner/repo',
      };

      await searcher.search(params);

      const calls = mockGitHub.getSearchCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.options?.ecosystem).toBe('npm');
      expect(calls[0]!.options?.maxResults).toBe(10);
      expect(calls[0]!.options?.repo).toBe('owner/repo');
    });
  });

  describe('search with OSV', () => {
    it('should search OSV database', async () => {
      const mockOSV = new MockOSVClient();
      mockOSV.setMockResult('test{}', {
        count: 1,
        vulnerabilities: [createMockVulnerability({ source: 'osv' })],
      });

      const searcher = createFastSearcher({ osvClient: mockOSV });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['osv'],
      };

      const result = await searcher.search(params);

      expect(result.totalDatabases).toBe(1);
      expect(result.totalVulnerabilities).toBe(1);
      expect(result.results.osv?.count).toBe(1);
    });

    it('should pass search options to OSV client', async () => {
      const mockOSV = new MockOSVClient();
      mockOSV.setMockResult('test{"ecosystem":"PyPI","maxResults":10}', {
        count: 1,
        vulnerabilities: [createMockVulnerability({ source: 'osv' })],
      });

      const searcher = createFastSearcher({ osvClient: mockOSV });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['osv'],
        ecosystem: 'PyPI',
        maxResults: 10,
      };

      await searcher.search(params);

      const calls = mockOSV.getSearchCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.options?.ecosystem).toBe('PyPI');
      expect(calls[0]!.options?.maxResults).toBe(10);
    });
  });

  describe('search with multiple databases', () => {
    it('should search all requested databases', async () => {
      const mockNVD = new MockNVDClient();
      const mockCisa = new MockCisaKevClient();
      const mockGitHub = new MockGitHubClient();
      const mockOSV = new MockOSVClient();

      mockNVD.setMockResult('test', { count: 1, vulnerabilities: [createMockVulnerability()] });
      mockCisa.setMockResult('test{}', { count: 1, vulnerabilities: [createMockVulnerability()] });
      mockGitHub.setMockResult('test{}', { count: 1, advisories: [createMockAdvisory()] });
      mockOSV.setMockResult('test{}', { count: 1, vulnerabilities: [createMockVulnerability()] });

      const searcher = createFastSearcher({
        nvdClient: mockNVD,
        cisaKevClient: mockCisa,
        githubAdvisoriesClient: mockGitHub,
        osvClient: mockOSV,
      });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['nvd', 'cisa_kev', 'github', 'osv'],
      };

      const result = await searcher.search(params);

      expect(result.totalDatabases).toBe(4);
      expect(result.totalVulnerabilities).toBe(4); // Each database returns count: 1
      expect(result.results.nvd).toBeDefined();
      expect(result.results.cisa_kev).toBeDefined();
      expect(result.results.github).toBeDefined();
      expect(result.results.osv).toBeDefined();
    });

    it('should handle empty database list', async () => {
      const searcher = createFastSearcher();

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: [],
      };

      const result = await searcher.search(params);

      expect(result.totalDatabases).toBe(0);
      expect(result.totalVulnerabilities).toBe(0);
      expect(result.results).toEqual({});
    });
  });

  describe('search results', () => {
    it('should include duration in results', async () => {
      const mockNVD = new MockNVDClient();
      mockNVD.setMockResult('test', { count: 1, vulnerabilities: [createMockVulnerability()] });

      const searcher = createFastSearcher({ nvdClient: mockNVD });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['nvd'],
      };

      const result = await searcher.search(params);

      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(typeof result.duration).toBe('number');
    });

    it('should aggregate vulnerability counts correctly', async () => {
      const mockNVD = new MockNVDClient();
      mockNVD.setMockResult('test', { count: 5, vulnerabilities: [] });
      const mockCisa = new MockCisaKevClient();
      mockCisa.setMockResult('test{}', { count: 3, vulnerabilities: [] });

      const searcher = new SecuritySearcher({
        nvdClient: mockNVD,
        cisaKevClient: mockCisa,
      });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['nvd', 'cisa_kev'],
      };

      const result = await searcher.search(params);

      expect(result.totalVulnerabilities).toBe(8);
    });
  });

  describe('severity filtering', () => {
    it('should pass valid severity to NVD', async () => {
      const mockNVD = new MockNVDClient();
      mockNVD.setMockResult('test,{"severity":"HIGH"}', { count: 1, vulnerabilities: [] });

      const searcher = createFastSearcher({ nvdClient: mockNVD });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['nvd'],
        severity: 'HIGH',
      };

      await searcher.search(params);

      const calls = mockNVD.getSearchCalls();
      expect(calls[0]!.options?.severity).toBe('HIGH');
    });

    it('should ignore invalid severity', async () => {
      const mockNVD = new MockNVDClient();
      mockNVD.setMockResult('test', { count: 1, vulnerabilities: [] });

      const searcher = createFastSearcher({ nvdClient: mockNVD });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['nvd'],
        severity: 'INVALID',
      } as any;

      await searcher.search(params);

      const calls = mockNVD.getSearchCalls();
      expect(calls[0]!.options?.severity).toBeUndefined();
    });
  });

  describe('request delay', () => {
    it('should apply request delay when configured', async () => {
      const mockNVD = new MockNVDClient();
      mockNVD.setMockResult('test', { count: 1, vulnerabilities: [] });

      const searcher = new SecuritySearcher({
        nvdClient: mockNVD,
        requestDelay: 100,
      });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['nvd'],
      };

      const startTime = Date.now();
      await searcher.search(params);
      const duration = Date.now() - startTime;

      expect(duration).toBeGreaterThanOrEqual(100);
    });

    it('should not apply delay when set to 0', async () => {
      const mockNVD = new MockNVDClient();
      mockNVD.setMockResult('test', { count: 1, vulnerabilities: [] });

      const searcher = new SecuritySearcher({
        nvdClient: mockNVD,
        requestDelay: 0,
      });

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['nvd'],
      };

      const startTime = Date.now();
      await searcher.search(params);
      const duration = Date.now() - startTime;

      // Should be very fast
      expect(duration).toBeLessThan(50);
    });
  });
});

describe('factory functions', () => {
  afterEach(() => {
    resetSecuritySearcher();
  });

  describe('createSecuritySearcher', () => {
    it('should create searcher with default config', () => {
      const searcher = createSecuritySearcher();

      expect(searcher).toBeInstanceOf(SecuritySearcher);
    });

    it('should create searcher with custom config', () => {
      const mockNVD = new MockNVDClient();
      const searcher = createSecuritySearcher({ nvdClient: mockNVD });

      expect(searcher).toBeInstanceOf(SecuritySearcher);
    });
  });

  describe('global state', () => {
    it('should return same instance on subsequent calls', () => {
      const searcher1 = getSecuritySearcher();
      const searcher2 = getSecuritySearcher();

      expect(searcher1).toBe(searcher2);
    });

    it('should set custom searcher', () => {
      const customSearcher = new SecuritySearcher();
      setSecuritySearcher(customSearcher);

      expect(getSecuritySearcher()).toBe(customSearcher);
    });

    it('should reset global searcher', () => {
      const customSearcher = new SecuritySearcher();
      setSecuritySearcher(customSearcher);
      expect(getSecuritySearcher()).toBe(customSearcher);

      resetSecuritySearcher();
      const newSearcher = getSecuritySearcher();
      expect(newSearcher).not.toBe(customSearcher);
    });

    it('should handle null setter', () => {
      setSecuritySearcher(null);
      const searcher = getSecuritySearcher();
      expect(searcher).toBeInstanceOf(SecuritySearcher);
    });
  });
});

describe('backward compatibility', () => {
  afterEach(() => {
    resetSecuritySearcher();
  });

  describe('searchSecurityDatabases', () => {
    it('should use global searcher', async () => {
      const mockNVD = new MockNVDClient();
      mockNVD.setMockResult('test', { count: 1, vulnerabilities: [createMockVulnerability()] });

      const searcher = createFastSearcher({ nvdClient: mockNVD });
      setSecuritySearcher(searcher);

      const params: SecuritySearchParams = {
        terms: ['test'],
        databases: ['nvd'],
      };

      const result = await searchSecurityDatabases(params);

      expect(result.totalDatabases).toBe(1);
      expect(result.totalVulnerabilities).toBe(1);
    });
  });

  describe('getDatabaseInfo', () => {
    it('should return database information', () => {
      const info = getDatabaseInfo();

      expect(info.databases).toHaveLength(4);
      expect(info.databases[0]!.id).toBe('nvd');
      expect(info.databases[1]!.id).toBe('cisa_kev');
      expect(info.databases[2]!.id).toBe('github');
      expect(info.databases[3]!.id).toBe('osv');
    });

    it('should include required fields', () => {
      const info = getDatabaseInfo();

      for (const db of info.databases) {
        expect(db.id).toBeDefined();
        expect(db.name).toBeDefined();
        expect(db.description).toBeDefined();
        expect(db.url).toBeDefined();
        expect(typeof db.free).toBe('boolean');
      }
    });
  });
});

describe('client interfaces', () => {
  describe('MockNVDClient', () => {
    it('should implement INVDClient', () => {
      const client = new MockNVDClient();

      expect(client.search).toBeDefined();
      expect(client.getById).toBeDefined();
    });

    it('should store search calls', async () => {
      const client = new MockNVDClient();

      await client.search(['test'], { severity: 'HIGH' });

      const calls = client.getSearchCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.terms).toEqual(['test']);
      expect(calls[0]!.options?.severity).toBe('HIGH');
    });

    it('should return mock results', async () => {
      const client = new MockNVDClient();
      const mockResult = { count: 5, vulnerabilities: [createMockVulnerability()] };
      client.setMockResult('test{}', mockResult);

      const result = await client.search(['test']);

      expect(result.count).toBe(5);
      expect(result.vulnerabilities).toHaveLength(1);
    });
  });

  describe('MockGitHubClient', () => {
    it('should implement IGitHubAdvisoriesClient', () => {
      const client = new MockGitHubClient();

      expect(client.search).toBeDefined();
      expect(client.getById).toBeDefined();
    });

    it('should return mock advisories', async () => {
      const client = new MockGitHubClient();
      const mockResult = { count: 3, advisories: [createMockAdvisory()] };
      client.setMockResult('test{}', mockResult);

      const result = await client.search(['test']);

      expect(result.count).toBe(3);
      expect(result.advisories).toHaveLength(1);
    });
  });
});
