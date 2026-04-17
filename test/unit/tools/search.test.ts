/**
 * Search Tool Unit Tests
 *
 * Tests the createSearchTool function and core behaviors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSearchTool } from '../../../src/tools/search';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker';

// Mock the search function
vi.mock('../../../src/web-research/search.ts', () => ({
  search: vi.fn(),
}));

describe('tools/search', () => {
  const createMockContext = () => ({
    settingsManager: {
      get: vi.fn(),
      set: vi.fn(),
    },
  } as any);

  const createMockTracker = () => new ToolUsageTracker({ gathering: 6 });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('should create tool with correct metadata and guidelines', () => {
      const tool = createSearchTool({ ctx: createMockContext(), tracker: createMockTracker() });

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
      const tool = createSearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      expect(typeof tool.execute).toBe('function');
    });
  });

  describe('Parameters', () => {
    it('should have queries and maxResults parameters properly defined', () => {
      const tool = createSearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const props = (tool.parameters as any).properties;

      expect(props).toHaveProperty('queries');
      expect(props).toHaveProperty('maxResults');
      expect(props.queries).toBeDefined();
      expect(props.maxResults).toBeDefined();
    });
  });

  describe('execute - parameter validation', () => {
    it('should throw error when params is not valid', async () => {
      const tool = createSearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      await expect(
        tool.execute('test-id', {} as any, undefined, undefined, undefined as any)
      ).rejects.toThrow('Invalid parameters for search');
    });

    it('should throw error when queries array is empty', async () => {
      const tool = createSearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      await expect(
        tool.execute('test-id', { queries: [] }, undefined, undefined, undefined as any)
      ).rejects.toThrow('At least one query is required');
    });

    it('should throw error when queries is missing', async () => {
      const tool = createSearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      await expect(
        tool.execute('test-id', { maxResults: 10 }, undefined, undefined, undefined as any)
      ).rejects.toThrow('Invalid parameters for search');
    });

    it('should accept single query', async () => {
      const { search } = await import('../../../src/web-research/search.ts');
      vi.mocked(search).mockResolvedValue([
        { query: 'test query', results: [] },
      ]);

      const tool = createSearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test query'] },
        undefined,
        undefined,
        undefined as any
      );
      expect(result).toBeDefined();
    });

    it('should format search results into Markdown correctly', async () => {
      const { search } = await import('../../../src/web-research/search.ts');
      vi.mocked(search).mockResolvedValue([
        {
          query: 'test query',
          results: [
            { title: 'Result 1', url: 'https://example.com/1', content: 'Snippet 1', engine: 'google' },
            { title: 'Result 2', url: 'https://example.com/2', content: 'Snippet 2', engine: 'bing' },
          ],
        },
      ]);

      const tool = createSearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const result = await tool.execute(
        'test-id',
        { queries: ['test query'] },
        undefined,
        undefined,
        undefined as any
      );

      const content = result.content[0] as any;
      expect(content.type).toBe('text');
      expect(content.text).toContain('# Web Search Results');
      expect(content.text).toContain('## Query: test query');
      expect(content.text).toContain('### 1. Result 1');
      expect(content.text).toContain('- **URL:** https://example.com/1');
      expect(content.text).toContain('- **Snippet:** Snippet 1');
      expect(content.text).toContain('### 2. Result 2');
      expect(content.text).toContain('- **URL:** https://example.com/2');
      expect(content.text).toContain('- **Snippet:** Snippet 2');
    });
  });

  describe('execute - tracker', () => {
    it('should record call in tracker', async () => {
      const { search } = await import('../../../src/web-research/search.ts');
      vi.mocked(search).mockResolvedValue([
        { query: 'test query', results: [] },
      ]);

      const tracker = createMockTracker();
      const spy = vi.spyOn(tracker, 'recordCall');
      const tool = createSearchTool({ ctx: createMockContext(), tracker });
      
      await tool.execute(
        'test-id',
        { queries: ['test query'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(spy).toHaveBeenCalledWith('search');
    });

    it('should throw error if limit exceeded', async () => {
      const tracker = new ToolUsageTracker({ gathering: 1 });
      tracker.recordCall('search'); // Limit reached

      const tool = createSearchTool({ ctx: createMockContext(), tracker });

      await expect(
        tool.execute(
          'test-id',
          { queries: ['test query'] },
          undefined,
          undefined,
          undefined as any
        )
      ).rejects.toThrow('GATHERING LIMIT REACHED');
    });
  });
});
