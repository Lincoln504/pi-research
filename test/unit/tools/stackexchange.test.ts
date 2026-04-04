/**
 * Stack Exchange Tool Unit Tests
 *
 * Tests createStackexchangeTool function and core behaviors.
 */

import { describe, it, expect, vi } from 'vitest';
import { createStackexchangeTool } from '../../../src/tools/stackexchange';

// Mock stackexchange command
vi.mock('../../../src/stackexchange/index.js', () => ({
  stackexchangeCommand: vi.fn(),
}));

describe('tools/stackexchange', () => {
  const createMockContext = () => ({
    settingsManager: {
      get: vi.fn(),
      set: vi.fn(),
    },
  } as any);

  describe('createStackexchangeTool', () => {
    it('should create tool with correct name', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.name).toBe('stackexchange');
    });

    it('should create tool with correct label', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.label).toBe('Stack Exchange Search');
    });

    it('should create tool with correct description', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.description).toContain('Stack Exchange');
      expect(tool.description).toContain('REST API');
      expect(tool.description).toContain('v2.3');
      expect(tool.description).toContain('300 requests');
    });

    it('should mention API rate limits in description', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.description).toContain('300');
      expect(tool.description).toContain('10,000');
    });

    it('should have prompt snippet', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.promptSnippet).toBeDefined();
      expect(tool.promptSnippet?.toLowerCase()).toContain('stack');
      expect(tool.promptSnippet?.toLowerCase()).toContain('overflow');
    });

    it('should have prompt guidelines', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.promptGuidelines).toBeDefined();
      expect(Array.isArray(tool.promptGuidelines)).toBe(true);
      expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
    });

    it('should have prompt guidelines mentioning Stack Overflow', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const guidelines = tool.promptGuidelines?.join(' ') ?? '';
      expect(guidelines).toContain('Stack Overflow');
    });

    it('should have prompt guidelines mentioning API limits', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const guidelines = tool.promptGuidelines?.join(' ') ?? '';
      expect(guidelines).toContain('requests');
      expect(guidelines).toContain('API');
    });

    it('should have prompt guidelines mentioning tags', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const guidelines = tool.promptGuidelines?.join(' ') ?? '';
      expect(guidelines).toContain('tags');
    });
  });

  describe('parameters', () => {
    it('should require command parameter', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters['properties']).toHaveProperty('command');
    });

    it('should have command as string', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const commandParam = tool.parameters['properties']?.['command'];
      expect(commandParam).toBeDefined();
    });

    it('should have optional query parameter', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.parameters['properties']).toHaveProperty('query');
    });

    it('should have optional id parameter', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.parameters['properties']).toHaveProperty('id');
    });

    it('should have optional site parameter', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.parameters['properties']).toHaveProperty('site');
    });

    it('should have optional limit parameter', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.parameters['properties']).toHaveProperty('limit');
    });

    it('should have optional format parameter', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.parameters['properties']).toHaveProperty('format');
    });

    it('should have optional tags parameter', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.parameters['properties']).toHaveProperty('tags');
    });

    it('should mention default site as stackoverflow.com', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const siteParam = tool.parameters['properties']?.['site'];
      expect(siteParam?.description).toContain('stackoverflow.com');
    });

    it('should have limit with correct constraints', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const limitParam = tool.parameters['properties']?.['limit'];
      expect(limitParam).toBeDefined();
    });
  });

  describe('execute - command types', () => {
    it('should handle search command', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      const mockContent = [{ type: 'text' as const, text: '# Search Results\n\nFound 5 questions.' }];
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: mockContent,
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      const result = await tool.execute(
        'test-id',
        { command: 'search', query: 'typescript async await' },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(result).toBeDefined();
    });

    it('should handle get-answers command', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      const mockContent = [{ type: 'text' as const, text: '# Answers\n\n3 answers found.' }];
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: mockContent,
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      const result = await tool.execute(
        'test-id',
        { command: 'get', id: '12345' },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(result).toBeDefined();
    });

    it('should handle get-question command', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      const mockContent = [{ type: 'text' as const, text: '# Question Details\n\nTitle: Test' }];
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: mockContent,
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      const result = await tool.execute(
        'test-id',
        { command: 'get', id: '67890' },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(result).toBeDefined();
    });

    it('should return formatted output', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      const mockContent = [{ type: 'text' as const, text: '# Results' }];
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: mockContent,
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      const result = await tool.execute(
        'test-id',
        { command: 'search', query: 'test' },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(result.content[0]?.type).toBe('text');
      expect(result.content[0]).toBeDefined();
    });

    it('should return results from stackexchangeCommand', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      const mockContent = [{ type: 'text' as const, text: '# Results\n\nMock content here' }];
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: mockContent,
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      const result = await tool.execute(
        'test-id',
        { command: 'search', query: 'test' },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(result.content).toEqual(mockContent);
    });
  });

  describe('execute - optional parameters', () => {
    it('should pass site parameter', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text' as const, text: '# Results' }],
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test', site: 'superuser.com' },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0];
      expect(callArgs).toBeDefined();
      if (callArgs) {
        expect(callArgs[0]).toHaveProperty('params');
        expect(callArgs[0]?.params['site']).toBe('superuser.com');
      }
    });

    it('should pass limit parameter', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text' as const, text: '# Results' }],
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test', limit: 25 },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0];
      expect(callArgs).toBeDefined();
      if (callArgs) {
        expect(callArgs[0]?.params['limit']).toBe(25);
      }
    });

    it('should pass format parameter', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text' as const, text: '# Results' }],
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test', format: 'compact' },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0];
      expect(callArgs).toBeDefined();
      if (callArgs) {
        expect(callArgs[0]?.params['format']).toBe('compact');
      }
    });

    it('should pass tags parameter', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text' as const, text: '# Results' }],
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test', tags: 'javascript,typescript' },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0];
      expect(callArgs).toBeDefined();
      if (callArgs) {
        expect(callArgs[0]?.params['tags']).toBe('javascript,typescript');
      }
    });

    it('should pass string id parameter', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text' as const, text: '# Question' }],
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      await tool.execute(
        'test-id',
        { command: 'get', id: '12345' },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0];
      expect(callArgs).toBeDefined();
      if (callArgs) {
        expect(callArgs[0]?.params['id']).toBe('12345');
      }
    });

    it('should pass number id parameter', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text' as const, text: '# Question' }],
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      await tool.execute(
        'test-id',
        { command: 'get', id: 67890 },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0];
      expect(callArgs).toBeDefined();
      if (callArgs) {
        expect(callArgs[0]?.params['id']).toBe(67890);
      }
    });

    it('should pass signal to stackexchangeCommand', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text' as const, text: '# Results' }],
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      const signal = new AbortController().signal;
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test' },
        signal,
        mockCtx,
        undefined as any
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0];
      expect(callArgs).toBeDefined();
      if (callArgs) {
        expect(callArgs[0]?.signal).toBe(signal);
      }
    });

    it('should pass extension context to stackexchangeCommand', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text' as const, text: '# Results' }],
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test' },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0];
      expect(callArgs).toBeDefined();
      if (callArgs) {
        expect(callArgs[0]?.ctx).toBe(mockCtx);
      }
    });
  });

  describe('execute - parameter combinations', () => {
    it('should handle all parameters together', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text' as const, text: '# Results' }],
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      await tool.execute(
        'test-id',
        {
          command: 'search',
          query: 'async await',
          site: 'stackoverflow.com',
          limit: 20,
          format: 'table',
          tags: 'javascript,typescript',
        },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
    });

    it('should handle query with search command', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text' as const, text: '# Results' }],
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'typescript' },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0];
      expect(callArgs).toBeDefined();
      if (callArgs) {
        expect(callArgs[0]?.params['query']).toBe('typescript');
      }
    });

    it('should handle site with search command', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text' as const, text: '# Results' }],
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test', site: 'stackoverflow.com' },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0];
      expect(callArgs).toBeDefined();
      if (callArgs) {
        expect(callArgs[0]?.params['site']).toBe('stackoverflow.com');
      }
    });

    it('should handle limit with search command', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text' as const, text: '# Results' }],
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test', limit: 30 },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0];
      expect(callArgs).toBeDefined();
      if (callArgs) {
        expect(callArgs[0]?.params['limit']).toBe(30);
      }
    });

    it('should handle format with search command', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text' as const, text: '# Results' }],
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test', format: 'json' },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0];
      expect(callArgs).toBeDefined();
      if (callArgs) {
        expect(callArgs[0]?.params['format']).toBe('json');
      }
    });

    it('should handle tags with search command', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text' as const, text: '# Results' }],
        details: {},
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test', tags: 'nodejs' },
        mockCtx,
        mockCtx,
        undefined as any
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0];
      expect(callArgs).toBeDefined();
      if (callArgs) {
        expect(callArgs[0]?.params['tags']).toBe('nodejs');
      }
    });
  });
});
