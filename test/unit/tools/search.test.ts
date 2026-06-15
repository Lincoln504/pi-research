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

  it('should cap queries at 30 if too many are provided', async () => {
    const { search } = await import('../../../src/web-research/search.ts');
    const tool = createSearchTool(mockOptions);
    const manyQueries = Array(50).fill('q');

    await tool.execute('id', { queries: manyQueries }, undefined, undefined, {} as any);

    expect(search).toHaveBeenCalledWith(
      expect.arrayContaining(Array(30).fill('q')),
      undefined, // options.config
      undefined, // signal
      expect.any(Function), // implementation wraps onProgress in a lambda
      expect.any(Object) // container
    );
    expect(vi.mocked(search).mock.calls[0][0].length).toBe(30);
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

  it('should throw error on second call', async () => {
    const tool = createSearchTool(mockOptions);
    await tool.execute('id1', { queries: ['q1'] }, undefined, undefined, {} as any);

    const result = await tool.execute('id2', { queries: ['q2'] }, undefined, undefined, {} as any);
    expect(result.details).toMatchObject({ blocked: true, reason: 'limit_reached' });
  });
});
