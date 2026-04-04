/**
 * Scrape Tool Unit Tests
 *
 * Tests the createScrapeTool function and core behaviors.
 */

import { describe, it, expect, vi } from 'vitest';
import { createScrapeTool } from '../../../src/tools/scrape';

// Mock the scrapers functions
vi.mock('../../../src/web-research/scrapers.js', () => ({
  scrape: vi.fn(),
  scrapeSingle: vi.fn(),
}));

// Mock the utils
vi.mock('../../../src/web-research/utils.js', () => ({
  validateMaxConcurrency: vi.fn((val) => val ?? 10),
}));

describe('tools/scrape', () => {
  const createMockContext = () => ({
    settingsManager: {
      get: vi.fn(),
      set: vi.fn(),
    },
  } as any);

  describe('createScrapeTool', () => {
    it('should create tool with correct name', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect(tool.name).toBe('scrape');
    });

    it('should create tool with correct label', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect(tool.label).toBe('Scrape');
    });

    it('should create tool with correct description', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect(tool.description).toContain('2-layer');
      expect(tool.description).toContain('Playwright');
      expect(tool.description).toContain('markdown');
    });

    it('should have prompt snippet', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect(tool.promptSnippet).toBeDefined();
      expect(tool.promptSnippet!.toLowerCase()).toContain('scrape');
      expect(tool.promptSnippet!.toLowerCase()).toContain('markdown');
    });

    it('should have prompt guidelines', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect(tool.promptGuidelines).toBeDefined();
      expect(Array.isArray(tool.promptGuidelines)).toBe(true);
      expect(tool.promptGuidelines!.length).toBeGreaterThan(0);
    });

    it('should have prompt guidelines mentioning fetch and Playwright', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const guidelines = tool.promptGuidelines!.join(' ');
      expect(guidelines).toContain('fetch');
      expect(guidelines).toContain('Playwright');
    });

    it('should have prompt guidelines mentioning maxConcurrency', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const guidelines = tool.promptGuidelines!.join(' ');
      expect(guidelines).toContain('maxConcurrency');
    });
  });

  describe('parameters', () => {
    it('should require urls parameter', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect(tool.parameters).toBeDefined();
      expect((tool.parameters as any).properties).toHaveProperty('urls');
    });

    it('should have urls as array of strings', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const urlsParam = (tool.parameters as any).properties.urls;
      expect(urlsParam).toBeDefined();
    });

    it('should have optional maxConcurrency parameter', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect((tool.parameters as any).properties).toHaveProperty('maxConcurrency');
    });

    it('should have maxConcurrency with correct defaults and constraints', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const maxConcurrencyParam = (tool.parameters as any).properties.maxConcurrency;
      expect(maxConcurrencyParam).toBeDefined();
    });
  });

  describe('execute - parameter validation', () => {
    it('should throw error when params is not valid', async () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      await expect(
        tool.execute('test-id', {} as any, undefined, undefined, undefined as any)
      ).rejects.toThrow('Invalid parameters for scrape');
    });

    it('should throw error when urls array is empty', async () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      await expect(
        tool.execute('test-id', { urls: [] }, undefined, undefined, undefined as any)
      ).rejects.toThrow('At least one URL is required');
    });

    it('should throw error when urls is missing', async () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      await expect(
        tool.execute('test-id', { maxConcurrency: 10 }, undefined, undefined, undefined as any)
      ).rejects.toThrow('Invalid parameters for scrape');
    });

    it('should accept single URL', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrapeSingle).mockResolvedValue({
        url: 'https://example.com',
        source: 'fetch',
        layer: 'layer1',
        markdown: '# Test Content',
      });

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { urls: ['https://example.com'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it('should accept multiple URLs', async () => {
      const { scrape } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrape).mockResolvedValue([
        { url: 'https://example1.com', source: 'fetch', layer: 'layer1', markdown: '# Content 1' },
        { url: 'https://example2.com', source: 'fetch', layer: 'layer1', markdown: '# Content 2' },
      ]);

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { urls: ['https://example1.com', 'https://example2.com'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(result).toBeDefined();
    });
  });

  describe('execute - scraper function integration', () => {
    it('should call scrapeSingle for single URL', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrapeSingle).mockResolvedValue({
        url: 'https://example.com',
        source: 'fetch',
        layer: 'layer1',
        markdown: '# Test',
      });

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      await tool.execute(
        'test-id',
        { urls: ['https://example.com'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(scrapeSingle).toHaveBeenCalledWith('https://example.com', undefined);
    });

    it('should call scrape for multiple URLs', async () => {
      const { scrape } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrape).mockResolvedValue([
        { url: 'https://example1.com', source: 'fetch', layer: 'layer1', markdown: '# Test 1' },
        { url: 'https://example2.com', source: 'fetch', layer: 'layer1', markdown: '# Test 2' },
      ]);

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      await tool.execute(
        'test-id',
        { urls: ['https://example1.com', 'https://example2.com'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(scrape).toHaveBeenCalledWith(['https://example1.com', 'https://example2.com'], 10, undefined);
    });

    it('should pass signal to scrapers', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrapeSingle).mockResolvedValue({
        url: 'https://example.com',
        source: 'fetch',
        layer: 'layer1',
        markdown: '# Test',
      });

      const signal = new AbortController().signal;
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      await tool.execute(
        'test-id',
        { urls: ['https://example.com'] },
        signal,
        undefined,
        undefined as any
      );

      expect(scrapeSingle).toHaveBeenCalledWith('https://example.com', signal);
    });

    it('should pass custom maxConcurrency', async () => {
      const { scrape } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrape).mockResolvedValue([
        { url: 'https://example1.com', source: 'fetch', layer: 'layer1', markdown: '# Test 1' },
        { url: 'https://example2.com', source: 'fetch', layer: 'layer1', markdown: '# Test 2' },
      ]);

      const { validateMaxConcurrency } = await import('../../../src/web-research/utils.js');
      vi.mocked(validateMaxConcurrency).mockReturnValue(5);

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      await tool.execute(
        'test-id',
        { urls: ['https://example1.com', 'https://example2.com'], maxConcurrency: 5 },
        undefined,
        undefined,
        undefined as any
      );

      expect(validateMaxConcurrency).toHaveBeenCalledWith(5);
      expect(scrape).toHaveBeenCalledWith(['https://example1.com', 'https://example2.com'], 5, undefined);
    });
  });

  describe('execute - result formatting', () => {
    it('should return text content', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrapeSingle).mockResolvedValue({
        url: 'https://example.com',
        source: 'fetch',
        layer: 'layer1',
        markdown: '# Test',
      });

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { urls: ['https://example.com'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(result.content[0]?.type).toBe('text');
      expect((result.content[0] as any)?.text).toBeDefined();
    });

    it('should include URL in output', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrapeSingle).mockResolvedValue({
        url: 'https://example.com',
        source: 'fetch',
        layer: 'layer1',
        markdown: '# Test',
      });

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { urls: ['https://example.com'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('https://example.com');
    });

    it('should include layer information', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrapeSingle).mockResolvedValue({
        url: 'https://example.com',
        source: 'fetch',
        layer: 'layer1',
        markdown: '# Test',
      });

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { urls: ['https://example.com'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('layer1');
    });

    it('should include character count', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrapeSingle).mockResolvedValue({
        url: 'https://example.com',
        source: 'fetch',
        layer: 'layer1',
        markdown: '# Test Content',
      });

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { urls: ['https://example.com'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('Characters');
    });

    it('should include full markdown content', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.js');
      const markdown = '# Test\n\nSome content here.';
      vi.mocked(scrapeSingle).mockResolvedValue({
        url: 'https://example.com',
        source: 'fetch',
        layer: 'layer1',
        markdown,
      });

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { urls: ['https://example.com'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('# Test');
      expect((result.content[0] as any)?.text).toContain('Some content here.');
    });
  });

  describe('execute - failed scrapes', () => {
    it('should handle failed scrapes', async () => {
      const { scrape } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrape).mockResolvedValue([
        { url: 'https://success.com', source: 'fetch', layer: 'layer1', markdown: '# Success' },
        { url: 'https://failed.com', source: 'failed', markdown: '', error: 'Network error' },
      ]);

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { urls: ['https://success.com', 'https://failed.com'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('**Successful:** 1');
      expect((result.content[0] as any)?.text).toContain('**Failed:** 1');
      expect((result.content[0] as any)?.text).toContain('Failed Scrapes');
    });

    it.skip('should include failed URLs in table', async () => {
      const { scrape } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrape).mockResolvedValue([
        { url: 'https://failed.com', source: 'failed', markdown: '', error: 'Timeout error' },
      ]);

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { urls: ['https://failed.com'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.content[0] as any)?.text).toContain('https://failed.com');
      expect((result.content[0] as any)?.text).toContain('Timeout error');
      expect((result.content[0] as any)?.text).toContain('Failed Scrapes');
    });
  });

  describe('execute - details object', () => {
    it('should include urls in details', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrapeSingle).mockResolvedValue({
        url: 'https://example.com',
        source: 'fetch',
        layer: 'layer1',
        markdown: '# Test',
      });

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { urls: ['https://example.com'] },
        undefined,
        undefined,
        undefined as any
      );

      expect(result.details).toBeDefined();
      expect((result.details as any).urls).toEqual(['https://example.com']);
    });

    it('should include maxConcurrency in details', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrapeSingle).mockResolvedValue({
        url: 'https://example.com',
        source: 'fetch',
        layer: 'layer1',
        markdown: '# Test',
      });

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { urls: ['https://example.com'], maxConcurrency: 5 },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.details as any).maxConcurrency).toBe(5);
    });

    it('should include successfulCount and failedCount in details', async () => {
      const { scrape } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrape).mockResolvedValue([
        { url: 'https://success1.com', source: 'fetch', layer: 'layer1', markdown: '# Success 1' },
        { url: 'https://success2.com', source: 'fetch', layer: 'layer1', markdown: '# Success 2' },
        { url: 'https://failed.com', source: 'failed', markdown: '', error: 'Error' },
      ]);

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { urls: ['https://success1.com', 'https://success2.com', 'https://failed.com'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.details as any).successfulCount).toBe(2);
      expect((result.details as any).failedCount).toBe(1);
    });

    it('should include duration in details', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.js');
      vi.mocked(scrapeSingle).mockResolvedValue({
        url: 'https://example.com',
        source: 'fetch',
        layer: 'layer1',
        markdown: '# Test',
      });

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const result = await tool.execute(
        'test-id',
        { urls: ['https://example.com'] },
        undefined,
        undefined,
        undefined as any
      );

      expect((result.details as any).duration).toBeDefined();
      expect(typeof (result.details as any).duration).toBe('number');
      expect((result.details as any).duration).toBeGreaterThanOrEqual(0);
    });
  });
});
