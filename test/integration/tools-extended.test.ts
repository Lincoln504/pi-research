/**
 * Extended Tools Integration Tests
 *
 * Tests security_search, stackexchange, and grep tools in a real environment.
 */

import { describe, it, expect } from 'vitest';
import { createSecuritySearchTool } from '../../src/tools/security.ts';
import { createStackexchangeTool } from '../../src/tools/stackexchange.ts';
import { createGrepTool } from '../../src/tools/grep.ts';
import { ToolUsageTracker } from '../../src/utils/tool-usage-tracker.ts';

describe('Extended Tools Integration', () => {
  const mockExtensionCtx = {
    cwd: process.cwd(),
    ui: { setWidget: () => {}, notify: () => {} },
  };

  describe('Security Search Tool', () => {
    it('should search for a known CVE', async () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createSecuritySearchTool({ 
        searxngUrl: 'http://localhost:8080', 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'sec-test-1',
        { terms: ['CVE-2024-21626'], databases: ['github', 'osv'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      const text = (result.content[0] as any).text;
      expect(text).toContain('Security Vulnerability Search Results');
      expect(text).toContain('CVE-2024-21626');
    }, 30000);

    it('should search for package vulnerabilities', async () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createSecuritySearchTool({ 
        searxngUrl: 'http://localhost:8080', 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'sec-test-2',
        { terms: ['lodash'], ecosystem: 'npm', databases: ['osv'] },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      const text = (result.content[0] as any).text;
      expect(text).toContain('lodash');
      expect(text).toContain('Open Source Vulnerabilities');
    }, 30000);
  });

  describe('Stack Exchange Tool', () => {
    it('should search for technical questions', async () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createStackexchangeTool({ 
        ctx: mockExtensionCtx as any, 
        tracker 
      });
      
      const result = await tool.execute(
        'se-test-1',
        { command: 'search', query: 'typescript generic constraints', site: 'stackoverflow.com', limit: 5 },
        new AbortController().signal,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      const text = (result.content[0] as any).text;
      expect(text).toContain('Stack Exchange');
      expect(text).toContain('typescript');
    }, 30000);
  });

  describe('Grep Tool', () => {
    it('should find patterns in the codebase', async () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createGrepTool({ tracker });
      
      const result = await tool.execute(
        'grep-test-1',
        { pattern: 'export function createGrepTool', path: 'src/tools' },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      const text = (result.content[0] as any).text;
      expect(text).toContain('Search Results');
      expect(text).toContain('createGrepTool');
      expect(text).toContain('src/tools/grep.ts');
    });

    it('should handle case-insensitive search with flags', async () => {
      const tracker = new ToolUsageTracker({ gathering: 6 });
      const tool = createGrepTool({ tracker });
      
      const result = await tool.execute(
        'grep-test-2',
        { pattern: 'CREATEGREPTOOL', flags: '-i', path: 'src/tools' },
        undefined,
        undefined,
        mockExtensionCtx as any
      );

      expect(result).toBeDefined();
      const text = (result.content[0] as any).text;
      expect(text).toContain('createGrepTool');
    });
  });

  describe('Tool Usage Limits Integration', () => {
    it('should enforce the global gathering limit across different tools', async () => {
      const tracker = new ToolUsageTracker({ gathering: 3 });
      
      const searchTool = createSecuritySearchTool({ searxngUrl: '', ctx: {} as any, tracker });
      const grepTool = createGrepTool({ tracker });
      const seTool = createStackexchangeTool({ ctx: {} as any, tracker });

      // Call 1
      await grepTool.execute('t1', { pattern: 'test' }, undefined, undefined, {} as any);
      // Call 2
      await seTool.execute('t2', { command: 'site' }, new AbortController().signal, undefined, {} as any);
      // Call 3
      await searchTool.execute('t3', { terms: ['test'], databases: ['osv'] }, undefined, undefined, {} as any);

      // Call 4 should be blocked gracefully
      const blocked = await grepTool.execute('t4', { pattern: 'test' }, undefined, undefined, {} as any);
      expect((blocked.details as any).blocked).toBe(true);
      expect((blocked.content[0] as any).text).toContain('GATHERING LIMIT REACHED');
    });
  });
});
