/**
 * Security Tool Unit Tests
 *
 * Tests the createSecuritySearchTool function and core behaviors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSecuritySearchTool } from '../../../src/tools/security.ts';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker.ts';

// Mock security search function
vi.mock('../../../src/security/index.ts', () => ({
  searchSecurityDatabases: vi.fn(),
}));

describe('tools/security', () => {
  const createMockContext = () => ({} as any);
  const createMockTracker = () => new ToolUsageTracker({ gathering: 6 });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('should create tool with correct metadata', () => {
      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      expect(tool.name).toBe('security_search');
      expect(tool.label).toBe('Security Search');
    });
  });

  describe('execute - tracker', () => {
    it('should record call in tracker', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalVulnerabilities: 0,
        totalDatabases: 0,
        results: {},
        duration: 0,
      });

      const tracker = createMockTracker();
      const spy = vi.spyOn(tracker, 'recordCall');
      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker });
      
      await tool.execute('test-id', { terms: ['test'] }, undefined, undefined, undefined as any);

      expect(spy).toHaveBeenCalledWith('security_search');
    });

    it('should return limit reached message if budget exceeded', async () => {
      const tracker = new ToolUsageTracker({ gathering: 1 });
      tracker.recordCall('security_search'); // Limit reached

      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker });

      const result = await tool.execute('test-id', { terms: ['test'] }, undefined, undefined, undefined as any);
      expect(result.details).toMatchObject({ blocked: true, reason: 'limit_reached' });
      expect((result.content[0] as any).text).toContain('GATHERING LIMIT REACHED');
    });
  });

  describe('execute - validation', () => {
    it('should return error for invalid parameters', async () => {
      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      // Missing required `terms` field
      const result = await tool.execute('test-id', {} as any, undefined, undefined, undefined as any);
      expect(result.details).toMatchObject({ error: 'invalid_parameters' });
      expect((result.content[0] as any).text).toContain('Invalid parameters');
    });

    it('should reject more than 20 terms (request fan-out cap)', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');
      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const terms = Array.from({ length: 21 }, (_, i) => `package-${i}`);
      const result = await tool.execute('test-id', { terms } as any, undefined, undefined, undefined as any);
      expect(result.details).toMatchObject({ error: 'invalid_parameters' });
      expect(searchSecurityDatabases).not.toHaveBeenCalled();
    });

    it('should accept exactly 20 terms', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalVulnerabilities: 0,
        totalDatabases: 0,
        results: {},
        duration: 0,
      });
      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const terms = Array.from({ length: 20 }, (_, i) => `package-${i}`);
      const result = await tool.execute('test-id', { terms } as any, undefined, undefined, undefined as any);
      expect(result.details).not.toMatchObject({ error: 'invalid_parameters' });
      expect(searchSecurityDatabases).toHaveBeenCalledTimes(1);
    });
  });

  describe('execute - success path', () => {
    it('should format successful results with vulnerability header and counts', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalVulnerabilities: 3,
        totalDatabases: 2,
        results: {
          nvd: { vulnerabilities: [], count: 2, error: undefined },
          osv: { vulnerabilities: [], count: 1, error: undefined },
        },
        duration: 150,
      });

      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const result = await tool.execute('test-id', { terms: ['CVE-2024-1234'] }, undefined, undefined, undefined as any);

      expect((result.content[0] as any).text).toContain('Security Vulnerability Search Results');
      expect((result.content[0] as any).text).toContain('Total Vulnerabilities Found:**');
      expect((result.content[0] as any).text).toContain('CVE-2024-1234');
      // Grounding contract: groundingHits mirrors the real vulnerability count (consumed by the
      // researcher-executor grounding gate).
      expect((result.details as any).groundingHits).toBe(3);
    });

    it('should return formatted error when searchSecurityDatabases throws', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');
      vi.mocked(searchSecurityDatabases).mockRejectedValue(new Error('API unavailable'));

      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const result = await tool.execute('test-id', { terms: ['test'] }, undefined, undefined, undefined as any);

      expect((result.content[0] as any).text).toContain('Security Vulnerability Search Failed');
      expect((result.content[0] as any).text).toContain('API unavailable');
      expect(result.details).toMatchObject({ error: 'API unavailable' });
    });

    it('should default to all 4 databases when none specified', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalVulnerabilities: 0,
        totalDatabases: 4,
        results: {},
        duration: 0,
      });

      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      await tool.execute('test-id', { terms: ['test'] }, undefined, undefined, undefined as any);

      expect(searchSecurityDatabases).toHaveBeenCalledWith(
        expect.objectContaining({ databases: ['nvd', 'cisa_kev', 'github', 'osv'] }),
        // The tool now forwards its AbortSignal as a second argument (undefined here).
        undefined,
      );
    });
  });

  describe('execute - partial failure rendering', () => {
    it('renders partial results alongside the [Error] annotation instead of dropping them', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');
      // The clients deliberately return partial results PLUS an error annotation
      // (e.g. "NVD lookup failed for 1/2 term(s)") — the render must not hide the
      // data while the header's totals still count it.
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalVulnerabilities: 4,
        totalDatabases: 4,
        results: {
          nvd: {
            count: 1,
            vulnerabilities: [{
              id: 'CVE-2024-0001', source: 'nvd', severity: 'HIGH',
              description: 'NVD partial survivor', cwes: [], references: [],
              affectedProducts: [], fixes: [],
            }],
            error: 'NVD lookup failed for 1/2 term(s): badterm (HTTP 400)',
          },
          cisa_kev: {
            count: 1,
            vulnerabilities: [{
              id: 'CVE-2024-0002', source: 'cisa_kev', severity: 'HIGH',
              description: 'KEV partial survivor', cwes: [], references: [],
              affectedProducts: [], fixes: [],
            }],
            error: 'CISA KEV lookup degraded',
          },
          github: {
            count: 1,
            advisories: [{
              id: 'GHSA-xxxx-yyyy-zzzz', source: 'github', severity: 'HIGH',
              summary: 'GitHub partial survivor', description: 'ghsa detail',
              published: '2024-01-01', modified: '2024-01-02',
              references: [], affectedPackages: [],
            }],
            error: 'GitHub lookup failed for 1/2 term(s)',
          },
          osv: {
            count: 1,
            vulnerabilities: [{
              id: 'OSV-2024-1', source: 'osv', severity: 'HIGH',
              description: 'OSV partial survivor', cwes: [], references: [],
              affectedProducts: [], fixes: [],
            }],
            error: 'OSV: ecosystem is required for package queries',
          },
        },
        duration: 10,
      } as any);

      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const result = await tool.execute('test-id', { terms: ['good', 'badterm'] }, undefined, undefined, undefined as any);
      const text = (result.content[0] as any).text as string;

      expect(text).toContain('[Error] NVD lookup failed for 1/2 term(s)');
      expect(text).toContain('CVE-2024-0001');
      expect(text).toContain('NVD partial survivor');
      expect(text).toContain('[Error] CISA KEV lookup degraded');
      expect(text).toContain('CVE-2024-0002');
      expect(text).toContain('[Error] GitHub lookup failed for 1/2 term(s)');
      expect(text).toContain('GHSA-xxxx-yyyy-zzzz');
      expect(text).toContain('[Error] OSV: ecosystem is required');
      expect(text).toContain('OSV-2024-1');
    });

    it('keeps a total failure (error with zero rows) error-only — no "Found: 0" after an [Error]', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalVulnerabilities: 0,
        totalDatabases: 1,
        results: {
          nvd: { count: 0, vulnerabilities: [], error: 'NVD API rate limit exceeded' },
        },
        duration: 10,
      } as any);

      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const result = await tool.execute('test-id', { terms: ['test'] }, undefined, undefined, undefined as any);
      const text = (result.content[0] as any).text as string;

      expect(text).toContain('[Error] NVD API rate limit exceeded');
      // An error followed by an authoritative-looking zero would read as "queried
      // and found nothing" — a total failure stays error-only.
      expect(text).not.toContain('Found: 0');
    });
  });

  describe('execute - includeExploited caveat', () => {
    const partialResults = () => ({
      totalVulnerabilities: 2,
      totalDatabases: 2,
      results: {
        github: {
          count: 1,
          advisories: [{
            id: 'GHSA-aaaa-bbbb-cccc', source: 'github', severity: 'HIGH',
            summary: 'sum', description: 'desc', published: '2024-01-01',
            modified: '2024-01-02', references: [], affectedPackages: [],
          }],
        },
        osv: {
          count: 1,
          vulnerabilities: [{
            id: 'OSV-2024-2', source: 'osv', severity: 'HIGH',
            description: 'osv desc', cwes: [], references: [],
            affectedProducts: [], fixes: [],
          }],
        },
      },
      duration: 10,
    } as any);

    it('labels GitHub and OSV sections as not filtered by known-exploitation when includeExploited is set', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');
      vi.mocked(searchSecurityDatabases).mockResolvedValue(partialResults());

      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const result = await tool.execute('test-id', { terms: ['pkg'], includeExploited: true }, undefined, undefined, undefined as any);
      const text = (result.content[0] as any).text as string;

      // includeExploited reaches only NVD (hasKev); CISA KEV is inherently
      // exploited-only. GitHub/OSV carry no exploitation signal, so their results
      // must be labeled as unfiltered rather than implying the filter applied.
      const githubSection = text.split('## GitHub Security Advisories')[1]!.split('---')[0]!;
      const osvSection = text.split('## Open Source Vulnerabilities (OSV)')[1]!.split('---')[0]!;
      expect(githubSection).toContain('not filtered by known-exploitation');
      expect(osvSection).toContain('not filtered by known-exploitation');
    });

    it('omits the caveat when includeExploited was not requested', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');
      vi.mocked(searchSecurityDatabases).mockResolvedValue(partialResults());

      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const result = await tool.execute('test-id', { terms: ['pkg'] }, undefined, undefined, undefined as any);
      const text = (result.content[0] as any).text as string;

      expect(text).not.toContain('not filtered by known-exploitation');
    });
  });

  describe('execute - severity normalization', () => {
    it('normalizes "moderate" to MEDIUM before dispatch so all databases see the same filter', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalVulnerabilities: 0,
        totalDatabases: 4,
        results: {},
        duration: 0,
      });

      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      await tool.execute('test-id', { terms: ['test'], severity: ' moderate ' }, undefined, undefined, undefined as any);

      expect(searchSecurityDatabases).toHaveBeenCalledWith(
        expect.objectContaining({ severity: 'MEDIUM' }),
        undefined,
      );
    });

    it('uppercases severity ("high" → HIGH)', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalVulnerabilities: 0,
        totalDatabases: 4,
        results: {},
        duration: 0,
      });

      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      await tool.execute('test-id', { terms: ['test'], severity: 'high' }, undefined, undefined, undefined as any);

      expect(searchSecurityDatabases).toHaveBeenCalledWith(
        expect.objectContaining({ severity: 'HIGH' }),
        undefined,
      );
    });

    it('rejects an unknown severity loudly WITHOUT querying any database', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');

      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const result = await tool.execute('test-id', { terms: ['test'], severity: 'med' }, undefined, undefined, undefined as any);

      // Previously the raw value went to GitHub/OSV (strict filters → zero rows)
      // while NVD ran unfiltered — three databases silently disagreeing.
      expect(searchSecurityDatabases).not.toHaveBeenCalled();
      const text = (result.content[0] as any).text as string;
      expect(text).toContain('[Error] Unknown severity "med"');
      expect(text).toContain('LOW, MEDIUM, HIGH, CRITICAL');
      expect(text).toContain('MODERATE accepted as MEDIUM');
      expect(result.details).toMatchObject({ error: 'invalid_severity' });
    });
  });

  describe('execute - database name normalization', () => {
    it('lowercases database names before dispatch ("NVD" → "nvd")', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalVulnerabilities: 0,
        totalDatabases: 1,
        results: {},
        duration: 0,
      });

      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      await tool.execute('test-id', { terms: ['test'], databases: ['NVD', ' Github '] }, undefined, undefined, undefined as any);

      expect(searchSecurityDatabases).toHaveBeenCalledWith(
        expect.objectContaining({ databases: ['nvd', 'github'] }),
        undefined,
      );
    });

    it('fails loudly (no search, no "0 vulnerabilities") when EVERY requested database is unknown', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');

      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const result = await tool.execute('test-id', { terms: ['test'], databases: ['all', 'kev'] }, undefined, undefined, undefined as any);

      expect(searchSecurityDatabases).not.toHaveBeenCalled();
      const text = (result.content[0] as any).text as string;
      expect(text).toContain('Security Vulnerability Search Failed');
      expect(text).toContain('nvd, cisa_kev, github, osv');
      expect(text).not.toContain('0 vulnerabilities');
      expect(result.details).toMatchObject({ error: 'unknown_databases' });
    });

    it('passes unknown names through alongside known ones and renders the searcher-reported errors', async () => {
      const { searchSecurityDatabases } = await import('../../../src/security/index.ts');
      // The real searcher reports each unknown name in `errors`; the tool's note
      // section must make the dropped source visible instead of implying "found nothing".
      vi.mocked(searchSecurityDatabases).mockResolvedValue({
        totalVulnerabilities: 0,
        totalDatabases: 1,
        results: { nvd: { vulnerabilities: [], count: 0 } },
        duration: 0,
        errors: ['Unknown database "kev" — valid databases: nvd, cisa_kev, github, osv'],
      });

      const tool = createSecuritySearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const result = await tool.execute('test-id', { terms: ['test'], databases: ['nvd', 'kev'] }, undefined, undefined, undefined as any);

      expect(searchSecurityDatabases).toHaveBeenCalledWith(
        expect.objectContaining({ databases: ['nvd', 'kev'] }),
        undefined,
      );
      const text = (result.content[0] as any).text as string;
      expect(text).toContain('some databases could not be queried');
      expect(text).toContain('Unknown database "kev"');
    });
  });
});
