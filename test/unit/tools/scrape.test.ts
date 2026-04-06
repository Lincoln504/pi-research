/**
 * Scrape Tool Unit Tests
 *
 * Tests the createScrapeTool function and core behaviors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScrapeTool } from '../../../src/tools/scrape';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker';

// Mock scrapers
vi.mock('../../../src/web-research/scrapers.ts', () => ({
  scrape: vi.fn(),
  scrapeSingle: vi.fn(),
}));

describe('tools/scrape', () => {
  const createMockContext = () => ({} as any);
  const createMockTracker = () => new ToolUsageTracker({ scrape: 2 });
  const createMockOptions = (tracker = createMockTracker()) => ({
    searxngUrl: 'http://localhost:8888',
    ctx: createMockContext(),
    tracker,
    getGlobalState: vi.fn(() => ({ allScrapedLinks: [] } as any)),
    updateGlobalLinks: vi.fn(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('should create tool with correct metadata', () => {
      const tool = createScrapeTool(createMockOptions());
      expect(tool.name).toBe('scrape');
      expect(tool.label).toBe('Scrape');
    });
  });

  describe('execute - protocol', () => {
    it('should return handshake on first call', async () => {
      const options = createMockOptions();
      const tool = createScrapeTool(options);
      
      const result = await tool.execute('test-id', { urls: ['http://test.com'] }, undefined, undefined, undefined as any);

      expect((result.details as any).protocol).toBe('handshake');
      expect((result.content[0] as any).text).toContain('Call 1 (Handshake)');
      expect(options.tracker.getCallCount('scrape')).toBe(1);
    });

    it('should perform scrape on second call', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.ts');
      vi.mocked(scrapeSingle).mockResolvedValue({ url: 'http://test.com', source: 'fetch', markdown: 'content' });

      const options = createMockOptions();
      const tool = createScrapeTool(options);
      
      // First call (handshake)
      await tool.execute('test-id', { urls: ['http://test.com'] }, undefined, undefined, undefined as any);
      
      // Second call (execution)
      const result = await tool.execute('test-id', { urls: ['http://test.com'] }, undefined, undefined, undefined as any);

      expect(scrapeSingle).toHaveBeenCalled();
      expect(options.updateGlobalLinks).toHaveBeenCalledWith(['http://test.com']);
      expect((result.content[0] as any).text).toContain('URL Scrape Results');
    });

    it('should lock out on third call', async () => {
      const options = createMockOptions();
      const tool = createScrapeTool(options);
      
      await tool.execute('1', { urls: ['http://t.com'] }, undefined, undefined, undefined as any); // 1
      await tool.execute('2', { urls: ['http://t.com'] }, undefined, undefined, undefined as any); // 2
      const result = await tool.execute('3', { urls: ['http://t.com'] }, undefined, undefined, undefined as any); // 3

      expect((result.details as any).locked).toBe(true);
    });
  });
});
