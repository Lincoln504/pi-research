import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScrapeTool } from '../../../src/tools/scrape.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';

// Mock the web-scraper module
vi.mock('../../../src/web-research/web-scraper.ts', () => ({
  scrape: vi.fn(async (urls) => urls.map(url => ({ url, success: true, markdown: `This is a longer content string from ${url} that exceeds the minimum 100 character requirement for successful scraping validation to pass properly`, source: 'fetch' }))),
  scrapeSingle: vi.fn(),
  getDependencyStatus: vi.fn(() => ({ playwrightAvailable: false })),
}));

// Mock config
const mockConfig = {
  MAX_SCRAPE_BATCHES: 2,
  MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: 1.0,
  AVG_TOKENS_PER_SCRAPE: 10000,
  KNOWLEDGE_STORE_ENABLED: false, // Default to disabled for most tests
  MAX_CONCURRENT_SCRAPES: 3,
};

vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => mockConfig),
  DEFAULTS: {
    KNOWLEDGE_STORE_ENABLED: false,
  },
}));

const mockRebuildDocument = vi.fn().mockResolvedValue(null);
const mockKnowledgeStore = {
  rebuildDocument: mockRebuildDocument,
};

vi.mock('../../../src/core/service-registry.ts', () => ({
  getService: vi.fn(async (name) => {
    if (name === ServiceNames.KNOWLEDGE_STORE) {
      return {
        isReady: vi.fn().mockReturnValue(true),
        getStore: vi.fn().mockResolvedValue(mockKnowledgeStore),
      };
    }
    throw new Error(`Service ${name} not mocked`);
  }),
}));

// Mock knowledge module
vi.mock('../../../src/knowledge/index.ts', () => {
  return {
    isKnowledgeStoreReady: vi.fn().mockReturnValue(false), // Default to not ready
    initKnowledgeStore: vi.fn().mockResolvedValue(undefined),
  };
});

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
    const result = await tool.execute('call-1', { urls: ['https://example.com/1'] }, undefined);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Scrape Results');
    expect(result.content[0].text).toContain('https://example.com/1');
    expect(result.details).toMatchObject({
      total: 1,
      successful: 1,
      failed: 0,
      cached: 0,
      fresh: 1,
    });
    expect(scrape).toHaveBeenCalledWith(['https://example.com/1'], 3, undefined, undefined);
  });

  it('should handle multiple URLs', async () => {
    const { scrape } = await import('../../../src/web-research/web-scraper.ts');
    const tool = createScrapeTool(mockOptions);
    const result = await tool.execute('call-1', { urls: ['https://example.com/1', 'https://example.com/2'] }, undefined);

    expect(result.details.total).toBe(2);
    expect(result.details.successful).toBe(2);
    expect(result.details.fresh).toBe(2);
    expect(scrape).toHaveBeenCalledWith(['https://example.com/1', 'https://example.com/2'], 3, undefined, undefined);
  });

  it('should return error for invalid parameters', async () => {
    const tool = createScrapeTool(mockOptions);
    const result = await tool.execute('call-1', { invalid: 'param' }, undefined);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('Invalid parameters');
    expect(result.details).toMatchObject({ error: 'invalid_params' });
  });

  it('should return error for empty URLs array', async () => {
    const tool = createScrapeTool(mockOptions);
    const result = await tool.execute('call-1', { urls: [] }, undefined);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('Invalid parameters');
    // Typebox validates minItems: 1, so empty array fails validation
  });

  it('should handle failed scrapes', async () => {
    const { scrape } = await import('../../../src/web-research/web-scraper.ts');
    scrape.mockResolvedValueOnce([
      { url: 'https://example.com/1', success: true, markdown: 'valid content longer than 100 chars with plenty of padding to ensure it passes the minimum length check', source: 'fetch' },
      { url: 'https://example.com/2', success: false, error: 'HTTP 404', markdown: '', source: 'fetch' },
    ]);

    const tool = createScrapeTool(mockOptions);
    const result = await tool.execute('call-1', { urls: ['https://example.com/1', 'https://example.com/2'] }, undefined);

    expect(result.details.total).toBe(2);
    expect(result.details.successful).toBe(1);
    expect(result.details.failed).toBe(1);
    expect(result.content[0].text).toContain('Scrape Results (1 successful)');
    expect(result.content[0].text).toContain('Failed to Scrape (1 failed)');
  });

  it('should use maxConcurrency from parameters', async () => {
    const { scrape } = await import('../../../src/web-research/web-scraper.ts');
    const tool = createScrapeTool(mockOptions);
    await tool.execute('call-1', { urls: ['https://example.com/1'], maxConcurrency: 5 }, undefined);

    expect(scrape).toHaveBeenCalledWith(['https://example.com/1'], 5, undefined, undefined);
  });
});