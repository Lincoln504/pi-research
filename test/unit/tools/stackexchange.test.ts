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

  describe('execute - validation', () => {
    it('should return error for invalid parameters', async () => {
      const tool = createStackexchangeTool({ ctx: createMockContext(), tracker: createMockTracker() });
      // Missing required `command` field
      const result = await tool.execute('test-id', {} as any, undefined, undefined, undefined as any);
      expect(result.details).toMatchObject({ error: 'invalid_parameters' });
      expect(result.content[0].text).toContain('Invalid parameters');
    });
  });

  describe('execute - success path', () => {
    it('should proxy stackexchangeCommand result through', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.ts');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text', text: '## Questions\nResult text here' }],
        details: { count: 5 },
      });

      const tool = createStackexchangeTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const result = await tool.execute('test-id', { command: 'search', query: 'async await' }, undefined, undefined, undefined as any);

      expect(result.content[0].text).toContain('Result text here');
    });

    it('should return formatted error when stackexchangeCommand throws', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.ts');
      vi.mocked(stackexchangeCommand).mockRejectedValue(new Error('Rate limit exceeded'));

      const tool = createStackexchangeTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const result = await tool.execute('test-id', { command: 'search', query: 'test' }, undefined, undefined, undefined as any);

      expect(result.content[0].text).toContain('Stack Exchange Search Failed');
      expect(result.content[0].text).toContain('Rate limit exceeded');
      expect(result.details).toMatchObject({ command: 'search', error: 'Rate limit exceeded' });
    });

    it('should pass signal and context through to stackexchangeCommand', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.ts');
      vi.mocked(stackexchangeCommand).mockResolvedValue({ content: [], details: {} });

      const ctx = createMockContext();
      const tool = createStackexchangeTool({ ctx, tracker: createMockTracker() });
      const signal = new AbortController().signal;
      await tool.execute('test-id', { command: 'search', query: 'test' }, signal, undefined, ctx);

      expect(stackexchangeCommand).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'search', signal })
      );
    });
  });
});
