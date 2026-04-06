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
  const createMockTracker = () => new ToolUsageTracker({ scrape: 1 });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('should create tool with correct metadata', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext(), tracker: createMockTracker() });
      expect(tool.name).toBe('scrape');
      expect(tool.label).toBe('Scrape');
    });
  });

  describe('execute - tracker', () => {
    it('should record call in tracker', async () => {
      const { scrapeSingle } = await import('../../../src/web-research/scrapers.ts');
      vi.mocked(scrapeSingle).mockResolvedValue({ url: 'http://test.com', source: 'fetch', markdown: 'content' });

      const tracker = createMockTracker();
      const spy = vi.spyOn(tracker, 'recordCall');
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext(), tracker });
      
      await tool.execute('test-id', { urls: ['http://test.com'] }, undefined, undefined, undefined as any);

      expect(spy).toHaveBeenCalledWith('scrape');
    });

    it('should return blocked response if limit exceeded', async () => {
      const tracker = new ToolUsageTracker({ scrape: 1 });
      tracker.recordCall('scrape'); // Limit reached

      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8888', ctx: createMockContext(), tracker });

      const result = await tool.execute('test-id', { urls: ['http://test.com'] }, undefined, undefined, undefined as any);

      expect((result.details as any).blocked).toBe(true);
      expect((result.content[0] as any).text).toContain('SCRAPE LIMIT REACHED');
    });
  });
});
