import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStoredSearchTool } from '../../../src/tools/stored-search.ts';

const mockSearch = vi.fn();

vi.mock('../../../src/knowledge/index.ts', () => ({
  isKnowledgeStoreReady: vi.fn(),
  getStore: vi.fn(() => ({ search: mockSearch })),
}));

import { isKnowledgeStoreReady, getStore } from '../../../src/knowledge/index.ts';

function makeTool() {
  return createStoredSearchTool({ ctx: {} as any });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('stored_search tool', () => {
  it('returns initializing message when store is not ready', async () => {
    vi.mocked(isKnowledgeStoreReady).mockReturnValue(false);
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
