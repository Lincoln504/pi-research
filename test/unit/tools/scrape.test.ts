import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScrapeTool } from '../../../src/tools/scrape.ts';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker.ts';

// Mock the scrapers module
vi.mock('../../../src/web-research/scrapers.ts', () => ({
  scrape: vi.fn(async (urls) => urls.map(url => ({ url, success: true, markdown: 'content', source: 'fetch' }))),
  scrapeSingle: vi.fn(async (url) => ({ url, success: true, markdown: 'content', source: 'fetch' })),
}));

// Mock config to set high context threshold (prevents context gate from triggering)
vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({
    MAX_SCRAPE_BATCHES: 2,
    MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: 1.0, // 100% threshold - never triggers
    AVG_TOKENS_PER_SCRAPE: 10000,
  })),
}));

describe('tools/scrape', () => {
  let tracker: ToolUsageTracker;
  const mockOptions = {
    ctx: {} as any,
    getGlobalState: () => ({ rootQuery: 'test' } as any),
    updateGlobalLinks: vi.fn(),
    onLinksScraped: vi.fn(),
    getTokensUsed: () => 1000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = new ToolUsageTracker({ scrape: 2 });
  });

  it('should have correct metadata and protocol in guidelines', () => {
    const tool = createScrapeTool({ ...mockOptions, tracker });
    expect(tool.name).toBe('scrape');
    // Check that protocol guidelines are present (may be unlimited)
    expect(tool.promptGuidelines.some(function(g) { return g.includes('PROTOCOL: Batch 1 → Batch 2'); }));
    expect(tool.promptGuidelines.some(function(g) { return g.includes('up to 4 URLs each'); }));
  });

  it('should perform Batch 1 on first call', async () => {
    const tool = createScrapeTool({ ...mockOptions, tracker });
    const result = await tool.execute('call-1', { urls: ['https://example.com'] }, undefined, () => {}, {} as any);
    
    expect(result.details).toMatchObject({ batch: 1 });
    expect(mockOptions.updateGlobalLinks).toHaveBeenCalledWith(['https://example.com']);
  });

  it('should perform Batch 2 on second call', async () => {
    const tool = createScrapeTool({ ...mockOptions, tracker });
    await tool.execute('call-1', { urls: ['https://example.com/1'] }, undefined, () => {}, {} as any);
    const result = await tool.execute('call-2', { urls: ['https://example.com/2'] }, undefined, () => {}, {} as any);
    
    expect(result.details).toMatchObject({ batch: 2 });
  });

  it('should fail on third call (limit 2)', async () => {
    const tool = createScrapeTool({ ...mockOptions, tracker });
    await tool.execute('call-1', { urls: ['https://example.com/1'] }, undefined, () => {}, {} as any);
    await tool.execute('call-2', { urls: ['https://example.com/2'] }, undefined, () => {}, {} as any);
    
    const result = await tool.execute('call-3', { urls: ['https://example.com/3'] }, undefined, () => {}, {} as any);
    expect(result.details).toMatchObject({ blocked: true, reason: 'limit_reached' });
    expect(result.content[0].text).toContain('COMPLETE');
  });
});
