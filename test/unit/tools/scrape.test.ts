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

  describe('Tool Definition', () => {
    it('should create tool with correct metadata and guidelines', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });

      // Metadata
      expect(tool.name).toBe('scrape');
      expect(tool.label).toBe('Scrape');
      expect(tool.description).toContain('2-layer');
      expect(tool.description).toContain('Playwright');
      expect(tool.description).toContain('markdown');

      // Prompt snippet
      expect(tool.promptSnippet).toBeDefined();
      expect(tool.promptSnippet!.toLowerCase()).toContain('scrape');
      expect(tool.promptSnippet!.toLowerCase()).toContain('markdown');

      // Guidelines
      expect(Array.isArray(tool.promptGuidelines)).toBe(true);
      expect(tool.promptGuidelines!.length).toBeGreaterThan(0);
      const guidelines = tool.promptGuidelines!.join(' ');
      expect(guidelines).toContain('fetch');
      expect(guidelines).toContain('Playwright');
      expect(guidelines).toContain('maxConcurrency');
    });

    it('should have execute function', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      expect(typeof tool.execute).toBe('function');
    });
  });

  describe('Parameters', () => {
    it('should have urls and maxConcurrency parameters properly defined', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext() });
      const props = (tool.parameters as any).properties;

      expect(props).toHaveProperty('urls');
      expect(props).toHaveProperty('maxConcurrency');
      expect(props.urls).toBeDefined();
      expect(props.maxConcurrency).toBeDefined();
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
    it('should format results with URL, layer info, and markdown content', async () => {
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
      const text = (result.content[0] as any)?.text;
      expect(text).toBeDefined();
      expect(text).toContain('https://example.com');
      expect(text).toContain('layer1');
      expect(text).toContain('# Test');
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
