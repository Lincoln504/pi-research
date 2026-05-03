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
      expect(result.content[0].text).toContain('GATHERING LIMIT REACHED');
    });
  });
});
