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
  const createMockTracker = () => new ToolUsageTracker({ scrape: 3 });
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
    it('should perform scrape on first call (Batch 1)', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.ts');
      vi.mocked(scrapeSingle).mockResolvedValue([{ url: 'http://test.com', source: 'fetch', markdown: 'content' }] as any);


      const options = createMockOptions();
      const tool = createScrapeTool(options);
      
      // First call is now Batch 1 (no handshake)
      const result = await tool.execute('test-id', { urls: ['http://test.com'] }, undefined, undefined, undefined as any);

      expect(scrapeSingle).toHaveBeenCalled();
      expect(options.updateGlobalLinks).toHaveBeenCalledWith(['http://test.com']);
      expect((result.content[0] as any).text).toContain('URL Scrape Results');
      expect((result.content[0] as any).text).toContain('Batch 1 of up to 3');
      expect(options.tracker.getCallCount('scrape')).toBe(1);
    });

    it('should update global state with provided URLs', async () => {
      const { scrape } = await import('../../../src/web-research/scrapers.ts');
      vi.mocked(scrape).mockResolvedValue([
        { url: 'http://t1.com', source: 'fetch', markdown: 'content' },
        { url: 'http://already.com', source: 'fetch', markdown: 'content' }
      ] as any);

      const options = createMockOptions();
      const tool = createScrapeTool(options);

      // Call 1: Batch 1 (no handshake)
      await tool.execute('1', { urls: ['http://t1.com', 'http://already.com'] }, undefined, undefined, undefined as any);

      expect(scrape).toHaveBeenCalled();
      expect(options.updateGlobalLinks).toHaveBeenCalledWith(['http://t1.com', 'http://already.com']);
    });

    it('should perform scrape on second call (Batch 2)', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.ts');
      vi.mocked(scrapeSingle).mockResolvedValue([{ url: 'http://test.com', source: 'fetch', markdown: 'content' }] as any);


      const options = createMockOptions();
      const tool = createScrapeTool(options);
      
      await tool.execute('test-id', { urls: ['http://test1.com'] }, undefined, undefined, undefined as any); // 1: batch 1
      const result = await tool.execute('test-id', { urls: ['http://test2.com'] }, undefined, undefined, undefined as any); // 2: batch 2

      expect(scrapeSingle).toHaveBeenCalled();
      expect((result.content[0] as any).text).toContain('URL Scrape Results (Batch 2)');
    });

    it('should lock out on fourth call (after all 3 batches used)', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.ts');
      vi.mocked(scrapeSingle).mockResolvedValue([{ url: 'http://test.com', source: 'fetch', markdown: 'content' }] as any);


      const options = createMockOptions(); // tracker limit = 3
      const tool = createScrapeTool(options);

      await tool.execute('1', { urls: ['http://t.com'] }, undefined, undefined, undefined as any);          // 1: batch 1
      await tool.execute('2', { urls: ['http://t2.com'] }, undefined, undefined, undefined as any);         // 2: batch 2
      await tool.execute('3', { urls: ['http://t3.com'] }, undefined, undefined, undefined as any);         // 3: batch 3
      const result = await tool.execute('4', { urls: ['http://t.com'] }, undefined, undefined, undefined as any); // 4: locked

      expect((result.details as any).locked).toBe(true);
    });

    it('should return locked message on fourth call when tracker limit is 3', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.ts');
      vi.mocked(scrapeSingle).mockResolvedValue([{ url: 'http://test.com', source: 'fetch', markdown: 'content' }] as any);


      const options = createMockOptions(new ToolUsageTracker({ scrape: 3 }));
      const tool = createScrapeTool(options);

      await tool.execute('1', { urls: ['http://t.com'] }, undefined, undefined, undefined as any);          // 1: batch 1
      await tool.execute('2', { urls: ['http://t2.com'] }, undefined, undefined, undefined as any);         // 2: batch 2
      await tool.execute('3', { urls: ['http://t3.com'] }, undefined, undefined, undefined as any);         // 3: batch 3
      
      // 4th call should return locked message (all batches used)
      const result = await tool.execute('4', { urls: ['http://t.com'] }, undefined, undefined, undefined as any);
      expect((result.details as any).locked).toBe(true);
      expect((result.content[0] as any).text).toContain('All scrape batches have been used');
    });
  });
});
