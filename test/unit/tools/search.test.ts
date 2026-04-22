import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSearchTool } from '../../../src/tools/search.ts';
import { search } from '../../../src/web-research/search.ts';
import type { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker.ts';

vi.mock('../../../src/web-research/search.ts', () => ({
  search: vi.fn(),
}));

function createMockContext() {
  return {
    signal: new AbortController().signal,
  } as any;
}

function createMockTracker(): ToolUsageTracker {
  return {
    getLimits: vi.fn().mockReturnValue({ search: 4 }),
    getUsage: vi.fn().mockReturnValue(0),
    recordCall: vi.fn().mockReturnValue(true),
  } as any;
}

describe('tools/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('should create tool with correct metadata and guidelines', () => {
      const tool = createSearchTool({ ctx: createMockContext(), tracker: createMockTracker() });

      expect(tool.name).toBe('search');
      expect(tool.label).toBe('Search');
      expect(tool.description).toContain('Search the web');
      expect(tool.description).toContain('10-150');

      expect(tool.promptSnippet).toBeDefined();
      expect(tool.promptGuidelines.length).toBeGreaterThan(0);
      expect(tool.promptGuidelines).toContainEqual(expect.stringContaining('10 and a maximum of 150 queries'));
      expect(tool.promptGuidelines).toContainEqual(expect.stringContaining('4 gathering calls'));
    });
  });

  describe('Parameters', () => {
    it('should have queries parameter properly defined', () => {
      const tool = createSearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const props = (tool.parameters as any).properties;

      expect(props).toHaveProperty('queries');
      expect(props.queries).toBeDefined();
    });
  });

  describe('execute', () => {
    it('should return error text when queries is empty', async () => {
      const tool = createSearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const result = await tool.execute('id', { queries: [] }, undefined as any, undefined as any, createMockContext());
      
      expect(result.content[0].type).toBe('text');
      expect((result.content[0] as any).text).toContain('At least one query is required');
    });

    it('should return error text when queries is missing', async () => {
      const tool = createSearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      const result = await tool.execute('id', {}, undefined as any, undefined as any, createMockContext());
      
      expect(result.content[0].type).toBe('text');
      expect((result.content[0] as any).text).toContain('At least one query is required');
    });

    it('should format search results into Markdown correctly', async () => {
      const tool = createSearchTool({ ctx: createMockContext(), tracker: createMockTracker() });
      
      vi.mocked(search).mockResolvedValue([
        {
          query: 'test query',
          results: [
            { title: 'Result 1', url: 'http://example.com/1', content: 'Snippet 1' },
          ],
        }
      ]);

      const result = await tool.execute('id', { queries: ['test query'] }, undefined as any, undefined as any, createMockContext());

      const content = result.content[0] as any;
      expect(content.type).toBe('text');
      expect(content.text).toContain('# Search Results (1 queries)');
      expect(content.text).toContain('## Query 1: test query');
      expect(content.text).toContain('[1] **Result 1**');
    });

    it('should record call in tracker', async () => {
      const tracker = createMockTracker();
      const tool = createSearchTool({ ctx: createMockContext(), tracker });
      
      vi.mocked(search).mockResolvedValue([]);

      await tool.execute('id', { queries: ['test query'] }, undefined as any, undefined as any, createMockContext());

      expect(tracker.recordCall).toHaveBeenCalledWith('search');
    });

    it('should return error text if limit exceeded', async () => {
      const tracker = createMockTracker();
      vi.mocked(tracker.recordCall).mockReturnValue(false); // Simulate limit reached
      
      const tool = createSearchTool({ ctx: createMockContext(), tracker });
      
      const result = await tool.execute('id', { queries: ['test query'] }, undefined as any, undefined as any, createMockContext());

      expect(result.content[0].type).toBe('text');
      expect((result.content[0] as any).text).toContain('GATHERING LIMIT REACHED');
    });
  });
});
