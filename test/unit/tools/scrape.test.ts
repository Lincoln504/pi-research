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

  it('should have correct name and batch protocol in guidelines', () => {
    const tool = createScrapeTool({ ...mockOptions, tracker });
    expect(tool.name).toBe('scrape');
    expect(tool.promptGuidelines.some(g => g.includes('Batch 1'))).toBe(true);
    expect(tool.promptGuidelines.some(g => g.includes('4 URLs'))).toBe(true);
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

  it('result should include scraped markdown content in text output', async () => {
    const { scrape } = await import('../../../src/web-research/scrapers.ts');
    vi.mocked(scrape).mockResolvedValueOnce([
      { url: 'https://example.com', success: true, markdown: 'scraped page content here', source: 'fetch' },
    ]);

    const tool = createScrapeTool({ ...mockOptions, tracker });
    const result = await tool.execute('call-1', { urls: ['https://example.com'] }, undefined, () => {}, {} as any);

    const textContent = result.content.find(c => c.type === 'text')?.text ?? '';
    expect(textContent).toContain('scraped page content here');
    expect(textContent).toContain('https://example.com');
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
