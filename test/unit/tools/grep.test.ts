/**
 * Grep Tool Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGrepTool } from '../../../src/tools/grep.ts';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker.ts';

describe('tools/grep', () => {
  const createMockTracker = () => new ToolUsageTracker({ gathering: 6 });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('should create tool with correct metadata', () => {
      const tool = createGrepTool({ tracker: createMockTracker() });
      expect(tool.name).toBe('grep');
      expect(tool.label).toBe('Code Search');
    });
  });

  describe('execute - tracker', () => {
    it('should record call in tracker', async () => {
      const tracker = createMockTracker();
      const spy = vi.spyOn(tracker, 'recordCall');
      const tool = createGrepTool({ tracker });
      
      // Mock execCommand or just let it fail/pass
      // For tracker test, we just care that recordCall was called
      await tool.execute('test-id', { pattern: 'test' }, {} as any);

      expect(spy).toHaveBeenCalledWith('grep');
    });

    it('should return limit reached message if budget exceeded', async () => {
      const tracker = new ToolUsageTracker({ gathering: 1 });
      tracker.recordCall('grep'); // Limit reached

      const tool = createGrepTool({ tracker });

      const result = await tool.execute('test-id', { pattern: 'test' }, {} as any);
      expect(result.details).toMatchObject({ blocked: true, reason: 'limit_reached' });
      expect(result.content[0].text).toContain('GATHERING LIMIT REACHED');
    });
  });
});
