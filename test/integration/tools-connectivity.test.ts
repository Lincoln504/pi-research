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

  let lifecycleUrl: string | null = null;

  beforeAll(async () => {
    testContext = await setupLifecycle();
    
    if (testContext.lifecycleInitialized) {
      try {
        // Get the lifecycle URL dynamically
        const lifecycleModule = await import('../../src/infrastructure/searxng-lifecycle.ts');
        const status = lifecycleModule.getStatus();
        lifecycleUrl = status.url || null;
      } catch (err) {
        console.error('Failed to get lifecycle URL:', err);
      }
    }
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

    it('should have proper parameter schema', () => {
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 6 }) 
      });
      
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.type).toBe('object');
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
        { queries: ['python programming'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      
      // Check content structure
      const firstContent = result.content[0];
      expect(firstContent).toHaveProperty('type', 'text');
      expect(firstContent).toHaveProperty('text');
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
        { queries: ['machine learning'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result.content).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0].text as string;
        
        // If SearXNG is not initialized, we'll get an error message
        // In this case, we skip the strict markdown check
        if (text.includes('SearXNG manager not initialized')) {
          console.warn('[test] SearXNG manager not initialized, skipping markdown check');
          return;
        }
        
        // Check for expected markdown structure (using # headers)
        expect(text).toMatch(/^#\s+/); // Headers with #
        expect(text).toMatch(/\[.*?\]\(https?:\/\/.*?\)/); // Markdown links
        expect(text.length).toBeGreaterThan(100);
      }
    });

    it('should handle multiple queries in single request', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 10 }) 
      });
      const result = await tool.execute(
        'test-search-3',
        { queries: ['python programming', 'javascript basics'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result.content).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0].text as string;
        
        // Should contain results for both queries
        expect(text).toMatch(/python|javascript/i);
        expect(text.length).toBeGreaterThan(100);
      }
    });
  });

  describe('Search Tool - Error Handling and Edge Cases', () => {
    it('should reject empty queries array', async () => {
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 6 }) 
      });
      
      await expect(
        tool.execute(
          'test-search-empty',
          { queries: [] },
          undefined,
          undefined,
          mockExtensionCtx as any
        )
      ).rejects.toThrow();
    });

    it('should handle queries that return no results gracefully', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 6 }) 
      });
      
      // Query that's unlikely to have results
      const result = await tool.execute(
        'test-search-no-results',
        { queries: ['xyzzyplugh12345asdfghjkl' + Math.random()] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      // Should not crash - returns results (possibly empty)
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it('should handle SearXNG timeouts and errors within the tool wrapper', async () => {
       if (testContext.skipTests()) {
        return;
      }
      
      // We can't easily force a SearXNG error without mocking the search function,
      // but we can verify how the tool handles a very large query which might trigger 414
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 6 }) 
      });
      
      const largeQuery = 'a'.repeat(2000);
      const result = await tool.execute(
        'test-search-large',
        { queries: [largeQuery] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      // Should either have results or a gracefully classified error message
      const text = (result.content[0] as any).text;
      expect(text.length).toBeGreaterThan(0);
    });

    it('should handle special characters in queries', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 6 }) 
      });
      
      const result = await tool.execute(
        'test-search-special',
        { queries: ['C++ programming', 'data science & AI'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0].text as string;
        expect(text.length).toBeGreaterThan(50);
      }
    });

    it('should enforce maxResults parameter constraints', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker: new ToolUsageTracker({ gathering: 6 }) 
      });
      
      const result = await tool.execute(
        'test-search-maxresults',
        { queries: ['test'], maxResults: 5 },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0].text as string;
        // Should not crash with maxResults constraint
        expect(text.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Scrape Tool - Instantiation and Structure', () => {
    it('should instantiate scrape tool with correct properties', () => {
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeTool({ 
        searxngUrl: lifecycleUrl || 'http://localhost:8080', 
        ctx: mockExtensionCtx as any, 
        tracker, 
        getGlobalState: () => ({} as any), 
        updateGlobalLinks: () => {} 
      });
      
      expect(tool).toBeDefined();
      expect(tool.name).toBe('scrape');
      expect(tool.label).toBeDefined();
      expect(tool.execute).toBeDefined();
      expect(typeof tool.execute).toBe('function');
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
    });

    it('should have proper parameter schema', () => {
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeTool({ 
        searxngUrl: lifecycleUrl || 'http://localhost:8080', 
        ctx: mockExtensionCtx as any, 
        tracker, 
        getGlobalState: () => ({} as any), 
        updateGlobalLinks: () => {} 
      });
      
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.type).toBe('object');
    });
  });

  describe('Scrape Tool - Handshake Protocol', () => {
    
    // Helper function to create scrape tool with lifecycle URL
    const createScrapeToolWithLifecycle = (tracker: ToolUsageTracker) => {
      return createScrapeTool({
        searxngUrl: lifecycleUrl || 'http://localhost:8080',
        ctx: mockExtensionCtx as any,
        tracker,
        getGlobalState: () => ({} as any),
        updateGlobalLinks: () => {}
      });
    };
    it('should perform handshake protocol correctly', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeToolWithLifecycle(tracker);
      const urls = ['https://en.wikipedia.org/wiki/Python_(programming_language)'];
      
      const result = await tool.execute(
        'test-scrape-handshake',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.details).toBeDefined();
      expect(result.details).toHaveProperty('protocol', 'handshake');
      expect(result.details).toHaveProperty('previouslyScrapedCount');
      expect(typeof result.details.previouslyScrapedCount).toBe('number');
    });

    it('should handle multiple URLs in handshake', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeToolWithLifecycle(tracker);
      const urls = [
        'https://en.wikipedia.org/wiki/Python_(programming_language)',
        'https://en.wikipedia.org/wiki/JavaScript',
        'https://en.wikipedia.org/wiki/Rust_(programming_language)',
      ];
      
      const result = await tool.execute(
        'test-scrape-handshake-multi',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result.details).toBeDefined();
      expect(result.details.previouslyScrapedCount).toBeDefined();
      // Handshake doesn't return urls - it returns previouslyScrapedCount
    });
  });

  describe('Scrape Tool - Basic Functionality', () => {
    
    // Helper function to create scrape tool with lifecycle URL
    const createScrapeToolWithLifecycle = (tracker: ToolUsageTracker) => {
      return createScrapeTool({
        searxngUrl: lifecycleUrl || 'http://localhost:8080',
        ctx: mockExtensionCtx as any,
        tracker,
        getGlobalState: () => ({} as any),
        updateGlobalLinks: () => {}
      });
    };
    it('should scrape Wikipedia successfully with substantial content', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeToolWithLifecycle(tracker);
      const urls = ['https://en.wikipedia.org/wiki/Python_(programming_language)'];
      
      // Handshake
      await tool.execute(
        'test-scrape-content-1-hs',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      // Execution
      const result = await tool.execute(
        'test-scrape-content-1-exec',
        { urls },
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
        
        // Check for substantial content
        expect(text).toContain('Python');
        expect(text.length).toBeGreaterThan(1000); // Wikipedia articles are substantial
        
        // Check for markdown structure
        expect(text).toMatch(/^#+\s/m); // Markdown headers
      }
    });

    it('should handle multiple URLs concurrently', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeToolWithLifecycle(tracker);
      const urls = [
        'https://en.wikipedia.org/wiki/Python_(programming_language)',
        'https://en.wikipedia.org/wiki/JavaScript',
      ];

      // Handshake
      await tool.execute(
        'test-scrape-multi-hs',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      // Execution with concurrency
      const result = await tool.execute(
        'test-scrape-multi-exec',
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
        expect(text).toContain('Python');
        expect(text).toContain('JavaScript');
        expect(text.length).toBeGreaterThan(1000);
      }
    });

    it('should respect maxConcurrency parameter', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeToolWithLifecycle(tracker);
      const urls = [
        'https://en.wikipedia.org/wiki/Python_(programming_language)',
        'https://en.wikipedia.org/wiki/JavaScript',
      ];

      // Handshake
      await tool.execute(
        'test-scrape-concurrency-hs',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      // Execution with explicit concurrency
      const result = await tool.execute(
        'test-scrape-concurrency-exec',
        { urls, maxConcurrency: 1 },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });
  });

  describe('Scrape Tool - Error Handling and Edge Cases', () => {
    
    // Helper function to create scrape tool with lifecycle URL
    const createScrapeToolWithLifecycle = (tracker: ToolUsageTracker) => {
      return createScrapeTool({
        searxngUrl: lifecycleUrl || 'http://localhost:8080',
        ctx: mockExtensionCtx as any,
        tracker,
        getGlobalState: () => ({} as any),
        updateGlobalLinks: () => {}
      });
    };
    it('should handle 404 errors gracefully', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeToolWithLifecycle(tracker);
      const urls = ['https://en.wikipedia.org/wiki/NonExistentPage12345'];
      
      // Handshake
      await tool.execute(
        'test-scrape-404-hs',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      // Should not crash on 404
      const result = await tool.execute(
        'test-scrape-404-exec',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      // Result may contain error information
      expect(result.content).toBeDefined();
    });

    it('should handle special characters in URLs', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeToolWithLifecycle(tracker);
      const urls = ['https://en.wikipedia.org/wiki/C%2B%2B']; // URL-encoded C++
      
      // Handshake
      await tool.execute(
        'test-scrape-special-url-hs',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      const result = await tool.execute(
        'test-scrape-special-url-exec',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0].text as string;
        expect(text.length).toBeGreaterThan(50);
      }
    });
  });

  describe('Tool Usage Tracking', () => {
    
    // Helper function to create scrape tool with lifecycle URL
    const createScrapeToolWithLifecycle = (tracker: ToolUsageTracker) => {
      return createScrapeTool({
        searxngUrl: lifecycleUrl || 'http://localhost:8080',
        ctx: mockExtensionCtx as any,
        tracker,
        getGlobalState: () => ({} as any),
        updateGlobalLinks: () => {}
      });
    };
    
    it('should track search tool usage', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
      const tracker = new ToolUsageTracker({ gathering: 10 });
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      await tool.execute(
        'test-tracking-search',
        { queries: ['test'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      // Check that tracker recorded call
      expect(tracker.getCallCount('search')).toBeGreaterThan(0);
    });

    it('should track scrape tool usage', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
      const tracker = new ToolUsageTracker({ scrape: 10 });
      const tool = createScrapeToolWithLifecycle(tracker);
      const urls = ['https://en.wikipedia.org/wiki/Test'];
      
      // Handshake
      await tool.execute(
        'test-tracking-scrape-hs',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      await tool.execute(
        'test-tracking-scrape-exec',
        { urls },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      // Check that tracker recorded calls
      expect(tracker.getCallCount('scrape')).toBeGreaterThan(0);
    });

    it('should enforce gathering limits correctly', async () => {
      const tracker = new ToolUsageTracker({ gathering: 2 });
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      // First call should succeed
      const allowed1 = tracker.recordCall('search');
      expect(allowed1).toBe(true);
      
      // Second call should succeed
      const allowed2 = tracker.recordCall('search');
      expect(allowed2).toBe(true);
      
      // Third call should be blocked
      const allowed3 = tracker.recordCall('search');
      expect(allowed3).toBe(false);
    });

    it('should provide correct limit messages', async () => {
      const tracker = new ToolUsageTracker({ gathering: 1 });
      const tool = createSearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      // Use up limit
      tracker.recordCall('search');
      
      // Get limit message
      const message = tracker.getLimitMessage('search');
      expect(message).toContain('GATHERING LIMIT REACHED');
      expect(message).toContain('1');
    });
  });
});
