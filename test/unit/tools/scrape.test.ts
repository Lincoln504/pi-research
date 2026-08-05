import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { createScrapeTool } from '../../../src/tools/scrape.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';

// Mock the web-scraper module
vi.mock('../../../src/web-research/web-scraper.ts', () => ({
  scrape: vi.fn(async (urls: any) => urls.map((url: any) => ({ url, success: true, markdown: `This is a longer content string from ${url} that exceeds the minimum 100 character requirement for successful scraping validation to pass properly`, source: 'fetch' }))),
  scrapeSingle: vi.fn(),
  getDependencyStatus: vi.fn(() => ({ playwrightAvailable: false })),
}));

// Mock config
const mockConfig = {
  MAX_SCRAPE_BATCHES: 2,
  MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: 1.0,
  AVG_TOKENS_PER_SCRAPE: 10000,
  KNOWLEDGE_STORE_MODE: 'none',
  MAX_CONCURRENT_SCRAPES: 3,
};

vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => mockConfig),
  DEFAULTS: {
    KNOWLEDGE_STORE_MODE: 'none',
  },
}));

const mockRebuildDocument = vi.fn().mockResolvedValue(null);
const mockKnowledgeStore = {
  rebuildDocument: mockRebuildDocument,
};

vi.mock('../../../src/core/service-registry.ts', () => ({
  getService: vi.fn(async (name: any, _ctx?: any, _container?: any) => {
    if (name === ServiceNames.KNOWLEDGE_STORE) {
      return {
        isReady: vi.fn().mockReturnValue(true),
        getStore: vi.fn().mockResolvedValue(mockKnowledgeStore),
      };
    }
    throw new Error(`Service ${name} not mocked`);
  }),
  tryGetServiceContainerFromCtx: vi.fn((ctx: any) => ctx?.container || { isReady: true }),
}));

describe('tools/scrape', () => {
  const mockOptions = {
    ctx: {} as any,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRebuildDocument.mockReset();
    mockRebuildDocument.mockResolvedValue(null);
  });

  it('should have correct name', () => {
    const tool = createScrapeTool(mockOptions);
    expect(tool.name).toBe('scrape');
  });

  it('should have correct label and description', () => {
    const tool = createScrapeTool(mockOptions);
    expect(tool.label).toBe('Scrape Web Pages');
    expect(tool.description).toContain('Fetch and extract');
  });

  it('should scrape URLs and return markdown results', async () => {
    const { scrape } = await import('../../../src/web-research/web-scraper.ts');
    const tool = createScrapeTool(mockOptions);
    const result = await tool.execute('call-1', { urls: ['https://example.com/1'] }, undefined, undefined, {} as any);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect((result.content[0] as any).text).toContain('Scrape Results');
    expect((result.content[0] as any).text).toContain('https://example.com/1');
    const details = result.details as any;
    expect(details).toMatchObject({
      total: 1,
      successful: 1,
      failed: 0,
      cached: 0,
      fresh: 1,
    });
    expect(scrape).toHaveBeenCalledWith(['https://example.com/1'], 3, undefined, undefined, 'standalone', expect.any(Function), expect.anything());
  });

  it('should handle multiple URLs', async () => {
    const { scrape } = await import('../../../src/web-research/web-scraper.ts');
    const tool = createScrapeTool(mockOptions);
    const result = await tool.execute('call-1', { urls: ['https://example.com/1', 'https://example.com/2'] }, undefined, undefined, {} as any);

    const details = result.details as any;
    expect(details.total).toBe(2);
    expect(details.successful).toBe(2);
    expect(details.fresh).toBe(2);
    expect(scrape).toHaveBeenCalledWith(['https://example.com/1', 'https://example.com/2'], 3, undefined, undefined, 'standalone', expect.any(Function), expect.anything());
  });

  it('should return error for invalid parameters', async () => {
    const tool = createScrapeTool(mockOptions);
    const result = await tool.execute('call-1', { invalid: 'param' }, undefined, undefined, {} as any);

    expect(result.content).toHaveLength(1);
    expect((result.content[0] as any).text).toContain('Invalid parameters');
    expect(result.details).toMatchObject({ error: 'invalid_params' });
  });

  it('should return error for empty URLs array', async () => {
    const tool = createScrapeTool(mockOptions);
    const result = await tool.execute('call-1', { urls: [] }, undefined, undefined, {} as any);

    expect(result.content).toHaveLength(1);
    expect((result.content[0] as any).text).toContain('Invalid parameters');
    // Typebox validates minItems: 1, so empty array fails validation
  });

  it('should handle failed scrapes', async () => {
    const { scrape } = await import('../../../src/web-research/web-scraper.ts');
    (scrape as any).mockResolvedValueOnce([
      { url: 'https://example.com/1', success: true, markdown: 'valid content longer than 100 chars with plenty of padding to ensure it passes the minimum length check', source: 'fetch' },
      { url: 'https://example.com/2', success: false, error: 'HTTP 404', markdown: '', source: 'fetch' },
    ]);

    const tool = createScrapeTool(mockOptions);
    const result = await tool.execute('call-1', { urls: ['https://example.com/1', 'https://example.com/2'] }, undefined, undefined, {} as any);

    const details = result.details as any;
    expect(details.total).toBe(2);
    expect(details.successful).toBe(1);
    expect(details.failed).toBe(1);
    expect((result.content[0] as any).text).toContain('Scrape Results (1 successful)');
    expect((result.content[0] as any).text).toContain('Failed to Scrape (1 failed)');
  });

  it('should use maxConcurrency from parameters', async () => {
    const { scrape } = await import('../../../src/web-research/web-scraper.ts');
    const tool = createScrapeTool(mockOptions);
    await tool.execute('call-1', { urls: ['https://example.com/1'], maxConcurrency: 5 }, undefined, undefined, {} as any);

    expect(scrape).toHaveBeenCalledWith(['https://example.com/1'], 5, undefined, undefined, 'standalone', expect.any(Function), expect.anything());
  });

  describe('per-document content cap (context-overflow guard)', () => {
    it('truncates an oversized document to MAX_SCRAPE_CONTENT_CHARS_PER_DOC with an explicit marker', async () => {
      const { MAX_SCRAPE_CONTENT_CHARS_PER_DOC } = await import('../../../src/constants.ts');
      const { scrape } = await import('../../../src/web-research/web-scraper.ts');
      const hugeDoc = 'scraped pdf text line\n'.repeat(100_000); // 2.2M chars — like a huge PDF
      (scrape as any).mockResolvedValueOnce([
        { url: 'https://example.com/huge.pdf', success: true, markdown: hugeDoc, source: 'fetch' },
      ]);

      const tool = createScrapeTool(mockOptions);
      const result = await tool.execute('call-1', { urls: ['https://example.com/huge.pdf'] }, undefined, undefined, {} as any);
      const text = (result.content[0] as any).text as string;

      // The embedded document must be capped, not passed through verbatim
      expect(text).toContain('[content truncated: showing');
      expect(text.length).toBeLessThan(MAX_SCRAPE_CONTENT_CHARS_PER_DOC + 2_000); // doc capped + small envelope
      expect(text.length).toBeLessThan(hugeDoc.length); // sanity: nowhere near 2.2M
      // Marker reports the true original size
      expect(text).toContain(`of ${hugeDoc.length} chars]`);
    });

    it('caps each document independently in a multi-URL batch', async () => {
      const { MAX_SCRAPE_CONTENT_CHARS_PER_DOC } = await import('../../../src/constants.ts');
      const { scrape } = await import('../../../src/web-research/web-scraper.ts');
      const hugeDoc = 'x'.repeat(MAX_SCRAPE_CONTENT_CHARS_PER_DOC + 100_000);
      (scrape as any).mockResolvedValueOnce([
        { url: 'https://example.com/big1', success: true, markdown: hugeDoc, source: 'fetch' },
        { url: 'https://example.com/big2', success: true, markdown: hugeDoc, source: 'fetch' },
      ]);

      const tool = createScrapeTool(mockOptions);
      const result = await tool.execute('call-1', { urls: ['https://example.com/big1', 'https://example.com/big2'] }, undefined, undefined, {} as any);
      const text = (result.content[0] as any).text as string;

      expect((text.match(/\[content truncated: showing/g) || []).length).toBe(2);
      expect(text.length).toBeLessThan(2 * MAX_SCRAPE_CONTENT_CHARS_PER_DOC + 4_000);
    });

    it('leaves normal-sized documents untouched (no marker)', async () => {
      const { scrape } = await import('../../../src/web-research/web-scraper.ts');
      const normalDoc = 'A regular article body. '.repeat(200); // ~4.8k chars
      (scrape as any).mockResolvedValueOnce([
        { url: 'https://example.com/article', success: true, markdown: normalDoc, source: 'fetch' },
      ]);

      const tool = createScrapeTool(mockOptions);
      const result = await tool.execute('call-1', { urls: ['https://example.com/article'] }, undefined, undefined, {} as any);
      const text = (result.content[0] as any).text as string;

      expect(text).toContain(normalDoc);
      expect(text).not.toContain('[content truncated');
    });
  });
});

describe('tools/scrape — Session URL Pool footer', () => {
  // These tests use the real shared-links module (no mock) to verify footer behavior
  const researchId = 'footer-test-session';

  // We need to import the real shared-links functions for footer tests
  // but the scrape tool still uses mocked web-scraper
  let registerScrapedLinks: typeof import('../../../src/utils/shared-links.ts').registerScrapedLinks;
  let cleanupSharedLinks: typeof import('../../../src/utils/shared-links.ts').cleanupSharedLinks;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRebuildDocument.mockReset();
    mockRebuildDocument.mockResolvedValue(null);
    const sharedLinks = await import('../../../src/utils/shared-links.ts');
    registerScrapedLinks = sharedLinks.registerScrapedLinks;
    cleanupSharedLinks = sharedLinks.cleanupSharedLinks;
    cleanupSharedLinks(researchId);
  });

  afterEach(() => {
    cleanupSharedLinks(researchId);
  });

  it('should include footer when pool has URLs from other researchers', async () => {
    // Pre-populate the pool with URLs from a "sibling" researcher
    registerScrapedLinks(researchId, ['https://sibling.com/page1', 'https://sibling.com/page2']);

    const tool = createScrapeTool({
      ctx: {} as any,
      getGlobalState: () => ({
        version: 1,
        researchId,
        rootQuery: 'test',
        complexity: 1,
        currentRound: 1,
        status: 'researching',
        lastUpdated: Date.now(),
        initialAgenda: [],
        allScrapedLinks: [],
        aspects: {},
      }),
      updateGlobalLinks: (links: string[]) => registerScrapedLinks(researchId, links),
    });

    const result = await tool.execute('call-1', { urls: ['https://new.com/page'] }, undefined, undefined, {} as any);
    const text = (result.content[0] as any).text;

    expect(text).toContain('Session URL Pool');
    expect(text).toContain('https://sibling.com/page1');
    expect(text).toContain('https://sibling.com/page2');
  });

  it('should exclude current batch URLs from footer', async () => {
    registerScrapedLinks(researchId, ['https://example.com/already-scraped']);

    const tool = createScrapeTool({
      ctx: {} as any,
      getGlobalState: () => ({
        version: 1,
        researchId,
        rootQuery: 'test',
        complexity: 1,
        currentRound: 1,
        status: 'researching',
        lastUpdated: Date.now(),
        initialAgenda: [],
        allScrapedLinks: [],
        aspects: {},
      }),
      updateGlobalLinks: (links: string[]) => registerScrapedLinks(researchId, links),
    });

    // The current batch URL (https://example.com/already-scraped) is a pool member
    // with no surviving cached content, so it is re-fetched fresh — but it must
    // still be excluded from the footer since it's the current batch
    const result = await tool.execute('call-1', { urls: ['https://example.com/already-scraped'] }, undefined, undefined, {} as any);
    const text = (result.content[0] as any).text;

    // The footer should be absent since the only pool URL is the current batch.
    expect(text).not.toContain('Session URL Pool');
  });

  it('should hide footer when pool is empty', async () => {
    const tool = createScrapeTool({
      ctx: {} as any,
      getGlobalState: () => ({
        version: 1,
        researchId,
        rootQuery: 'test',
        complexity: 1,
        currentRound: 1,
        status: 'researching',
        lastUpdated: Date.now(),
        initialAgenda: [],
        allScrapedLinks: [],
        aspects: {},
      }),
      updateGlobalLinks: (links: string[]) => registerScrapedLinks(researchId, links),
    });

    const result = await tool.execute('call-1', { urls: ['https://new.com/page'] }, undefined, undefined, {} as any);
    const text = (result.content[0] as any).text;

    expect(text).not.toContain('Session URL Pool');
  });

  it('re-fetches a pool member with no surviving cached content (with footer for siblings)', async () => {
    // Register a URL in the pool but don't cache any content — the evicted-duplicate
    // case. It must be re-fetched fresh, not reported as retrieved-from-memory.
    registerScrapedLinks(researchId, ['https://already-scraped.com/page']);
    // Also register a sibling URL that should appear in the footer
    registerScrapedLinks(researchId, ['https://sibling.com/other']);

    const tool = createScrapeTool({
      ctx: {} as any,
      getGlobalState: () => ({
        version: 1,
        researchId,
        rootQuery: 'test',
        complexity: 1,
        currentRound: 1,
        status: 'researching',
        lastUpdated: Date.now(),
        initialAgenda: [],
        allScrapedLinks: [],
        aspects: {},
      }),
      updateGlobalLinks: (links: string[]) => registerScrapedLinks(researchId, links),
    });

    const { scrape } = await import('../../../src/web-research/web-scraper.ts');
    const result = await tool.execute('call-1', { urls: ['https://already-scraped.com/page'] }, undefined, undefined, {} as any);
    const text = (result.content[0] as any).text;

    // Freshly fetched, with the eviction called out — never a silent skip
    expect(scrape).toHaveBeenCalledWith(['https://already-scraped.com/page'], expect.anything(), undefined, undefined, researchId, expect.any(Function), expect.anything());
    expect(text).toContain('URL Scrape Results');
    expect(text).toContain('Session Cache Evicted');
    expect(text).not.toContain('retrieved from session memory');
    // Footer should show the sibling URL (which isn't in the current batch)
    expect(text).toContain('https://sibling.com/other');
  });

  it('should cap footer at 20 URLs with overflow message', async () => {
    // Register 25 URLs in the pool
    const poolUrls = Array.from({ length: 25 }, (_, i) => `https://pool.com/page${i + 1}`);
    registerScrapedLinks(researchId, poolUrls);

    const tool = createScrapeTool({
      ctx: {} as any,
      getGlobalState: () => ({
        version: 1,
        researchId,
        rootQuery: 'test',
        complexity: 1,
        currentRound: 1,
        status: 'researching',
        lastUpdated: Date.now(),
        initialAgenda: [],
        allScrapedLinks: [],
        aspects: {},
      }),
      updateGlobalLinks: (links: string[]) => registerScrapedLinks(researchId, links),
    });

    const result = await tool.execute('call-1', { urls: ['https://new.com/page'] }, undefined, undefined, {} as any);
    const text = (result.content[0] as any).text;

    expect(text).toContain('Session URL Pool');
    expect(text).toContain('...and 5 more');
  });

  it('should not show footer in rate-limit early return', async () => {
    // Create a tool with a tracker that's already at limit
    const { ToolUsageTracker, createDefaultToolLimits } = await import('../../../src/utils/tool-usage-tracker.ts');
    const tracker = new ToolUsageTracker(createDefaultToolLimits());
    // Exhaust the limit
    for (let i = 0; i < 10; i++) tracker.recordCall('scrape');

    registerScrapedLinks(researchId, ['https://pool.com/page']);

    const tool = createScrapeTool({
      ctx: {} as any,
      tracker,
      getGlobalState: () => ({
        version: 1,
        researchId,
        rootQuery: 'test',
        complexity: 1,
        currentRound: 1,
        status: 'researching',
        lastUpdated: Date.now(),
        initialAgenda: [],
        allScrapedLinks: [],
        aspects: {},
      }),
      updateGlobalLinks: (links: string[]) => registerScrapedLinks(researchId, links),
    });

    const result = await tool.execute('call-1', { urls: ['https://example.com/1'] }, undefined, undefined, {} as any);
    const text = (result.content[0] as any).text;

    // Should be rate-limited without footer
    expect(text).toContain('PROTOCOL COMPLETE');
    expect(text).not.toContain('Session URL Pool');
  });

  it('should exclude own researcher\'s previously-scraped URLs from footer', async () => {
    // Simulate: researcher R1 previously scraped sibling.com/page1 (registered in pool + researcherScrapes)
    registerScrapedLinks(researchId, ['https://sibling.com/page1', 'https://other-researcher.com/page']);
    const sharedLinks = await import('../../../src/utils/shared-links.ts');
    sharedLinks.registerResearcherScrapes(researchId, 'R1', ['https://sibling.com/page1']);

    const tool = createScrapeTool({
      ctx: {} as any,
      researcherId: 'R1',
      getGlobalState: () => ({
        version: 1,
        researchId,
        rootQuery: 'test',
        complexity: 1,
        currentRound: 1,
        status: 'researching',
        lastUpdated: Date.now(),
        initialAgenda: [],
        allScrapedLinks: [],
        aspects: {},
      }),
      updateGlobalLinks: (links: string[]) => registerScrapedLinks(researchId, links),
    });

    const result = await tool.execute('call-1', { urls: ['https://new.com/page'] }, undefined, undefined, {} as any);
    const text = (result.content[0] as any).text;

    expect(text).toContain('Session URL Pool');
    // URL scraped by R1 should be excluded from R1's footer
    expect(text).not.toContain('https://sibling.com/page1');
    // URL from other researcher should still appear
    expect(text).toContain('https://other-researcher.com/page');
  });
});

describe('tools/scrape — context gate bills the fetchable slice, over-cap URLs reported', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRebuildDocument.mockReset();
    mockRebuildDocument.mockResolvedValue(null);
  });

  // Defaults reproduce the reported failure mode: 8 × 2500 / 128000 = 0.156 ≥ 0.15
  // (blocked at zero tokens used) while the 6 actually-fetchable URLs project
  // 6 × 2500 / 128000 = 0.117 and must pass.
  const gateConfig = {
    ...mockConfig,
    AVG_TOKENS_PER_SCRAPE: 2500,
    MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: 0.15,
  } as any;

  it('does not block a first batch whose fetchable slice fits the budget', async () => {
    const { scrape } = await import('../../../src/web-research/web-scraper.ts');
    const { MAX_SCRAPE_URLS } = await import('../../../src/constants.ts');
    const urls = Array.from({ length: 8 }, (_, i) => `https://gate.com/p${i + 1}`);

    const tool = createScrapeTool({
      ctx: {} as any,
      config: gateConfig,
      getTokensUsed: () => 0,
      contextWindowSize: 128000,
    });

    const result = await tool.execute('call-1', { urls }, undefined, undefined, {} as any);

    expect((result.details as any).blocked).toBeUndefined();
    // Only the first MAX_SCRAPE_URLS are fetched
    expect(scrape).toHaveBeenCalledWith(urls.slice(0, MAX_SCRAPE_URLS), expect.anything(), undefined, gateConfig, 'standalone', expect.any(Function), expect.anything());
  });

  it('still blocks when tokens already used push the sliced projection over the threshold', async () => {
    const { scrape } = await import('../../../src/web-research/web-scraper.ts');
    const urls = Array.from({ length: 8 }, (_, i) => `https://gate-blocked.com/p${i + 1}`);

    const tool = createScrapeTool({
      ctx: {} as any,
      config: gateConfig,
      // 10000 + 6 × 2500 = 25000 / 128000 = 0.195 ≥ 0.15 → blocked
      getTokensUsed: () => 10000,
      contextWindowSize: 128000,
    });

    const result = await tool.execute('call-1', { urls }, undefined, undefined, {} as any);

    expect(result.details).toMatchObject({ blocked: true, reason: 'context_limit' });
    expect(scrape).not.toHaveBeenCalled();
  });

  it('lists over-cap URLs explicitly as NOT fetched, requestable in a later batch', async () => {
    const { MAX_SCRAPE_URLS } = await import('../../../src/constants.ts');
    const urls = Array.from({ length: 8 }, (_, i) => `https://cap.com/p${i + 1}`);

    const tool = createScrapeTool({ ctx: {} as any });
    const result = await tool.execute('call-1', { urls }, undefined, undefined, {} as any);
    const text = (result.content[0] as any).text as string;

    expect(text).toContain(`Not Fetched — Over Batch Cap (${8 - MAX_SCRAPE_URLS})`);
    expect(text).toContain('NOT fetched');
    expect(text).toContain('later scrape batch');
    expect(text).toContain('https://cap.com/p7');
    expect(text).toContain('https://cap.com/p8');
    expect((result.details as any).skipped).toBe(8 - MAX_SCRAPE_URLS);
    // Skipped URLs never appear as scraped content sections
    expect(text).not.toContain('### https://cap.com/p7');
    expect(text).not.toContain('### https://cap.com/p8');
  });

  it('omits the not-fetched section when the batch fits the cap', async () => {
    const tool = createScrapeTool({ ctx: {} as any });
    const result = await tool.execute('call-1', { urls: ['https://fits.com/only'] }, undefined, undefined, {} as any);
    const text = (result.content[0] as any).text as string;

    expect(text).not.toContain('Not Fetched — Over Batch Cap');
    expect((result.details as any).skipped).toBe(0);
  });
});

describe('tools/scrape — session-memory note counts only surviving cache entries', () => {
  const researchId = 'evicted-dup-session';
  let registerScrapedLinks: typeof import('../../../src/utils/shared-links.ts').registerScrapedLinks;
  let cacheScrapedContent: typeof import('../../../src/utils/shared-links.ts').cacheScrapedContent;
  let cleanupSharedLinks: typeof import('../../../src/utils/shared-links.ts').cleanupSharedLinks;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRebuildDocument.mockReset();
    mockRebuildDocument.mockResolvedValue(null);
    const sharedLinks = await import('../../../src/utils/shared-links.ts');
    registerScrapedLinks = sharedLinks.registerScrapedLinks;
    cacheScrapedContent = sharedLinks.cacheScrapedContent;
    cleanupSharedLinks = sharedLinks.cleanupSharedLinks;
    cleanupSharedLinks(researchId);
  });

  afterEach(() => {
    cleanupSharedLinks(researchId);
  });

  function makeTool() {
    return createScrapeTool({
      ctx: {} as any,
      getGlobalState: () => ({
        version: 1,
        researchId,
        rootQuery: 'test',
        complexity: 1,
        currentRound: 1,
        status: 'researching',
        lastUpdated: Date.now(),
        initialAgenda: [],
        allScrapedLinks: [],
        aspects: {},
      }),
      updateGlobalLinks: (links: string[]) => registerScrapedLinks(researchId, links),
    });
  }

  it('counts only cache-surviving duplicates as retrieved; evicted ones are named and re-fetched', async () => {
    const { scrape } = await import('../../../src/web-research/web-scraper.ts');
    // Both URLs are pool members, but only one still has content in the session cache
    registerScrapedLinks(researchId, ['https://cached.com/a', 'https://evicted.com/b']);
    cacheScrapedContent(researchId, 'https://cached.com/a', 'Surviving cached body with enough length to be a plausible scraped document for the test.');

    const tool = makeTool();
    const result = await tool.execute('call-1', { urls: ['https://cached.com/a', 'https://evicted.com/b'] }, undefined, undefined, {} as any);
    const text = (result.content[0] as any).text as string;

    // The note counts ONLY the surviving entry — not all pool duplicates
    expect(text).toContain('**Global Cache Hit**: 1 URL(s) retrieved from session memory');
    // The evicted duplicate is named explicitly and queued for a fresh fetch
    expect(text).toContain('Session Cache Evicted');
    expect(text).toContain('https://evicted.com/b');
    expect(scrape).toHaveBeenCalledWith(['https://evicted.com/b'], expect.anything(), undefined, undefined, researchId, expect.any(Function), expect.anything());
    // Both URLs produce content sections: one from session memory, one fresh
    expect(text).toContain('Source: Session Memory');
    expect((result.details as any).successful).toBe(2);
    expect((result.details as any).fresh).toBe(1);
  });

  it('reports no cache-hit note when every duplicate was evicted', async () => {
    registerScrapedLinks(researchId, ['https://evicted-only.com/x']);

    const tool = makeTool();
    const result = await tool.execute('call-1', { urls: ['https://evicted-only.com/x'] }, undefined, undefined, {} as any);
    const text = (result.content[0] as any).text as string;

    expect(text).not.toContain('retrieved from session memory');
    expect(text).toContain('Session Cache Evicted');
    expect((result.details as any).fresh).toBe(1);
  });
});
