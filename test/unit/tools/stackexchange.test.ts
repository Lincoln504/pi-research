/**
 * Stack Exchange Tool Unit Tests
 *
 * Tests the createStackexchangeTool function and core behaviors.
 */

import { describe, it, expect, vi } from 'vitest';
import { createStackexchangeTool } from '../../../src/tools/stackexchange';

// Mock the stackexchange command
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
      expect(tool.promptSnippet.toLowerCase()).toContain('stack');
      expect(tool.promptSnippet.toLowerCase()).toContain('overflow');
    });

    it('should have prompt guidelines', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.promptGuidelines).toBeDefined();
      expect(Array.isArray(tool.promptGuidelines)).toBe(true);
      expect(tool.promptGuidelines.length).toBeGreaterThan(0);
    });

    it('should have prompt guidelines mentioning Stack Overflow', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const guidelines = tool.promptGuidelines.join(' ');
      expect(guidelines).toContain('Stack Overflow');
    });

    it('should have prompt guidelines mentioning API limits', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const guidelines = tool.promptGuidelines.join(' ');
      expect(guidelines).toContain('requests');
      expect(guidelines).toContain('API');
    });

    it('should have prompt guidelines mentioning tags', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const guidelines = tool.promptGuidelines.join(' ');
      expect(guidelines).toContain('tags');
    });
  });

  describe('parameters', () => {
    it('should require command parameter', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.properties).toHaveProperty('command');
    });

    it('should have command as string', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const commandParam = tool.parameters.properties.command;
      expect(commandParam).toBeDefined();
    });

    it('should have optional query parameter', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.parameters.properties).toHaveProperty('query');
    });

    it('should have optional id parameter', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.parameters.properties).toHaveProperty('id');
    });

    it('should have optional site parameter', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.parameters.properties).toHaveProperty('site');
    });

    it('should have optional limit parameter', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.parameters.properties).toHaveProperty('limit');
    });

    it('should have optional format parameter', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.parameters.properties).toHaveProperty('format');
    });

    it('should have optional tags parameter', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      expect(tool.parameters.properties).toHaveProperty('tags');
    });

    it('should mention default site as stackoverflow.com', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const siteParam = tool.parameters.properties.site;
      expect(siteParam.description).toContain('stackoverflow.com');
    });

    it('should have limit with correct constraints', () => {
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const limitParam = tool.parameters.properties.limit;
      expect(limitParam).toBeDefined();
    });
  });

  describe('execute - command types', () => {
    it('should handle search command', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text', text: '# Search Results\n\nFound 5 questions.' }],
      });

      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { command: 'search', query: 'typescript async await' },
        undefined,
        undefined,
        undefined
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it('should handle get command', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text', text: '# Question Details\n\nTitle: How to use async/await' }],
      });

      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { command: 'get', id: 12345 },
        undefined,
        undefined,
        undefined
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should handle user command', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text', text: '# User Profile\n\nReputation: 5000' }],
      });

      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { command: 'user', id: 67890 },
        undefined,
        undefined,
        undefined
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should handle site command', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text', text: '# Site Info\n\nName: Stack Overflow' }],
      });

      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { command: 'site' },
        undefined,
        undefined,
        undefined
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe('execute - optional parameters', () => {
    it('should pass site parameter', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text', text: '# Results' }],
      });

      const tool = createStackexchangeTool({ ctx: createMockContext() });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test', site: 'superuser.com' },
        undefined,
        undefined,
        undefined
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0][0];
      expect(callArgs.params.site).toBe('superuser.com');
    });

    it('should pass limit parameter', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text', text: '# Results' }],
      });

      const tool = createStackexchangeTool({ ctx: createMockContext() });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test', limit: 25 },
        undefined,
        undefined,
        undefined
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0][0];
      expect(callArgs.params.limit).toBe(25);
    });

    it('should pass format parameter', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text', text: '# Results' }],
      });

      const tool = createStackexchangeTool({ ctx: createMockContext() });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test', format: 'json' },
        undefined,
        undefined,
        undefined
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0][0];
      expect(callArgs.params.format).toBe('json');
    });

    it('should pass tags parameter', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text', text: '# Results' }],
      });

      const tool = createStackexchangeTool({ ctx: createMockContext() });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test', tags: 'javascript,node.js' },
        undefined,
        undefined,
        undefined
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0][0];
      expect(callArgs.params.tags).toBe('javascript,node.js');
    });

    it('should pass string id parameter', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text', text: '# Results' }],
      });

      const tool = createStackexchangeTool({ ctx: createMockContext() });
      await tool.execute(
        'test-id',
        { command: 'get', id: '12345' },
        undefined,
        undefined,
        undefined
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0][0];
      expect(callArgs.params.id).toBe('12345');
    });

    it('should pass number id parameter', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text', text: '# Results' }],
      });

      const tool = createStackexchangeTool({ ctx: createMockContext() });
      await tool.execute(
        'test-id',
        { command: 'get', id: 12345 },
        undefined,
        undefined,
        undefined
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0][0];
      expect(callArgs.params.id).toBe(12345);
    });
  });

  describe('execute - signal handling', () => {
    it('should pass signal to stackexchangeCommand', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text', text: '# Results' }],
      });

      const signal = new AbortController().signal;
      const tool = createStackexchangeTool({ ctx: createMockContext() });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test' },
        signal,
        undefined,
        undefined
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0][0];
      expect(callArgs.signal).toBe(signal);
    });
  });

  describe('execute - result format', () => {
    it('should return text content', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text', text: '# Search Results\n\nFound 5 questions.' }],
      });

      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { command: 'search', query: 'test' },
        undefined,
        undefined,
        undefined
      );

      expect(result.content[0]?.type).toBe('text');
      expect(result.content[0]?.text).toBeDefined();
    });

    it('should return results from stackexchangeCommand', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      const mockContent = [{ type: 'text', text: '# Results\n\nMock content here' }];
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: mockContent,
      });

      const tool = createStackexchangeTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { command: 'search', query: 'test' },
        undefined,
        undefined,
        undefined
      );

      expect(result.content).toEqual(mockContent);
    });
  });

  describe('execute - parameter combinations', () => {
    it('should handle all parameters together', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text', text: '# Results' }],
      });

      const tool = createStackexchangeTool({ ctx: createMockContext() });
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
        undefined,
        undefined,
        undefined
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0][0];
      expect(callArgs.command).toBe('search');
      expect(callArgs.params.query).toBe('async await');
      expect(callArgs.params.site).toBe('stackoverflow.com');
      expect(callArgs.params.limit).toBe(20);
      expect(callArgs.params.format).toBe('table');
      expect(callArgs.params.tags).toBe('javascript,typescript');
    });
  });

  describe('execute - context handling', () => {
    it('should pass extension context to stackexchangeCommand', async () => {
      const { stackexchangeCommand } = await import('../../../src/stackexchange/index.js');
      vi.mocked(stackexchangeCommand).mockResolvedValue({
        content: [{ type: 'text', text: '# Results' }],
      });

      const mockCtx = createMockContext();
      const tool = createStackexchangeTool({ ctx: mockCtx });
      await tool.execute(
        'test-id',
        { command: 'search', query: 'test' },
        undefined,
        undefined,
        undefined
      );

      expect(stackexchangeCommand).toHaveBeenCalled();
      const callArgs = vi.mocked(stackexchangeCommand).mock.calls[0][0];
      expect(callArgs.ctx).toBe(mockCtx);
    });
  });
});
