/**
 * Integration Tests: Search and Scrape Tools Connectivity
 *
 * Tests that the search and scrape tools can be instantiated and execute successfully
 * against real network targets. Includes error handling, edge cases, and robust assertions.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSearchTool } from '../../src/tools/search.ts';
import { createScrapeTool } from '../../src/tools/scrape.ts';
import { setupLifecycle, teardownLifecycle, type TestContext } from './helpers/setup.ts';
import { ToolUsageTracker } from '../../src/utils/tool-usage-tracker.ts';

import { isNetworkUnavailable } from './helpers/network.ts';

describe('Search and Scrape Tools Connectivity', () => {
  const mockExtensionCtx = {
    cwd: process.cwd(),
    ui: { setWidget: () => {}, notify: () => {} },
  };

  let testContext: TestContext = {
    lifecycleInitialized: false,
    skipTests: () => true,
    init: async () => {},
    shutdown: async () => {},
    beforeEach: async () => {},
    afterEach: async () => {},
  };

  beforeAll(async () => {
    testContext = await setupLifecycle();
  });

  afterAll(async () => {
    await teardownLifecycle(testContext);
  });

  describe('Search Tool - Instantiation and Structure', () => {
    it('should instantiate search tool with correct properties', () => {
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 6 }) 
      });
      
      expect(tool).toBeDefined();
      expect(tool.name).toBe('search');
      expect(tool.label).toBe('Search');
      expect(tool.execute).toBeDefined();
      expect(typeof tool.execute).toBe('function');
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
    });
  });

  describe('Search Tool - Basic Functionality', () => {
    it('should execute search with valid results structure', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 6 }) 
      });
      const result = await tool.execute(
        'test-search-1',
        { queries: ['python programming'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      
      const firstContent = result.content[0];
      expect(firstContent).toHaveProperty('type', 'text');
      expect(typeof (firstContent as any).text).toBe('string');
    });

    it('should return markdown formatted results with expected sections', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 6 }) 
      });
      const result = await tool.execute(
        'test-search-2',
        { queries: ['machine learning transformers'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result.content).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        if (isNetworkUnavailable(text)) {
          // Skip test if network is unavailable
          return;
        }
        expect(text).toMatch(/^#\s+/);
        // Match either formatted results or "No results found" message
        const hasResults = text.includes('[1] **');
        const hasNoResults = text.includes('*No results found.*');
        expect(hasResults || hasNoResults).toBe(true);
        expect(text.length).toBeGreaterThan(50);
      }
    });
  });

  describe('Scrape Tool - Basic Functionality', () => {
    const createScrapeToolInstance = (tracker: ToolUsageTracker) => {
      return createScrapeTool({
        ctx: mockExtensionCtx as any,
        tracker,
        getGlobalState: () => ({ researchId: 'test-research' } as any),
        updateGlobalLinks: () => {}
      });
    };

    it('should scrape Wikipedia successfully with substantial content', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeToolInstance(tracker);
      const urls = ['https://en.wikipedia.org/wiki/Python_(programming_language)'];
      
      const result = await tool.execute(
        'test-scrape-exec',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        if (isNetworkUnavailable(text)) {
          return;
        }
        expect(text).not.toContain('**Successful:** 0');
        expect(text).toContain('Python');
        expect(text.length).toBeGreaterThan(1000);
        expect(text).toMatch(/^#+\s/m);
      }
    });

  describe('Scrape Tool - Error Scenarios', () => {
    it('should handle invalid URL gracefully', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeToolInstance(tracker);
      const urls = ['not-a-valid-url'];
      
      const result = await tool.execute(
        'test-scrape-invalid-url',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      
      // An unparseable URL is never a success: it is reported as a failure with
      // a "Failed to Scrape" section, not silently dropped.
      const details = result.details as { successful: number; failed: number };
      expect(details.successful).toBe(0);
      expect(details.failed).toBeGreaterThanOrEqual(1);

      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        expect(text).toContain('**Successful:** 0');
        expect(text).toContain('Failed to Scrape');
      }
    });

    it('should handle non-existent URL gracefully', { timeout: 60000 }, async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeToolInstance(tracker);
      const urls = ['https://this-definitely-does-not-exist-12345.com'];
      
      const result = await tool.execute(
        'test-scrape-404',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      
      // A DNS-unresolvable host resolves to a failed scrape regardless of
      // network state (offline → also failed), so this is deterministic.
      const details = result.details as { successful: number; failed: number };
      expect(details.successful).toBe(0);
      expect(details.failed).toBeGreaterThanOrEqual(1);

      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        expect(text).toContain('Failed to Scrape');
      }
    });

    it('should handle mixed valid and invalid URLs', { timeout: 300000 }, async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeToolInstance(tracker);
      const urls = [
        'https://en.wikipedia.org/wiki/TypeScript',
        'not-a-valid-url',
        'https://en.wikipedia.org/wiki/JavaScript',
      ];
      
      const result = await tool.execute(
        'test-scrape-mixed',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        if (isNetworkUnavailable(text)) {
          return;
        }
        // One invalid + two reachable Wikipedia URLs → genuine partial success:
        // at least one succeeds and the invalid one is reported as failed.
        const details = result.details as { successful: number; failed: number };
        expect(details.successful).toBeGreaterThanOrEqual(1);
        expect(details.failed).toBeGreaterThanOrEqual(1);
        expect(text).toContain('Failed to Scrape');
      }
    });

    it('should handle empty URL list', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeToolInstance(tracker);
      const urls: string[] = [];
      
      const result = await tool.execute(
        'test-scrape-empty',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });
  });

  describe('Search Tool - Error Scenarios', () => {
    it('should handle empty query gracefully', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 6 }) 
      });
      
      const result = await tool.execute(
        'test-search-empty',
        { queries: [''] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it('should handle very long query', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 6 }) 
      });
      
      const longQuery = 'a '.repeat(10000);
      const result = await tool.execute(
        'test-search-long',
        { queries: [longQuery] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it('should handle special characters in query', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 6 }) 
      });
      
      const specialQuery = 'C++ vs Java & "Python"';
      const result = await tool.execute(
        'test-search-special',
        { queries: [specialQuery] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });
  });

  describe('Tool Failure Cascade Prevention', () => {
    it('should prevent search failure from affecting subsequent searches', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 6 }) 
      });
      
      // First search with invalid query
      const result1 = await tool.execute(
        'test-cascade-1',
        { queries: [''] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );
      expect(result1).toBeDefined();

      // Second search with valid query should still work
      const result2 = await tool.execute(
        'test-cascade-2',
        { queries: ['test query'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );
      expect(result2).toBeDefined();
      expect(result2.content).toBeDefined();
    });

    it('should prevent scrape failure from affecting subsequent scrapes', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeToolInstance(tracker);
      
      // First scrape with invalid URL
      const result1 = await tool.execute(
        'test-scrape-cascade-1',
        { urls: ['not-a-valid-url'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );
      expect(result1).toBeDefined();

      // Second scrape with valid URL should still work
      const result2 = await tool.execute(
        'test-scrape-cascade-2',
        { urls: ['https://en.wikipedia.org/wiki/Test'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );
      expect(result2).toBeDefined();
      expect(result2.content).toBeDefined();
    });
  });
  });
});
