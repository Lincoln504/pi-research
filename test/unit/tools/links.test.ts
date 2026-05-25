/**
 * Links Tool Unit Tests
 *
 * Tests for the links tool that queries the global shared links pool.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLinksTool } from '../../../src/tools/links.ts';
import { registerScrapedLinks, cleanupSharedLinks, resetScrapedLinks } from '../../../src/utils/shared-links.ts';
import type { SystemResearchState } from '../../../src/orchestration/deep-research-types.ts';

describe('links tool', () => {
  const testResearchId = 'test-research-123';

  let mockState: SystemResearchState;
  let mockCtx: any;

  beforeEach(() => {
    resetScrapedLinks(testResearchId);
    registerScrapedLinks(testResearchId, [
      'https://example.com/article1',
      'https://example.org/guide',
      'https://github.com/repo',
    ]);

    mockState = {
      researchId: testResearchId,
      query: 'test query',
      plan: null,
      aspectResults: new Map(),
      completedRounds: 0,
      synthesisResults: null,
    } as unknown as SystemResearchState;

    mockCtx = {
      cwd: '/test/dir',
      model: { id: 'test-model' },
    };
  });

  afterEach(() => {
    cleanupSharedLinks(testResearchId);
  });

  describe('tool definition', () => {
    it('should have correct metadata', () => {
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });

      expect(tool.name).toBe('links');
      expect(tool.label).toBe('Links');
      expect(tool.description).toContain('global shared links pool');
      expect(tool.promptSnippet).toContain('Check already scraped links');
    });

    it('should have parameter schema with action enum', () => {
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });

      expect(tool.parameters).toBeDefined();
      expect((tool.parameters as any).properties).toHaveProperty('action');
      expect((tool.parameters as any).properties).toHaveProperty('query');
    });

    it('should include prompt guidelines', () => {
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });

      expect(tool.promptGuidelines).toBeDefined();
      expect(tool.promptGuidelines).toHaveLength(3);
      expect(tool.promptGuidelines![0]).toContain('see what other researchers');
    });
  });

  describe('list action', () => {
    it('should list all scraped links', async () => {
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });
      const result = await tool.execute('call-1', { action: 'list' }, undefined, undefined, {} as any);

      expect(result.content).toHaveLength(1);
      const text = (result.content[0] as any).text as string;
      expect(text).toContain('Global Scraped Links (3 found)');
      expect(text).toContain('https://example.com/article1');
      expect(text).toContain('https://example.org/guide');
      expect(text).toContain('https://github.com/repo');
    });

    it('should number links sequentially', async () => {
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });
      const result = await tool.execute('call-1', { action: 'list' }, undefined, undefined, {} as any);

      const text = (result.content[0] as any).text as string;
      expect(text).toContain('1. https://example.com/article1');
      expect(text).toContain('2. https://example.org/guide');
      expect(text).toContain('3. https://github.com/repo');
    });

    it('should return details with count', async () => {
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });
      const result = await tool.execute('call-1', { action: 'list' }, undefined, undefined, {} as any);

      expect(result.details).toEqual({
        count: 3,
        action: 'list',
      });
    });

    it('should handle empty pool gracefully', async () => {
      resetScrapedLinks(testResearchId);
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });
      const result = await tool.execute('call-1', { action: 'list' }, undefined, undefined, {} as any);

      const text = (result.content[0] as any).text as string;
      expect(text).toContain('Global Scraped Links (0 found)');
      expect(text).toContain('No links found in the pool.');
      expect(result.details).toEqual({ count: 0, action: 'list' });
    });
  });

  describe('search action', () => {
    it('should filter links by keyword', async () => {
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });
      const result = await tool.execute('call-1', { action: 'search', query: 'github' }, undefined, undefined, {} as any);

      const text = (result.content[0] as any).text as string;
      expect(text).toContain('Global Scraped Links (1 found)');
      expect(text).toContain('https://github.com/repo');
      expect(text).not.toContain('example.com');
      expect(result.details).toEqual({ count: 1, action: 'search' });
    });

    it('should be case-insensitive', async () => {
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });

      const result1 = await tool.execute('call-1', { action: 'search', query: 'GITHUB' }, undefined, undefined, {} as any);
      const result2 = await tool.execute('call-2', { action: 'search', query: 'Github' }, undefined, undefined, {} as any);

      expect(((result1.content[0] as any).text as string)).toContain('https://github.com/repo');
      expect(((result2.content[0] as any).text as string)).toContain('https://github.com/repo');
    });

    it('should handle multiple matches', async () => {
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });
      const result = await tool.execute('call-1', { action: 'search', query: 'example' }, undefined, undefined, {} as any);

      const text = (result.content[0] as any).text as string;
      expect(text).toContain('Global Scraped Links (2 found)');
      expect(text).toContain('https://example.com/article1');
      expect(text).toContain('https://example.org/guide');
      expect(result.details).toEqual({ count: 2, action: 'search' });
    });

    it('should return no results for non-matching query', async () => {
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });
      const result = await tool.execute('call-1', { action: 'search', query: 'nonexistent' }, undefined, undefined, {} as any);

      const text = (result.content[0] as any).text as string;
      expect(text).toContain('Global Scraped Links (0 found)');
      expect(text).toContain('No links found matching "nonexistent".');
      expect(result.details).toEqual({ count: 0, action: 'search' });
    });

    it('should handle empty query parameter', async () => {
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });
      const result = await tool.execute('call-1', { action: 'search', query: '' }, undefined, undefined, {} as any);

      const text = (result.content[0] as any).text as string;
      expect(text).toContain('Global Scraped Links (3 found)');
      expect(result.details).toEqual({ count: 3, action: 'search' });
    });

    it('should handle missing query parameter', async () => {
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });
      const result = await tool.execute('call-1', { action: 'search' }, undefined, undefined, {} as any);

      const text = (result.content[0] as any).text as string;
      expect(text).toContain('Global Scraped Links (3 found)');
      expect(result.details).toEqual({ count: 3, action: 'search' });
    });
  });

  describe('parameter validation', () => {
    it('should reject invalid action parameter', async () => {
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });
      const result = await tool.execute('call-1', { action: 'invalid' } as any, undefined, undefined, {} as any);

      expect((result.content[0] as any).text).toContain('Invalid parameters for links tool');
      expect(result.details).toEqual({ error: 'invalid_parameters' });
    });

    it('should reject missing action parameter', async () => {
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });
      const result = await tool.execute('call-1', {} as any, undefined, undefined, {} as any);

      expect((result.content[0] as any).text).toContain('Invalid parameters for links tool');
      expect(result.details).toEqual({ error: 'invalid_parameters' });
    });
  });

  describe('state isolation', () => {
    it('should use correct research ID from state', async () => {
      const otherResearchId = 'other-research-456';
      resetScrapedLinks(otherResearchId);
      registerScrapedLinks(otherResearchId, ['https://other.com']);

      mockState.researchId = otherResearchId;
      const tool = createLinksTool({ ctx: mockCtx, getGlobalState: () => mockState });
      const result = await tool.execute('call-1', { action: 'list' }, undefined, undefined, {} as any);

      const text = (result.content[0] as any).text as string;
      expect(text).toContain('Global Scraped Links (1 found)');
      expect(text).toContain('https://other.com');
      expect(text).not.toContain('github.com');

      cleanupSharedLinks(otherResearchId);
    });
  });
});
