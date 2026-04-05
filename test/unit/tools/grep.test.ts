/**
 * Grep Tool Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGrepTool } from '../../../src/tools/grep';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker';

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
      try {
        await tool.execute('test-id', { pattern: 'test' }, undefined, undefined, {} as any);
      } catch (e) {
        // ignore execution errors, we only care about tracker
      }

      expect(spy).toHaveBeenCalledWith('grep');
    });

    it('should throw if limit exceeded', async () => {
      const tracker = new ToolUsageTracker({ gathering: 1 });
      tracker.recordCall('grep'); // Limit reached

      const tool = createGrepTool({ tracker });
      
      await expect(
        tool.execute('test-id', { pattern: 'test' }, undefined, undefined, {} as any)
      ).rejects.toThrow(/limit for gathering exceeded/);
    });
  });
});
