/**
 * Extended Tools Integration Tests
 *
 * Tests security_search, stackexchange, and grep tools in a real environment.
 * Includes error handling, edge cases, and robust assertions.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSecuritySearchTool } from '../../src/tools/security.ts';
import { createStackexchangeTool } from '../../src/tools/stackexchange.ts';
import { createGrepTool } from '../../src/tools/grep.ts';
import { setupLifecycle, teardownLifecycle, type TestContext } from './helpers/setup.ts';
import { ToolUsageTracker } from '../../src/utils/tool-usage-tracker.ts';

import { isNetworkUnavailable } from './helpers/network.ts';

describe('Extended Tools Integration', () => {
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

  describe('Security Search Tool - Structure and Setup', () => {
    it('should instantiate security search tool with correct properties', () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createSecuritySearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      expect(tool).toBeDefined();
      expect(tool.name).toBe('security_search');
      expect(tool.label).toBe('Security Search');
      expect(tool.execute).toBeDefined();
      expect(typeof tool.execute).toBe('function');
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
    });

    it('should have proper parameter schema for security search', () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createSecuritySearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      expect(tool.parameters).toBeDefined();
      expect((tool.parameters as any).type).toBe('object');
    });
  });

  describe('Security Search Tool - CVE Search', () => {
    it('should search for a known CVE and return structured results', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createSecuritySearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'sec-cve-test-1',
        { terms: ['CVE-2024-21626'], databases: ['github', 'osv'] },
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
      expect(firstContent).toHaveProperty('text');
      
      const text = (firstContent as any).text as string;
      expect(text).toContain('Security Vulnerability Search Results');
      expect(text).toContain('CVE-2024-21626');
      
      // Check for markdown structure
      expect(text).toMatch(/^#+\s/); // Headers
      expect(text.length).toBeGreaterThan(50);
    }, 60000);

    it('should search for multiple CVEs in single request', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 10 });
      const tool = createSecuritySearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'sec-cve-test-multi',
        { terms: ['CVE-2024-21626', 'CVE-2024-3094'], databases: ['osv'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        expect(text).toContain('CVE-2024-21626');
        expect(text.length).toBeGreaterThan(50);
      }
    }, 60000);
  });

  describe('Security Search Tool - Package Vulnerabilities', () => {
    it('should search for npm package vulnerabilities', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createSecuritySearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'sec-npm-test-1',
        { terms: ['lodash'], ecosystem: 'npm', databases: ['osv'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        expect(text).toContain('lodash');
        expect(text).toMatch(/vulnerabilit(y|ies)/i);
        expect(text).toMatch(/open\s*source/i);
        expect(text.length).toBeGreaterThan(50);
      }
    }, 60000);

    it('should search for Python package vulnerabilities', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createSecuritySearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'sec-py-test-1',
        { terms: ['requests'], ecosystem: 'pypi', databases: ['osv'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        expect(text).toContain('requests');
        expect(text.length).toBeGreaterThan(50);
      }
    }, 60000);
  });

  describe('Security Search Tool - Error Handling', () => {
    it('should handle empty terms array', async () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createSecuritySearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'sec-empty-terms',
        { terms: [], databases: ['osv'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );
      expect(result.details).toMatchObject({ error: 'invalid_parameters' });
      expect((result.content[0] as any).text).toContain('Invalid parameters');
    });

    it('should handle invalid database names gracefully', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createSecuritySearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      // Should not crash with invalid database
      const result = await tool.execute(
        'sec-invalid-db',
        { terms: ['test'], databases: ['invalid-database'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
    }, 60000);

    it('should handle special characters in search terms', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createSecuritySearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'sec-special-chars',
        { terms: ['C++ vulnerability'], databases: ['osv'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        if (isNetworkUnavailable(text)) return;
        // The "++" characters must not break the query — a real, non-empty
        // response body is returned rather than an empty/error result.
        expect(text.length).toBeGreaterThan(50);
      }
    }, 60000);
  });

  describe('Security Search Tool - Advanced Parameters', () => {
    it('should handle severity parameter for filtering', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createSecuritySearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'sec-severity-test',
        { terms: ['vulnerability'], databases: ['cisa'], severity: ['HIGH', 'CRITICAL'] },
        new AbortController().signal,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        if (!isNetworkUnavailable(text)) {
          expect(text).toBeDefined();
        }
      }
    }, 60000);

    it('should handle maxResults parameter', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createSecuritySearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'sec-maxresults-test',
        { terms: ['security'], databases: ['nvd'], maxResults: 5 },
        new AbortController().signal,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        if (!isNetworkUnavailable(text)) {
          expect(text.length).toBeGreaterThan(50);
        }
      }
    }, 60000);

    it('should handle includeExploited parameter', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createSecuritySearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'sec-exploited-test',
        { terms: ['exploit'], databases: ['cisa'], includeExploited: true },
        new AbortController().signal,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        if (!isNetworkUnavailable(text)) {
          expect(text.length).toBeGreaterThan(50);
        }
      }
    }, 60000);

    it('should handle githubRepo parameter for package vulnerabilities', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createSecuritySearchTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'sec-githubrepo-test',
        { terms: ['express'], databases: ['osv'], ecosystem: 'npm', githubRepo: 'expressjs/express' },
        new AbortController().signal,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        if (!isNetworkUnavailable(text)) {
          expect(text.length).toBeGreaterThan(50);
        }
      }
    }, 60000);
  });

  describe('Stack Exchange Tool - Structure and Setup', () => {
    it('should instantiate stackexchange tool with correct properties', () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createStackexchangeTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      expect(tool).toBeDefined();
      expect(tool.name).toBe('stackexchange');
      expect(tool.execute).toBeDefined();
      expect(typeof tool.execute).toBe('function');
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
    });
  });

  describe('Stack Exchange Tool - Search Functionality', () => {
    it('should search for technical questions on Stack Overflow', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createStackexchangeTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'se-search-test-1',
        { command: 'search', query: 'typescript generic constraints', site: 'stackoverflow.com', limit: 5 },
        new AbortController().signal,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        if (isNetworkUnavailable(text)) {
          return;
        }
        expect(text).toMatch(/stack\s*exchange/i);
        expect(text).toMatch(/stackoverflow/i);
        expect(text).toMatch(/typescript/i);
        expect(text.length).toBeGreaterThan(50);
      }
    }, 60000);

    it('should handle different Stack Exchange sites', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createStackexchangeTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'se-site-test-1',
        { command: 'search', query: 'regex', site: 'serverfault.com', limit: 3 },
        new AbortController().signal,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        if (isNetworkUnavailable(text)) {
          return;
        }
        expect(text).toMatch(/regex/i);
        expect(text.length).toBeGreaterThan(50);
      }
    }, 60000);
  });

  describe('Stack Exchange Tool - Error Handling', () => {
    it('should handle tags parameter for filtered search', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createStackexchangeTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'se-tags-test-1',
        // The schema declares `tags` as a comma-separated STRING, not an array;
        // an array is rejected as invalid params (the prior toBeDefined() check
        // silently passed on that rejection).
        { command: 'search', query: 'async', site: 'stackoverflow.com', limit: 3, tags: 'javascript' },
        new AbortController().signal,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        // The tags parameter must be accepted, not rejected as invalid — this is
        // network-independent and is the regression the prior test missed.
        expect(text).not.toContain('Invalid parameters');
        if (isNetworkUnavailable(text)) {
          return;
        }
        // With connectivity, a valid tag-filtered query returns substantive text.
        expect(text.length).toBeGreaterThan(50);
      }
    }, 60000);

    it('should handle format parameter for different output formats', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createStackexchangeTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      for (const format of ['compact', 'table', 'json'] as const) {
        const result = await tool.execute(
          `se-format-${format}`,
          { command: 'search', query: 'array methods', site: 'stackoverflow.com', limit: 2, format },
          new AbortController().signal,
          undefined,
          mockExtensionCtx as any
        );

        expect(result).toBeDefined();
        if (result.content[0]?.type === 'text') {
          const text = result.content[0]!.text as string;
          if (!isNetworkUnavailable(text)) {
            expect(text.length).toBeGreaterThan(50);
          }
        }
      }
    }, 60000);

    it('should handle invalid site names gracefully', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createStackexchangeTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      // Should not crash with invalid site
      const result = await tool.execute(
        'se-invalid-site',
        { command: 'search', query: 'test', site: 'invalid-site-12345.com', limit: 5 },
        new AbortController().signal,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
    }, 60000);

    it('should handle queries with special characters', async (ctx) => {
      if (testContext.skipTests()) return ctx.skip();
      
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createStackexchangeTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'se-special-chars',
        { command: 'search', query: 'C++ pointers', site: 'stackoverflow.com', limit: 5 },
        new AbortController().signal,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
    }, 60000);
  });

  describe('Grep Tool - Structure and Setup', () => {
    it('should instantiate grep tool with correct properties', () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createGrepTool({ tracker });
      
      expect(tool).toBeDefined();
      expect(tool.name).toBe('grep');
      expect(tool.execute).toBeDefined();
      expect(typeof tool.execute).toBe('function');
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
    });
  });

  describe('Grep Tool - Basic Functionality', () => {
    it('should find patterns in codebase', async () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createGrepTool({ tracker });
      
      const result = await tool.execute(
        'grep-find-test-1',
        { pattern: 'export function createGrepTool', path: 'src/tools' },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        // SDK grep returns "filename:line: content" format (relative to searched dir)
        expect(text).toContain('createGrepTool');
        expect(text).toContain('grep.ts');
      }
    });

    it('should find multiple occurrences of a pattern', async () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createGrepTool({ tracker });
      
      const result = await tool.execute(
        'grep-multi-test-1',
        { pattern: 'ToolUsageTracker', path: 'src' },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        expect(text).toContain('ToolUsageTracker');
        // Should appear multiple times
        expect(text.length).toBeGreaterThan(100);
      }
    });

    it('should handle case-insensitive search', async () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createGrepTool({ tracker });
      
      const result = await tool.execute(
        'grep-case-test-1',
        { pattern: 'CREATEGREPTOOL', ignoreCase: true, path: 'src/tools' },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        expect(text).toContain('createGrepTool');
      }
    });
  });

  describe('Grep Tool - Error Handling and Edge Cases', () => {
    it('should handle non-existent directory', async () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createGrepTool({ tracker });
      
      // Should not crash on non-existent directory
      const result = await tool.execute(
        'grep-no-dir',
        { pattern: 'test', path: 'non-existent-directory-12345' },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        // SDK grep throws on missing path; wrapper converts to error result
        expect(text).toMatch(/no\s*matches|error|not\s*found/i);
      }
    });

    it('should handle pattern with no matches', async () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createGrepTool({ tracker });
      
      const result = await tool.execute(
        'grep-no-match',
        { pattern: 'XYZZYPLUGH12345', path: 'src' },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        expect(text).toMatch(/no\s*matches/i);
      }
    });

    it('should handle regex patterns with special characters', async () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createGrepTool({ tracker });
      
      const result = await tool.execute(
        'grep-regex-test',
        { pattern: 'export.*function', path: 'src/tools' },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0]!.text as string;
        expect(text.length).toBeGreaterThan(50);
      }
    });
  });

  describe('Tool Usage Limits Integration', () => {
    it('should enforce global gathering limit across different tools', async () => {
      const tracker = new ToolUsageTracker({ gathering: 3 });
      
      void createSecuritySearchTool({
        ctx: mockExtensionCtx as any,
        tracker
      });
      void createGrepTool({ tracker });
      void createStackexchangeTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });

      // Call 1 - search (allowed)
      const allowed1 = tracker.recordCall('search');
      expect(allowed1).toBe(true);

      // Call 2 - stackexchange (allowed)
      const allowed2 = tracker.recordCall('stackexchange');
      expect(allowed2).toBe(true);

      // Call 3 - security search (allowed)
      const allowed3 = tracker.recordCall('security_search');
      expect(allowed3).toBe(true);

      // Call 4 (another gathering tool) should be blocked because the shared limit is reached
      const allowed4 = tracker.recordCall('stackexchange');
      expect(allowed4).toBe(false);

      // grep is a SEPARATE budget — an exhausted gathering pool must not block it
      const grepAllowed = tracker.recordCall('grep');
      expect(grepAllowed).toBe(true);
    });

    it('should track usage correctly across multiple tool types', async () => {
      const tracker = new ToolUsageTracker({ gathering: 5, scrape: 5 });
      void createGrepTool({ tracker });
      
      // Multiple calls should be tracked
      tracker.recordCall('grep');
      tracker.recordCall('grep');
      tracker.recordCall('grep');

      // Should still be within limits
      expect(tracker.getCallCount('grep')).toBe(3);
    });

    it('should get correct limit messages for different tool types', async () => {
      const tracker = new ToolUsageTracker({ gathering: 2, scrape: 4 });
      
      // Test gathering limit message
      tracker.recordCall('search');
      tracker.recordCall('search');
      
      const gatheringMessage = tracker.getLimitMessage('search');
      expect(gatheringMessage).toContain('GATHERING LIMIT REACHED');
      expect(gatheringMessage).toContain('2');
      
      // Test scrape limit message
      tracker.reset();
      for (let i = 0; i < 4; i++) {
        tracker.recordCall('scrape');
      }
      
      const scrapeMessage = tracker.getLimitMessage('scrape');
      expect(scrapeMessage).toContain('SCRAPE PROTOCOL COMPLETE');
      expect(scrapeMessage).toContain('4');
    });

    it('should reset limits correctly', async () => {
      const tracker = new ToolUsageTracker({ grep: 2 });
      void createGrepTool({ tracker });

      // Use up limit
      tracker.recordCall('grep');
      tracker.recordCall('grep');

      // Should be at limit
      expect(tracker.recordCall('grep')).toBe(false);
      
      // Reset
      tracker.reset();
      
      // Should be available again
      expect(tracker.recordCall('grep')).toBe(true);
    });
  });
});
