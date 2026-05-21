import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScrapeTool } from '../../../src/tools/scrape.ts';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker.ts';

vi.mock('../../../src/web-research/scrapers.ts', () => ({
  scrape: vi.fn(async (urls) => urls.map((url: string) => ({ url, success: true, markdown: 'fresh content for ' + url, source: 'fetch' }))),
}));

vi.mock('../../../src/knowledge/index.ts', () => ({
  isKnowledgeStoreReady: vi.fn(),
  getStore: vi.fn(),
  initKnowledgeStore: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({
    MAX_SCRAPE_BATCHES: 2,
    KNOWLEDGE_STORE_ENABLED: true,
  })),
  DEFAULTS: {
    KNOWLEDGE_STORE_ENABLED: true,
  },
}));

describe('tools/scrape cache integration', () => {
  let tracker: ToolUsageTracker;
  const mockOptions = {
    ctx: {} as any,
    getGlobalState: () => ({ researchId: 'test-res-id' } as any),
    updateGlobalLinks: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = new ToolUsageTracker({ scrape: 2 });
  });

  it('bypasses fetch and returns cached content when rebuildDocument has content', async () => {
    const { isKnowledgeStoreReady, getStore } = await import('../../../src/knowledge/index.ts');
    const { scrape } = await import('../../../src/web-research/scrapers.ts');

    vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
    const rebuildDocumentMock = vi.fn().mockImplementation(async (url) => {
      if (url.includes('example.com')) {
        return {
          text: 'cached full page content',
          metadata: { ingestionType: 'synthesis-description' },
        };
      }
      return null;
    });
    vi.mocked(getStore).mockReturnValue({ rebuildDocument: rebuildDocumentMock } as any);

    const tool = createScrapeTool({ ...mockOptions, tracker });
    const result = await tool.execute('call-1', { urls: ['https://example.com'] }, undefined, () => {}, {} as any);

    expect(scrape).not.toHaveBeenCalled();
    const textContent = result.content[0].text;
    expect(textContent).toContain('cached full page content');
    expect(textContent).toContain('**Successful:** 1');
  });

  it('fetches fresh content when rebuildDocument returns null', async () => {
    const { isKnowledgeStoreReady, getStore } = await import('../../../src/knowledge/index.ts');
    const { scrape } = await import('../../../src/web-research/scrapers.ts');

    vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
    vi.mocked(getStore).mockReturnValue({ rebuildDocument: vi.fn().mockResolvedValue(null) } as any);

    const tool = createScrapeTool({ ...mockOptions, tracker });
    const result = await tool.execute('call-1', { urls: ['https://example.com'] }, undefined, () => {}, {} as any);

    expect(scrape).toHaveBeenCalledTimes(1);
    const textContent = result.content[0].text;
    expect(textContent).toContain('fresh content for https://example.com');
  });
});
