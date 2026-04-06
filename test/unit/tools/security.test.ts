/**
 * Security Tool Unit Tests
 *
 * Tests the createSecuritySearchTool function and core behaviors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSecuritySearchTool } from '../../../src/tools/security';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker';

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
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext(), tracker: createMockTracker() });
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
      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext(), tracker });
      
      await tool.execute('test-id', { terms: ['test'] }, undefined, undefined, undefined as any);

      expect(spy).toHaveBeenCalledWith('security_search');
    });

    it('should return blocked response if limit exceeded', async () => {
      const tracker = new ToolUsageTracker({ gathering: 1 });
      tracker.recordCall('security_search'); // Limit reached

      const tool = createSecuritySearchTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext(), tracker });

      const result = await tool.execute('test-id', { terms: ['test'] }, undefined, undefined, undefined as any);

      expect((result.details as any).blocked).toBe(true);
      expect((result.content[0] as any).text).toContain('GATHERING LIMIT REACHED');
    });
  });
});
