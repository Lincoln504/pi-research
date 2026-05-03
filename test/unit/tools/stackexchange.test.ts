/**
 * Stack Exchange Tool Unit Tests
 *
 * Tests createStackexchangeTool function and core behaviors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStackexchangeTool } from '../../../src/tools/stackexchange.ts';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker.ts';

// Mock stackexchange command
vi.mock('../../../src/stackexchange/index.ts', () => ({
  stackexchangeCommand: vi.fn(),
}));

describe('tools/stackexchange', () => {
  const createMockContext = () => ({
    settingsManager: {
      get: vi.fn(),
      set: vi.fn(),
    },
    ui: {
      notify: vi.fn(),
    },
  } as any);

  const createMockTracker = () => new ToolUsageTracker({ gathering: 6 });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createStackexchangeTool', () => {
    it('should create tool with correct name', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext(), tracker: createMockTracker() });
      expect(tool.name).toBe('stackexchange');
    });
  });

  describe('execute - tracker', () => {
    it('should record call in tracker', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.ts');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [],
        details: {},
      });

      const tracker = createMockTracker();
      const spy = vi.spyOn(tracker, 'recordCall');
      const tool = createStackexchangeTool({ ctx: createMockContext(), tracker });
      
      await tool.execute('test-id', { command: 'search', query: 'test' }, undefined, undefined, undefined as any);

      expect(spy).toHaveBeenCalledWith('stackexchange');
    });

    it('should return limit reached message if budget exceeded', async () => {
      const tracker = new ToolUsageTracker({ gathering: 1 });
      tracker.recordCall('stackexchange'); // Limit reached

      const tool = createStackexchangeTool({ ctx: createMockContext(), tracker });

      const result = await tool.execute('test-id', { command: 'search', query: 'test' }, undefined, undefined, undefined as any);
      expect(result.details).toMatchObject({ blocked: true, reason: 'limit_reached' });
      expect(result.content[0].text).toContain('GATHERING LIMIT REACHED');
    });
  });
});
