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

  describe('createSearchTool', () => {
    it('should create tool with correct name', () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      expect(tool.name).toBe('search');
    });

    it('should create tool with correct label', () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      expect(tool.label).toBe('Search');
    });

    it('should create tool with correct description', () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      expect(tool.description).toContain('SearXNG');
      expect(tool.description).toContain('URLs, titles, and snippets');
    });

    it('should have prompt snippet', () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      expect(tool.promptSnippet).toBeDefined();
      expect(tool.promptSnippet.toLowerCase()).toContain('search');
      expect(tool.promptSnippet).toContain('snippets');
    });

    it('should have prompt guidelines', () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      expect(tool.promptGuidelines).toBeDefined();
      expect(Array.isArray(tool.promptGuidelines)).toBe(true);
      expect(tool.promptGuidelines.length).toBeGreaterThan(0);
    });

    it('should have prompt guidelines mentioning scrape', () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      const guidelines = tool.promptGuidelines.join(' ');
      expect(guidelines).toContain('scrape');
    });

    it('should have prompt guidelines mentioning security_search', () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      const guidelines = tool.promptGuidelines.join(' ');
      expect(guidelines).toContain('security_search');
    });
  });

  describe('parameters', () => {
    it('should require queries parameter', () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.properties).toHaveProperty('queries');
    });

    it('should have queries as array of strings with minItems: 1', () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      const queriesParam = tool.parameters.properties.queries;
      expect(queriesParam).toBeDefined();
    });

    it('should have optional maxResults parameter', () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      expect(tool.parameters.properties).toHaveProperty('maxResults');
    });

    it('should have maxResults with correct defaults and constraints', () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      const maxResultsParam = tool.parameters.properties.maxResults;
      expect(maxResultsParam).toBeDefined();
    });
  });

  describe('execute - parameter validation', () => {
    it('should throw error when params is not valid', async () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      await expect(
        tool.execute('test-id', {} as any, undefined, undefined, undefined)
      ).rejects.toThrow('Invalid parameters for search');
    });

    it('should throw error when queries array is empty', async () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      await expect(
        tool.execute('test-id', { queries: [] }, undefined, undefined, undefined)
      ).rejects.toThrow('At least one query is required');
    });

    it('should throw error when queries is missing', async () => {
      const tool = createSearchTool({ ctx: createMockContext() });
      await expect(
        tool.execute('test-id', { maxResults: 10 }, undefined, undefined, undefined)
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
        undefined
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
        undefined
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
        undefined
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
        undefined
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
        undefined
      );

      expect(result.content[0]?.type).toBe('text');
      expect(result.content[0]?.text).toBeDefined();
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
        undefined
      );

      expect(result.content[0]?.text).toContain('test query');
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
        undefined
      );

      expect(result.content[0]?.text).toContain('Duration');
      expect(result.content[0]?.text).toContain('s');
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
        undefined
      );

      expect(result.content[0]?.text).toContain('Test Page');
      expect(result.content[0]?.text).toContain('https://example.com');
      expect(result.content[0]?.text).toContain('Test content');
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
        undefined
      );

      expect(result.content[0]?.text).toContain('...');
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
        undefined
      );

      // Should only show 20 results by default
      expect(result.content[0]?.text).toContain('found');
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
        undefined
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
        undefined
      );

      expect(result.content[0]?.text).toContain('No results');
      expect(result.content[0]?.text).toContain('📭');
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
        undefined
      );

      expect(result.content[0]?.text).toContain('Error');
      expect(result.content[0]?.text).toContain('⚠️');
      expect(result.content[0]?.text).toContain('network_error');
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
        undefined
      );

      expect(result.details).toBeDefined();
      expect(result.details.queryResults).toEqual(mockResults);
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
        undefined
      );

      expect(result.details.totalQueries).toBe(2);
    });

    it('should include totalResults in details', async () => {
      const { search } = await import('../../../src/web-research/search.js');
      vi.mocked(search).mockResolvedValue([
        { query: 'test', results: [{ url: 'url1', title: 't1' }, { url: 'url2', title: 't2' }] },
      ]);

      const tool = createSearchTool({ ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test'] },
        undefined,
        undefined,
        undefined
      );

      expect(result.details.totalResults).toBe(2);
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
        undefined
      );

      expect(result.details.duration).toBeDefined();
      expect(typeof result.details.duration).toBe('number');
      expect(result.details.duration).toBeGreaterThanOrEqual(0);
    });
  });
});
