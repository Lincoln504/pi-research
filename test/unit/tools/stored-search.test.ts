import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStoredSearchTool } from '../../../src/tools/stored-search.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';

const mockSearch = vi.fn();
const mockIsReady = vi.fn().mockReturnValue(true);

vi.mock('../../../src/knowledge/index.ts', () => ({
  isKnowledgeStoreReady: vi.fn(),
  initKnowledgeStore: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/core/service-registry.ts', () => ({
  getService: vi.fn(async (name) => {
    if (name === ServiceNames.KNOWLEDGE_STORE) {
      return {
        search: mockSearch,
        isReady: mockIsReady,
        initialize: vi.fn().mockResolvedValue(undefined),
        getStore: vi.fn().mockResolvedValue({ search: mockSearch }),
      };
    }
    throw new Error(`Service ${name} not mocked`);
  }),
}));

// isKnowledgeStoreReady is provided by the vi.mock above
const { isKnowledgeStoreReady } = await import('../../../src/knowledge/index.ts') as any;

function makeTool() {
  return createStoredSearchTool({ ctx: {} as any });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsReady.mockReturnValue(true);
});

describe('stored_search tool', () => {
  it('returns initializing message when store is not ready', async () => {
    vi.mocked(isKnowledgeStoreReady).mockReturnValue(false);
    mockIsReady.mockReturnValue(false);
    const tool = makeTool();
    const result = await tool.execute('id', { query: 'test' }, undefined, undefined, {} as any);
    expect(result.details).toEqual({ status: 'initializing' });
    expect((result.content[0] as any).text).toContain('initializing');
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('returns no-results message when store returns empty array', async () => {
    vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
    mockSearch.mockResolvedValue([]);
    const tool = makeTool();
    const result = await tool.execute('id', { query: 'nothing' }, undefined, undefined, {} as any);
    expect(result.details).toEqual({ count: 0 });
    expect((result.content[0] as any).text).toContain('No matching information found');
  });

  it('formats results with URL heading, chunk metadata, and text', async () => {
    vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
    mockSearch.mockResolvedValue([
      {
        url: 'https://example.com/page',
        text: 'The answer is 42.',
        metadata: { chunkIndex: 0, totalChunks: 3 },
      },
    ]);
    const tool = makeTool();
    const result = await tool.execute('id', { query: 'answer' }, undefined, undefined, {} as any);
    const text = (result.content[0] as any).text as string;
    expect(result.details).toEqual({ count: 1 });
    expect(text).toContain('https://example.com/page');
    expect(text).toContain('chunk 1 of 3');
    expect(text).toContain('The answer is 42.');
  });

  it('passes limit parameter through to store.search', async () => {
    vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
    mockSearch.mockResolvedValue([]);
    const tool = makeTool();
    await tool.execute('id', { query: 'test', limit: 10 }, undefined, undefined, {} as any);
    expect(mockSearch).toHaveBeenCalledWith('test', { limit: 10 });
  });

  it('returns error details when store.search throws', async () => {
    vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
    mockSearch.mockRejectedValue(new Error('DB read error'));
    const tool = makeTool();
    const result = await tool.execute('id', { query: 'test' }, undefined, undefined, {} as any);
    expect(result.details).toEqual({ error: 'search_failed' });
    expect((result.content[0] as any).text).toContain('DB read error');
  });
});
