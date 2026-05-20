import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScrapeTool } from '../../../src/tools/scrape.ts';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker.ts';

// Mock the scrapers module
vi.mock('../../../src/web-research/scrapers.ts', () => ({
  scrape: vi.fn(async (urls) => urls.map((url: string) => ({ url, success: true, markdown: 'fresh content for ' + url, source: 'fetch' }))),
}));

// Mock knowledge module
vi.mock('../../../src/knowledge/index.ts', () => ({
  isKnowledgeStoreReady: vi.fn(),
  getStore: vi.fn(),
  getWriterQueue: vi.fn(() => ({
    enqueue: vi.fn(),
  })),
}));

vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({
    MAX_SCRAPE_BATCHES: 2,
  })),
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

  it('bypasses fetch and uses rawText if available in cache', async () => {
    const { isKnowledgeStoreReady, getStore } = await import('../../../src/knowledge/index.ts');
    const { scrape } = await import('../../../src/web-research/scrapers.ts');
    
    vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
    const rebuildDocumentMock = vi.fn().mockImplementation(async (url) => {
      if (url.includes('example.com')) {
        return {
          text: 'Cached Summary',
          metadata: { ingestionType: 'summary', rawText: 'Cached Raw Text' }
        };
      }
      return null;
    });
    vi.mocked(getStore).mockReturnValue({ rebuildDocument: rebuildDocumentMock } as any);

    const tool = createScrapeTool({ ...mockOptions, tracker });
    const result = await tool.execute('call-1', { urls: ['https://example.com'] }, undefined, () => {}, {} as any);
    
    // Scrape should not have been called because it was fully cached
    expect(scrape).not.toHaveBeenCalled();
    
    const textContent = result.content[0].text;
    expect(textContent).toContain('Historical Summaries:');
    expect(textContent).toContain('Cached Raw Text');
    expect(textContent).toContain('**Historical Summary (Previous Finding):** Cached Summary');
  });

  it('fetches fresh content but includes historical summary if rawText is missing', async () => {
    const { isKnowledgeStoreReady, getStore } = await import('../../../src/knowledge/index.ts');
    const { scrape } = await import('../../../src/web-research/scrapers.ts');
    
    vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
    const rebuildDocumentMock = vi.fn().mockImplementation(async (url) => {
      if (url.includes('example.com')) {
        return {
          text: 'Cached Summary',
          metadata: { ingestionType: 'summary' } // NO rawText
        };
      }
      return null;
    });
    vi.mocked(getStore).mockReturnValue({ rebuildDocument: rebuildDocumentMock } as any);

    const tool = createScrapeTool({ ...mockOptions, tracker });
    const result = await tool.execute('call-1', { urls: ['https://example.com'] }, undefined, () => {}, {} as any);
    
    // Scrape should have been called because rawText was missing
    expect(scrape).toHaveBeenCalledTimes(1);
    
    const textContent = result.content[0].text;
    expect(textContent).toContain('Historical Summaries:');
    expect(textContent).toContain('fresh content for https://example.com');
    expect(textContent).toContain('**Historical Summary (Previous Finding):** Cached Summary');
  });
});
