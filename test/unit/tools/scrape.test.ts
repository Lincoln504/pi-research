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
  const createMockTracker = () => new ToolUsageTracker({ scrape: 4 });
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

    it('should perform scrape on second call (Batch 1)', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.ts');
      vi.mocked(scrapeSingle).mockResolvedValue({ url: 'http://test.com', source: 'fetch', markdown: 'content' });

      const options = createMockOptions();
      const tool = createScrapeTool(options);
      
      // First call (handshake)
      await tool.execute('test-id', { urls: ['http://test.com'] }, undefined, undefined, undefined as any);
      
      // Second call (Batch 1)
      const result = await tool.execute('test-id', { urls: ['http://test.com'] }, undefined, undefined, undefined as any);

      expect(scrapeSingle).toHaveBeenCalled();
      expect(options.updateGlobalLinks).toHaveBeenCalledWith(['http://test.com']);
      expect((result.content[0] as any).text).toContain('URL Scrape Results');
      expect((result.content[0] as any).text).toContain('Batch 1 of up to 3');
    });

    it('should perform scrape on third call (Batch 2)', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.ts');
      vi.mocked(scrapeSingle).mockResolvedValue({ url: 'http://test2.com', source: 'fetch', markdown: 'content' });

      const options = createMockOptions();
      const tool = createScrapeTool(options);
      
      await tool.execute('test-id', { urls: ['http://test1.com'] }, undefined, undefined, undefined as any); // 1: handshake
      await tool.execute('test-id', { urls: ['http://test1.com'] }, undefined, undefined, undefined as any); // 2: batch 1
      const result = await tool.execute('test-id', { urls: ['http://test2.com'] }, undefined, undefined, undefined as any); // 3: batch 2

      expect(scrapeSingle).toHaveBeenCalled();
      expect((result.content[0] as any).text).toContain('URL Scrape Results (Batch 2)');
    });

    it('should lock out on fifth call (after all 4 calls used)', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.ts');
      vi.mocked(scrapeSingle).mockResolvedValue({ url: 'http://t.com', source: 'fetch', markdown: 'ok' });

      const options = createMockOptions(); // tracker limit = 4
      const tool = createScrapeTool(options);

      await tool.execute('1', { urls: ['http://t.com'] }, undefined, undefined, undefined as any);          // 1: handshake
      await tool.execute('2', { urls: ['http://t.com'] }, undefined, undefined, undefined as any);          // 2: batch 1
      await tool.execute('3', { urls: ['http://t2.com'] }, undefined, undefined, undefined as any);         // 3: batch 2
      await tool.execute('4', { urls: ['http://t3.com'] }, undefined, undefined, undefined as any);         // 4: batch 3
      const result = await tool.execute('5', { urls: ['http://t.com'] }, undefined, undefined, undefined as any); // 5: locked

      expect((result.details as any).locked).toBe(true);
    });

    it('should lock out on fourth call when tracker limit is 3', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.ts');
      vi.mocked(scrapeSingle).mockResolvedValue({ url: 'http://t.com', source: 'fetch', markdown: 'ok' });

      const options = createMockOptions(new ToolUsageTracker({ scrape: 3 }));
      const tool = createScrapeTool(options);

      await tool.execute('1', { urls: ['http://t.com'] }, undefined, undefined, undefined as any);          // 1: handshake
      await tool.execute('2', { urls: ['http://t.com'] }, undefined, undefined, undefined as any);          // 2: batch 1
      await tool.execute('3', { urls: ['http://t2.com'] }, undefined, undefined, undefined as any);         // 3: batch 2
      const result = await tool.execute('4', { urls: ['http://t.com'] }, undefined, undefined, undefined as any); // 4: tracker blocks

      // Tracker limit of 3 means batch 3 is blocked before executing
      expect((result.details as any).blocked).toBe(true);
    });
  });
});
