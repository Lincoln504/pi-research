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
      expect(tool.parameters.type).toBe('object');
    });
  });

  describe('Security Search Tool - CVE Search', () => {
    it('should search for a known CVE and return structured results', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
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
      
      const text = firstContent.text as string;
      expect(text).toContain('Security Vulnerability Search Results');
      expect(text).toContain('CVE-2024-21626');
      
      // Check for markdown structure
      expect(text).toMatch(/^#+\s/); // Headers
      expect(text.length).toBeGreaterThan(50);
    }, 30000);

    it('should search for multiple CVEs in single request', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
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
        const text = result.content[0].text as string;
        expect(text).toContain('CVE-2024-21626');
        expect(text.length).toBeGreaterThan(50);
      }
    }, 30000);
  });

  describe('Security Search Tool - Package Vulnerabilities', () => {
    it('should search for npm package vulnerabilities', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
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
        const text = result.content[0].text as string;
        expect(text).toContain('lodash');
        expect(text).toMatch(/vulnerabilit(y|ies)/i);
        expect(text).toMatch(/open\s*source/i);
        expect(text.length).toBeGreaterThan(50);
      }
    }, 30000);

    it('should search for Python package vulnerabilities', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
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
        const text = result.content[0].text as string;
        expect(text).toContain('requests');
        expect(text.length).toBeGreaterThan(50);
      }
    }, 30000);
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
      expect(result.content[0].text).toContain('Invalid parameters');
    });

    it('should handle invalid database names gracefully', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
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
    }, 30000);

    it('should handle special characters in search terms', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
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
        expect(result.content[0].text as string).toBeDefined();
      }
    }, 30000);
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
    it('should search for technical questions on Stack Overflow', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
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
        const text = result.content[0].text as string;
        if (isNetworkUnavailable(text)) {
          return;
        }
        expect(text).toMatch(/stack\s*exchange/i);
        expect(text).toMatch(/stackoverflow/i);
        expect(text).toMatch(/typescript/i);
        expect(text.length).toBeGreaterThan(50);
      }
    }, 30000);

    it('should handle different Stack Exchange sites', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
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
        const text = result.content[0].text as string;
        if (isNetworkUnavailable(text)) {
          return;
        }
        expect(text).toMatch(/regex/i);
        expect(text.length).toBeGreaterThan(50);
      }
    }, 30000);
  });

  describe('Stack Exchange Tool - Error Handling', () => {
    it('should handle invalid site names gracefully', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
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
    }, 30000);

    it('should handle queries with special characters', async () => {
      if (testContext.skipTests()) {
        return;
      }
      
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
    }, 30000);
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
        const text = result.content[0].text as string;
        expect(text).toMatch(/search\s*results/i);
        expect(text).toContain('createGrepTool');
        expect(text).toContain('src/tools/grep.ts');
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
        const text = result.content[0].text as string;
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
        { pattern: 'CREATEGREPTOOL', flags: '-i', path: 'src/tools' },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      if (result.content[0]?.type === 'text') {
        const text = result.content[0].text as string;
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
        const text = result.content[0].text as string;
        // Should show error message or "No matches found"
        expect(text).toMatch(/no\s*matches|error|io\s*error/i);
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
        const text = result.content[0].text as string;
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
        const text = result.content[0].text as string;
        expect(text.length).toBeGreaterThan(50);
      }
    });
  });

  describe('Tool Usage Limits Integration', () => {
    it('should enforce global gathering limit across different tools', async () => {
      const tracker = new ToolUsageTracker({ gathering: 3 });
      
      const searchTool = createSecuritySearchTool({
        ctx: mockExtensionCtx as any,
        tracker
      });
      const grepTool = createGrepTool({ tracker });
      const seTool = createStackexchangeTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });

      // Call 1 - grep (allowed)
      const allowed1 = tracker.recordCall('grep');
      expect(allowed1).toBe(true);
      
      // Call 2 - stackexchange (allowed)
      const allowed2 = tracker.recordCall('stackexchange');
      expect(allowed2).toBe(true);
      
      // Call 3 - security search (allowed)
      const allowed3 = tracker.recordCall('security_search');
      expect(allowed3).toBe(true);

      // Call 4 should be blocked because limit is reached
      const allowed4 = tracker.recordCall('grep');
      expect(allowed4).toBe(false);
    });

    it('should track usage correctly across multiple tool types', async () => {
      const tracker = new ToolUsageTracker({ gathering: 5, scrape: 5 });
      const grepTool = createGrepTool({ tracker });
      
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
      const tracker = new ToolUsageTracker({ gathering: 2 });
      const grepTool = createGrepTool({ tracker });
      
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
