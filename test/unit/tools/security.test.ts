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
