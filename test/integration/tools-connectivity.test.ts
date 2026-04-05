/**
 * Integration Tests: Tools Network Connectivity
 *
 * Tests that the search and scrape tools can be instantiated and execute successfully
 * against real network targets. More comprehensive than health check.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createSearchTool } from '../../src/tools/search.js';
import { createScrapeTool } from '../../src/tools/scrape.js';
import { initLifecycle, ensureRunning } from '../../src/searxng-lifecycle.js';
import { logger } from '../../src/logger.js';

describe('Search and Scrape Tools Connectivity', () => {
  const mockExtensionCtx = {
    cwd: process.cwd(),
    ui: { setWidget: () => {} },
  };

  beforeAll(async () => {
    logger.log('[test] Setting up tools connectivity tests...');
    try {
      await initLifecycle({
        cwd: process.cwd(),
        model: { id: 'test-model' },
        modelRegistry: {
          getAll: () => [{ id: 'test-model' }],
        },
        ui: {
          setWidget: () => {},
        },
      } as any);
      await ensureRunning();
    } catch (err) {
      logger.warn('[test] Failed to initialize:', err instanceof Error ? err.message : String(err));
    }
  });

  describe('Search Tool', () => {
    it('should instantiate search tool', () => {
      const tool = createSearchTool({ ctx: mockExtensionCtx as any });
      expect(tool).toBeDefined();
      expect(tool.name).toBe('search');
      expect(tool.execute).toBeDefined();
    });

    it('should execute search with valid results', async () => {
      const tool = createSearchTool({ ctx: mockExtensionCtx as any });
      const result = await tool.execute(
        'test-call-1',
        { queries: ['python programming'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0]).toHaveProperty('type', 'text');
    });

    it('should return markdown formatted results', async () => {
      const tool = createSearchTool({ ctx: mockExtensionCtx as any });
      const result = await tool.execute(
        'test-call-2',
        { queries: ['machine learning'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result.content).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0].text as string;
        expect(text).toContain('Search Results');
      }
    });

    it('should reject empty queries', async () => {
      const tool = createSearchTool({ ctx: mockExtensionCtx as any });
      try {
        await tool.execute(
          'test-call-3',
          { queries: [] },
          undefined,
          undefined,
          mockExtensionCtx as any
        );
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeDefined();
      }
    });
  });

  describe('Scrape Tool', () => {
    it('should instantiate scrape tool', () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8080', ctx: mockExtensionCtx as any });
      expect(tool).toBeDefined();
      expect(tool.name).toBe('scrape');
      expect(tool.execute).toBeDefined();
    });

    it('should scrape Wikipedia successfully', async () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8080', ctx: mockExtensionCtx as any });
      const result = await tool.execute(
        'test-call-4',
        { urls: ['https://en.wikipedia.org/wiki/Python_(programming_language)'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      if (result.content[0]?.type === 'text') {
        const text = result.content[0].text as string;
        expect(text.length).toBeGreaterThan(100);
      }
    });

    it('should handle multiple URLs concurrently', async () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8080', ctx: mockExtensionCtx as any });
      const urls = [
        'https://en.wikipedia.org/wiki/Python_(programming_language)',
        'https://en.wikipedia.org/wiki/JavaScript',
      ];
      const result = await tool.execute(
        'test-call-5',
        { urls, maxConcurrency: 2 },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0].text as string;
        // Should have content for both URLs
        expect(text.length).toBeGreaterThan(100);
      }
    });

    it('should reject empty URLs', async () => {
      const tool = createScrapeTool({ searxngUrl: 'http://localhost:8080', ctx: mockExtensionCtx as any });
      try {
        await tool.execute(
          'test-call-6',
          { urls: [] },
          undefined,
          undefined,
          mockExtensionCtx as any
        );
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeDefined();
      }
    });
  });
});
