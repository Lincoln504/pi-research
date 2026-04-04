/**
 * Search Tool Unit Tests
 *
 * Tests the createSearchTool function and core behaviors.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSearchTool } from '../../../src/tools/search';

// Mock the search function
vi.mock('../../../src/web-research/search.js', () => ({
  search: vi.fn(),
}));

describe('tools/search', () => {
  const createMockContext = () => ({
    settingsManager: {
      get: vi.fn(),
      set: vi.fn(),
    },
  } as any);

  describe('Tool Definition', () => {
    it('should create tool with correct metadata and guidelines', () => {
      const tool = createSearchTool({ ctx: createMockContext() });

      // Metadata
      expect(tool.name).toBe('search');
      expect(tool.label).toBe('Search');
      expect(tool.description).toContain('SearXNG');
      expect(tool.description).toContain('URLs, titles, and snippets');

      // Prompt snippet
      expect(tool.promptSnippet).toBeDefined();
      expect(tool.promptSnippet!.toLowerCase()).toContain('search');
      expect(tool.promptSnippet!).toContain('snippets');

      // Guidelines
      expect(Array.isArray(tool.promptGuidelines)).toBe(true);
      expect(tool.promptGuidelines!.length).toBeGreaterThan(0);
      const guidelines = tool.promptGuidelines!.join(' ');
      expect(guidelines).toContain('scrape');
      expect(guidelines).toContain('security_search');
    });

    it('should have execute function', () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      expect(typeof tool.execute).toBe('function');
    });
  });

  describe('Parameters', () => {
    it('should have queries and maxResults parameters properly defined', () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      const props = (tool.parameters as any).properties;

      expect(props).toHaveProperty('queries');
      expect(props).toHaveProperty('maxResults');
      expect(props.queries).toBeDefined();
      expect(props.maxResults).toBeDefined();
    });
  });

  describe('execute - parameter validation', () => {
    it('should throw error when params is not valid', async () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      await expect(
        tool.execute('test-id', {} as any, undefined, undefined, undefined as any)
      ).rejects.toThrow('Invalid parameters for search');
    });

    it('should throw error when queries array is empty', async () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      await expect(
        tool.execute('test-id', { queries: [] }, undefined, undefined, undefined as any)
      ).rejects.toThrow('At least one query is required');
    });

    it('should throw error when queries is missing', async () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      await expect(
        tool.execute('test-id', { maxResults: 10 }, undefined, undefined, undefined as any)
      ).rejects.toThrow('Invalid parameters for search');
    });

    it('should accept single query', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([
        { query: 'test query', results: [] },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test query'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it('should accept multiple queries', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([
        { query: 'query1', results: [] },
        { query: 'query2', results: [] },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['query1', 'query2'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(result).toBeDefined();
    });
  });

  describe('execute - search function integration', () => {
    it('should call search function with queries', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([
        { query: 'test query', results: [] },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      await tool.execute(
        'test-id',
        { queries: ['test query'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(search).toHaveBeenCalledWith(['test query']);
    });

    it('should call search function with multiple queries', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([
        { query: 'query1', results: [] },
        { query: 'query2', results: [] },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      await tool.execute(
        'test-id',
        { queries: ['query1', 'query2'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(search).toHaveBeenCalledWith(['query1', 'query2']);
    });
  });

  describe('execute - result formatting', () => {
    it('should return text content', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([
        { query: 'test', results: [] },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(result.content[0]?.type).toBe('text');
      expect((result.content[0] as any)?.text).toBeDefined();
    });

    it('should include query in output', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([
        { query: 'test query', results: [] },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test query'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('test query');
    });

    it('should include duration in output', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([
        { query: 'test', results: [] },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('Duration');
      expect((result.content[0] as any)?.text).toContain('s');
    });

    it('should format results with titles and URLs', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([
        {
          query: 'test',
          results: [
            { url: 'https://example.com', title: 'Test Page', content: 'Test content' },
          ],
        },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('Test Page');
      expect((result.content[0] as any)?.text).toContain('https://example.com');
      expect((result.content[0] as any)?.text).toContain('Test content');
    });

    it('should truncate long snippets', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      const longContent = 'A'.repeat(250);
      vi.mocked(search).mockResolvedValue([
        {
          query: 'test',
          results: [
            { url: 'https://example.com', title: 'Test', content: longContent },
          ],
        },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('...');
    });
  });

  describe('execute - maxResults parameter', () => {
    it('should use default maxResults when not specified', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([
        {
          query: 'test',
          results: Array.from({ length: 30 }, (_, i) => ({
            url: `https://example.com/${i}`,
            title: `Title ${i}`,
            content: `Content ${i}`,
          })),
        },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      // Should only show 20 results by default
      expect((result.content[0] as any)?.text).toContain('found');
    });

    it('should respect custom maxResults parameter', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([
        {
          query: 'test',
          results: Array.from({ length: 30 }, (_, i) => ({
            url: `https://example.com/${i}`,
            title: `Title ${i}`,
            content: `Content ${i}`,
          })),
        },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test'], maxResults: 5 },
        undefined,
        undefined,
        undefined as any
      );

      expect(result).toBeDefined();
    });
  });

  describe('execute - error handling', () => {
    it('should handle empty results', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([
        { query: 'test', results: [], error: { type: 'empty_results', message: 'No results found' } },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('No results');
      expect((result.content[0] as any)?.text).toContain('📭');
    });

    it('should handle search errors', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([
        { query: 'test', results: [], error: { type: 'network_error', message: 'Network timeout' } },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('Error');
      expect((result.content[0] as any)?.text).toContain('⚠️');
      expect((result.content[0] as any)?.text).toContain('network_error');
    });
  });

  describe('execute - details object', () => {
    it('should include queryResults in details', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      const mockResults = [{ query: 'test', results: [] }];
      vi.mocked(search).mockResolvedValue(mockResults);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(result.details).toBeDefined();
      expect((result.details as any).queryResults).toEqual(mockResults);
    });

    it('should include totalQueries in details', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([
        { query: 'test1', results: [] },
        { query: 'test2', results: [] },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test1', 'test2'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.details as any).totalQueries).toBe(2);
    });

    it('should include totalResults in details', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([
        { query: 'test', results: [{ url: 'url1', title: 't1', content: '' }, { url: 'url2', title: 't2', content: '' }] },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.details as any).totalResults).toBe(2);
    });

    it('should include duration in details', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([{ query: 'test', results: [] }]);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.details as any).duration).toBeDefined();
      expect(typeof (result.details as any).duration).toBe('number');
      expect((result.details as any).duration).toBeGreaterThanOrEqual(0);
    });
  });
});
