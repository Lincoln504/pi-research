import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSearchTool } from '../../../src/tools/search.ts';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker.ts';

// Mock the search module
vi.mock('../../../src/web-research/search.ts', () => ({
  search: vi.fn(async (queries: string[], _config: any, _signal: any, onProgress: any) => {
    if (onProgress) onProgress(queries.length * 2); // simulate finding links
    return queries.map((q: string) => ({ query: q, results: [{ title: 'T', url: 'U', content: 'C' }] }));
  }),
}));

vi.mock('../../../src/core/service-registry.ts', () => ({
  getServiceContainer: vi.fn(() => ({})),
  tryGetServiceContainerFromCtx: vi.fn(() => ({})),
}));

describe('tools/search', () => {
  let tracker: ToolUsageTracker;
  const mockOptions = {
    ctx: {} as any,
    tracker: undefined as any,
    onProgress: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = new ToolUsageTracker({ search: 1 });
    mockOptions.tracker = tracker;
  });

  it('should create tool with correct metadata', () => {
    const tool = createSearchTool(mockOptions);
    expect(tool.name).toBe('search');
    expect(tool.promptGuidelines![0]).toContain('5-30 queries');
  });

  it('should REJECT over-cap queries via the schema (no silent truncation)', async () => {
    const { search } = await import('../../../src/web-research/search.ts');
    const tool = createSearchTool(mockOptions);
    const manyQueries = Array(50).fill('q');

    // The schema advertises maxItems: 30 and execute validates against it, so
    // a host that over-sends gets an explicit rejection — NOT 50 queries
    // silently truncated to 30 (the old advertised-50/cap-30 drift).
    const result = await tool.execute('id', { queries: manyQueries }, undefined, undefined, {} as any);
    expect(result.details).toMatchObject({ error: 'invalid_parameters' });
    expect(search).not.toHaveBeenCalled();
  });

  it('advertises an honest schema: maxItems matches the 30-query runtime cap', () => {
    const tool = createSearchTool(mockOptions);
    const queriesProp = (tool.parameters as any).properties.queries;
    expect(queriesProp.maxItems).toBe(30);
    expect(queriesProp.minItems).toBe(1);
  });

  it('should report progress during execution', async () => {
    const tool = createSearchTool(mockOptions);
    await tool.execute('id', { queries: ['q1', 'q2'] }, undefined, undefined, {} as any);
    expect(mockOptions.onProgress).toHaveBeenCalledWith(4);
  });

  it('should handle search failures gracefully', async () => {
    const { search } = await import('../../../src/web-research/search.ts');
    vi.mocked(search).mockRejectedValueOnce(new Error('API Down'));

    const tool = createSearchTool(mockOptions);
    const result = await tool.execute('id', { queries: ['q'] }, undefined, undefined, {} as any);

    expect((result.content[0] as any).text).toContain('Search Failed');
    expect((result.content[0] as any).text).toContain('API Down');
    expect(result.details).toMatchObject({ error: 'API Down' });
  });

  it('blocks the second call with reason limit_reached (one search per researcher)', async () => {
    const tool = createSearchTool(mockOptions);
    await tool.execute('id1', { queries: ['q1'] }, undefined, undefined, {} as any);

    const result = await tool.execute('id2', { queries: ['q2'] }, undefined, undefined, {} as any);
    expect(result.details).toMatchObject({ blocked: true, reason: 'limit_reached' });
  });
});
