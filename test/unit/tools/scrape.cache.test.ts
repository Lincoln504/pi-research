/**
 * Scrape Cache Integration Tests
 *
 * Tests the cache bypass behavior when cached content is available
 * in the knowledge store. Tests various cache hit/miss scenarios,
 * error handling, and interaction with different ingestion types.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScrapeTool } from '../../../src/tools/scrape.ts';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker.ts';

import { getService } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';

vi.mock('../../../src/core/service-registry.ts', () => ({
  getService: vi.fn(),
}));

vi.mock('../../../src/web-research/scrapers.ts', () => ({
  scrape: vi.fn(async (urls) => 
    urls.map((url: string) => ({ url, success: true, markdown: 'fresh content for ' + url, source: 'fetch' }))
  ),
}));

vi.mock('../../../src/knowledge/index.ts', () => ({
  isKnowledgeStoreReady: vi.fn(),
  initKnowledgeStore: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({
    MAX_SCRAPE_BATCHES: 2,
    KNOWLEDGE_STORE_ENABLED: true,
  })),
  DEFAULTS: {
    KNOWLEDGE_STORE_ENABLED: true,
  },
}));

describe('tools/scrape cache integration', () => {
  let tracker: ToolUsageTracker;
  const mockOptions = {
    ctx: {} as any,
    getGlobalState: () => ({ researchId: 'test-res-id' } as any),
    updateGlobalLinks: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = new ToolUsageTracker({ scrape: 10 });
  });

  describe('cache hit scenarios', () => {
    it('bypasses fetch and returns cached content when rebuildDocument has content', async () => {
      const { isKnowledgeStoreReady } = await import('../../../src/knowledge/index.ts');
      const { scrape } = await import('../../../src/web-research/scrapers.ts');

      vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
      const rebuildDocumentMock = vi.fn().mockImplementation(async (url) => {
        if (url.includes('example.com')) {
          return {
            text: 'cached full page content',
            metadata: { ingestionType: 'synthesis-description' },
          };
        }
        return null;
      });
      vi.mocked(getService).mockImplementation((name) => {
        if (name === ServiceNames.KNOWLEDGE_STORE) {
          return { rebuildDocument: rebuildDocumentMock } as any;
        }
        return null;
      });

      const tool = createScrapeTool({ ...mockOptions, tracker });
      const result = await tool.execute('call-1', { urls: ['https://example.com'] }, undefined, () => {}, {} as any);

      expect(scrape).not.toHaveBeenCalled();
      const textContent = result.content[0].text;
      expect(textContent).toContain('cached full page content');
      expect(textContent).toContain('**Successful:** 1');
    });

    it('handles cached content with raw-content ingestion type', async () => {
      const { isKnowledgeStoreReady } = await import('../../../src/knowledge/index.ts');
      const { scrape } = await import('../../../src/web-research/scrapers.ts');

      vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
      const rebuildDocumentMock = vi.fn().mockResolvedValue({
        text: 'raw cached content',
        metadata: { ingestionType: 'raw-content' },
      });
      vi.mocked(getService).mockImplementation((name) => {
        if (name === ServiceNames.KNOWLEDGE_STORE) {
          return { rebuildDocument: rebuildDocumentMock } as any;
        }
        return null;
      });

      const tool = createScrapeTool({ ...mockOptions, tracker });
      const result = await tool.execute('call-1', { urls: ['https://raw.example.com'] }, undefined, () => {}, {} as any);

      expect(scrape).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('raw cached content');
    });

    it('handles mixed cache hits and misses in same batch', async () => {
      const { isKnowledgeStoreReady } = await import('../../../src/knowledge/index.ts');
      const { scrape } = await import('../../../src/web-research/scrapers.ts');

      vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
      const rebuildDocumentMock = vi.fn().mockImplementation(async (url) => {
        // Check normalized URL - URLs are normalized before being passed to rebuildDocument
        if (url === 'https://cached.example.com') {
          return {
            text: 'cached content',
            metadata: { ingestionType: 'synthesis-description' },
          };
        }
        return null;
      });
      vi.mocked(getService).mockImplementation((name) => {
        if (name === ServiceNames.KNOWLEDGE_STORE) {
          return { rebuildDocument: rebuildDocumentMock } as any;
        }
        return null;
      });

      const tool = createScrapeTool({ ...mockOptions, tracker });
      const result = await tool.execute('call-1', { urls: ['https://cached.example.com', 'https://uncached.example.com'] }, undefined, () => {}, {} as any);

      // Scrape should only be called for the uncached URL
      expect(scrape).toHaveBeenCalledTimes(1);
      expect(vi.mocked(scrape).mock.calls[0][0]).toEqual(['https://uncached.example.com']);
      expect(result.content[0].text).toContain('cached content');
      expect(result.content[0].text).toContain('fresh content');
    });
  });

  describe('cache miss scenarios', () => {
    it('fetches fresh content when rebuildDocument returns null', async () => {
      const { isKnowledgeStoreReady } = await import('../../../src/knowledge/index.ts');
      const { scrape } = await import('../../../src/web-research/scrapers.ts');

      vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
      vi.mocked(getService).mockImplementation((name) => {
        if (name === ServiceNames.KNOWLEDGE_STORE) {
          return { rebuildDocument: vi.fn().mockResolvedValue(null) } as any;
        }
        return null;
      });

      const tool = createScrapeTool({ ...mockOptions, tracker });
      const result = await tool.execute('call-1', { urls: ['https://example.com'] }, undefined, () => {}, {} as any);

      expect(scrape).toHaveBeenCalledTimes(1);
      const textContent = result.content[0].text;
      expect(textContent).toContain('fresh content for https://example.com');
    });

    it('fetches fresh content when knowledge store is not ready', async () => {
      const { isKnowledgeStoreReady } = await import('../../../src/knowledge/index.ts');
      const { scrape } = await import('../../../src/web-research/scrapers.ts');

      vi.mocked(isKnowledgeStoreReady).mockReturnValue(false);

      const tool = createScrapeTool({ ...mockOptions, tracker });
      const result = await tool.execute('call-1', { urls: ['https://example.com'] }, undefined, () => {}, {} as any);

      expect(scrape).toHaveBeenCalledTimes(1);
      // getStore IS called even when not ready (it's inside the try/catch)
      expect(result.content[0].text).toContain('fresh content');
    });

    it('fetches fresh content when knowledge store is disabled', async () => {
      const { getConfig } = await import('../../../src/config.ts');
      const { scrape } = await import('../../../src/web-research/scrapers.ts');

      vi.mocked(getConfig).mockReturnValue({
        MAX_SCRAPE_BATCHES: 2,
        KNOWLEDGE_STORE_ENABLED: false,
      });

      const tool = createScrapeTool({ ...mockOptions, tracker });
      const result = await tool.execute('call-1', { urls: ['https://example.com'] }, undefined, () => {}, {} as any);

      expect(scrape).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain('fresh content');
    });
  });

  describe('error handling', () => {
    it('handles rebuildDocument errors gracefully', async () => {
      const { isKnowledgeStoreReady } = await import('../../../src/knowledge/index.ts');
      const { scrape } = await import('../../../src/web-research/scrapers.ts');

      vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
      const rebuildDocumentMock = vi.fn().mockRejectedValue(new Error('Store error'));
      vi.mocked(getService).mockImplementation((name) => {
        if (name === ServiceNames.KNOWLEDGE_STORE) {
          return { rebuildDocument: rebuildDocumentMock } as any;
        }
        return null;
      });

      const tool = createScrapeTool({ ...mockOptions, tracker });
      const result = await tool.execute('call-1', { urls: ['https://example.com'] }, undefined, () => {}, {} as any);

      // Should fall back to fetch on error
      expect(scrape).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain('fresh content');
    });

    it('handles rebuildDocument returning null (cache miss)', async () => {
      const { isKnowledgeStoreReady } = await import('../../../src/knowledge/index.ts');
      const { scrape } = await import('../../../src/web-research/scrapers.ts');

      vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
      const rebuildDocumentMock = vi.fn().mockResolvedValue(null);
      vi.mocked(getService).mockImplementation((name) => {
        if (name === ServiceNames.KNOWLEDGE_STORE) {
          return { rebuildDocument: rebuildDocumentMock } as any;
        }
        return null;
      });

      const tool = createScrapeTool({ ...mockOptions, tracker });
      const result = await tool.execute('call-1', { urls: ['https://example.com'] }, undefined, () => {}, {} as any);

      // When rebuildDocument returns null, it's a cache miss, so scrape is called
      expect(scrape).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain('fresh content');
    });

    it('handles getStore throwing an error', async () => {
      const { isKnowledgeStoreReady } = await import('../../../src/knowledge/index.ts');
      const { scrape } = await import('../../../src/web-research/scrapers.ts');

      vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
      vi.mocked(getService).mockImplementation((name) => {
        if (name === ServiceNames.KNOWLEDGE_STORE) {
          throw new Error('Store not available');
        }
        return null;
      });

      const tool = createScrapeTool({ ...mockOptions, tracker });
      const result = await tool.execute('call-1', { urls: ['https://example.com'] }, undefined, () => {}, {} as any);

      // Should fall back to fetch when store is unavailable
      expect(scrape).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain('fresh content');
    });
  });

  describe('concurrent access', () => {
    it('handles multiple concurrent cache lookups', async () => {
      const { isKnowledgeStoreReady } = await import('../../../src/knowledge/index.ts');
      const { scrape } = await import('../../../src/web-research/scrapers.ts');

      vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
      const rebuildDocumentMock = vi.fn().mockImplementation(async (url) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        if (url === 'https://cached.example.com') {
          return {
            text: 'cached content',
            metadata: { ingestionType: 'synthesis-description' },
          };
        }
        return null;
      });
      vi.mocked(getService).mockImplementation((name) => {
        if (name === ServiceNames.KNOWLEDGE_STORE) {
          return { rebuildDocument: rebuildDocumentMock } as any;
        }
        return null;
      });

      const tool = createScrapeTool({ ...mockOptions, tracker });
      const [result1, result2, result3] = await Promise.all([
        tool.execute('call-1', { urls: ['https://cached.example.com'] }, undefined, () => {}, {} as any),
        tool.execute('call-2', { urls: ['https://cached.example.com'] }, undefined, () => {}, {} as any),
        tool.execute('call-3', { urls: ['https://uncached.example.com'] }, undefined, () => {}, {} as any),
      ]);

      // Each tool execution is independent, so:
      // - The two cached URLs won't trigger scrape (cache hit)
      // - The uncached URL will trigger scrape
      expect(scrape).toHaveBeenCalledTimes(1);
      expect(result1.content[0].text).toContain('cached content');
      expect(result2.content[0].text).toContain('cached content');
      expect(result3.content[0].text).toContain('fresh content');
    });
  });

  describe('cache behavior with different ingestion types', () => {
    it('uses cached content regardless of ingestion type', async () => {
      const { isKnowledgeStoreReady } = await import('../../../src/knowledge/index.ts');
      const { scrape } = await import('../../../src/web-research/scrapers.ts');

      vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
      const rebuildDocumentMock = vi.fn().mockResolvedValue({
        text: 'cached content with any type',
        metadata: { ingestionType: 'any-type' },
      });
      vi.mocked(getService).mockImplementation((name) => {
        if (name === ServiceNames.KNOWLEDGE_STORE) {
          return { rebuildDocument: rebuildDocumentMock } as any;
        }
        return null;
      });

      const tool = createScrapeTool({ ...mockOptions, tracker });
      await tool.execute('call-1', { urls: ['https://example.com'] }, undefined, () => {}, {} as any);

      // rebuildDocument is called and returns content, so scrape is not called
      expect(scrape).not.toHaveBeenCalled();
      expect(rebuildDocumentMock).toHaveBeenCalled();
    });
  });

  describe('integration with global deduplication', () => {
    it('works correctly when global links are being tracked', async () => {
      const { isKnowledgeStoreReady } = await import('../../../src/knowledge/index.ts');
      const { scrape } = await import('../../../src/web-research/scrapers.ts');

      vi.mocked(isKnowledgeStoreReady).mockReturnValue(true);
      vi.mocked(getService).mockImplementation((name) => {
        if (name === ServiceNames.KNOWLEDGE_STORE) {
          return { rebuildDocument: vi.fn().mockResolvedValue(null) } as any;
        }
        return null;
      });

      const mockUpdateLinks = vi.fn();
      const tool = createScrapeTool({ 
        ...mockOptions, 
        tracker,
        updateGlobalLinks: mockUpdateLinks,
      });
      
      await tool.execute('call-1', { urls: ['https://example.com'] }, undefined, () => {}, {} as any);

      // Should still fetch and update links
      expect(scrape).toHaveBeenCalledTimes(1);
      expect(mockUpdateLinks).toHaveBeenCalled();
    });
  });
});
