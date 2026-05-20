import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScrapeTool } from '../../../src/tools/scrape.ts';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker.ts';
import { registerScrapedLinks, cleanupSharedLinks } from '../../../src/utils/shared-links.ts';

// Mock the scrapers module
vi.mock('../../../src/web-research/scrapers.ts', () => ({
  scrape: vi.fn(async (urls) => urls.map(url => ({ url, success: true, markdown: 'content', source: 'fetch' }))),
}));

// Mock config
vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({
    MAX_SCRAPE_BATCHES: 2,
    MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: 1.0,
    AVG_TOKENS_PER_SCRAPE: 10000,
    KNOWLEDGE_STORE_ENABLED: true,
  })),
  DEFAULTS: {
    KNOWLEDGE_STORE_ENABLED: true,
  },
}));

// Mock knowledge module
vi.mock('../../../src/knowledge/index.ts', () => {
  return {
    isKnowledgeStoreReady: vi.fn().mockReturnValue(true),
    getStore: vi.fn().mockResolvedValue({
      rebuildDocument: vi.fn().mockResolvedValue(null),
    }),
    getWriterQueue: vi.fn().mockResolvedValue({
      enqueue: vi.fn(),
    }),
  };
});

describe('tools/scrape', () => {
  let tracker: ToolUsageTracker;
  const researchId = 'test-research-id';
  const mockOptions = {
    ctx: {} as any,
    tracker: undefined as any, // set in beforeEach
    getGlobalState: () => ({ researchId, rootQuery: 'test' } as any),
    updateGlobalLinks: vi.fn(),
    onLinksScraped: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    cleanupSharedLinks(researchId);
    tracker = new ToolUsageTracker({ scrape: 2 });
    mockOptions.tracker = tracker;
    
    // Reset the store mock for each test
    const { getStore } = await import('../../../src/knowledge/index.ts');
    const store = await getStore();
    vi.mocked(store.rebuildDocument).mockReset();
    vi.mocked(store.rebuildDocument).mockResolvedValue(null);
  });

  it('should have correct name and batch protocol in guidelines', () => {
    const tool = createScrapeTool(mockOptions);
    expect(tool.name).toBe('scrape');
    expect(tool.promptGuidelines.some(g => g.includes('Batch 1'))).toBe(true);
  });

  it('should handle malformed URL inputs like [url1, url2]', async () => {
    const tool = createScrapeTool(mockOptions);
    await tool.execute('call-1', { urls: ['[https://example.com/1, https://example.com/2]'] }, undefined);
    
    expect(mockOptions.updateGlobalLinks).toHaveBeenCalledWith([
      'https://example.com/1',
      'https://example.com/2'
    ]);
  });

  it('should deduplicate URLs globally and skip already scraped ones', async () => {
    registerScrapedLinks(researchId, ['https://example.com/already']);
    
    const tool = createScrapeTool(mockOptions);
    const result = await tool.execute('call-1', { 
      urls: ['https://example.com/already', 'https://example.com/new'] 
    }, undefined);

    const textContent = result.content.find(c => c.type === 'text')?.text ?? '';
    expect(textContent).toContain('Global Deduplication');
    expect(textContent).toContain('1 URL(s) skipped');
    expect(mockOptions.updateGlobalLinks).toHaveBeenCalledWith(['https://example.com/new']);
  });

  it('should return skip message if all URLs are duplicates', async () => {
    registerScrapedLinks(researchId, ['https://example.com/1']);
    
    const tool = createScrapeTool(mockOptions);
    const result = await tool.execute('call-1', { urls: ['https://example.com/1'] }, undefined);

    expect(result.details).toMatchObject({ all_duplicates: true });
    expect(result.content[0].text).toContain('Skipped');
  });

  it('should use knowledge store cache for raw-content hits', async () => {
    const { getStore } = await import('../../../src/knowledge/index.ts');
    const store = await getStore();
    vi.mocked(store.rebuildDocument).mockResolvedValueOnce({
      text: 'cached content',
      metadata: { ingestionType: 'raw-content' }
    });

    const { scrape } = await import('../../../src/web-research/scrapers.ts');
    const tool = createScrapeTool(mockOptions);
    const result = await tool.execute('call-1', { urls: ['https://example.com/cached'] }, undefined);

    expect(scrape).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('cached content');
    expect(result.details).toMatchObject({ count: 1 });
  });

  it('should handle legacy summary cache hits with rawText metadata', async () => {
    const { getStore } = await import('../../../src/knowledge/index.ts');
    const store = await getStore();
    vi.mocked(store.rebuildDocument).mockResolvedValueOnce({
      text: 'agent summary',
      metadata: { ingestionType: 'summary', rawText: 'original raw markdown' }
    });

    const tool = createScrapeTool(mockOptions);
    const result = await tool.execute('call-1', { urls: ['https://example.com/legacy'] }, undefined);

    expect(result.content[0].text).toContain('original raw markdown');
    expect(result.content[0].text).toContain('> **Historical Summary (Previous Finding):** agent summary');
  });

  it('should change default concurrency for Batch 2+', async () => {
    const { scrape } = await import('../../../src/web-research/scrapers.ts');
    const tool = createScrapeTool(mockOptions);
    
    // Call 1 (Batch 1)
    await tool.execute('call-1', { urls: ['https://ex.com/1'] }, undefined);
    expect(scrape).toHaveBeenCalledWith(['https://ex.com/1'], 10, undefined, undefined);
    
    // Call 2 (Batch 2)
    await tool.execute('call-2', { urls: ['https://ex.com/2'] }, undefined);
    // BATCH_2_DEFAULT_CONCURRENCY is 15
    expect(scrape).toHaveBeenCalledWith(['https://ex.com/2'], 15, undefined, undefined);
  });

  it('should fail on third call (limit 2)', async () => {
    const tool = createScrapeTool(mockOptions);
    await tool.execute('call-1', { urls: ['https://example.com/1'] }, undefined);
    await tool.execute('call-2', { urls: ['https://example.com/2'] }, undefined);
    
    const result = await tool.execute('call-3', { urls: ['https://example.com/3'] }, undefined);
    expect(result.details).toMatchObject({ blocked: true, reason: 'limit_reached' });
  });
});
