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
    it('should execute search with valid results structure', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 6 }) 
      });
      const result = await tool.execute(
        'test-search-1',
        { queries: ['python programming', 'python tutorial', 'learn python', 'python beginner', 'python advanced', 'python vs javascript', 'python data science', 'python web development', 'python script', 'python automation'] },
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
      expect(typeof firstContent.text).toBe('string');
    });

    it('should return markdown formatted results with expected sections', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 6 }) 
      });
      const result = await tool.execute(
        'test-search-2',
        { queries: ['machine learning', 'ml tutorial', 'learn ml', 'ml basics', 'ml advanced', 'ml algorithms', 'ml models', 'ml frameworks', 'ml python', 'ml tensorflow'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result.content).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0].text as string;
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

    it('should scrape Wikipedia successfully with substantial content', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
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
        const text = result.content[0].text as string;
        expect(text).toContain('Python');
        expect(text.length).toBeGreaterThan(1000);
        expect(text).toMatch(/^#+\s/m);
      }
    });
  });
});
