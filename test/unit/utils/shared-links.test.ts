/**
 * Shared Links Pool Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateSessionId,
  registerScrapedLinks,
  getScrapedLinks,
  deduplicateUrls,
  normalizeUrl,
  registerResearcherScrapes,
  didResearcherScrape,
  getResearcherScrapes,
  cleanupSharedLinks,
  buildSessionPoolFooter,
  cacheScrapedContent,
  getCachedScrapedContent
} from '../../../src/utils/shared-links.ts';
import { MAX_SCRAPE_CONTENT_CHARS_PER_DOC } from '../../../src/constants.ts';

describe('shared-links', () => {
  const researchId = 'test-session';

  beforeEach(() => {
    cleanupSharedLinks(researchId);
  });

  describe('generateSessionId', () => {
    it('should generate session ID with base ID and hash', () => {
      const sessionId = generateSessionId('abc123');
      expect(sessionId).toMatch(/^abc123-[a-z0-9]+$/);
    });
  });

  describe('normalizeUrl', () => {
    it('should normalize URLs correctly', () => {
      expect(normalizeUrl('http://example.com/')).toBe('https://example.com');
      expect(normalizeUrl('https://example.com/path/')).toBe('https://example.com/path');
      expect(normalizeUrl('https://EXAMPLE.com/Path#hash')).toBe('https://example.com/Path');
    });
  });

  describe('Pool Management', () => {
    it('should register and retrieve scraped links', () => {
      registerScrapedLinks(researchId, ['https://a.com', 'http://b.com/']);
      const links = getScrapedLinks(researchId);
      expect(links).toContain('https://a.com');
      expect(links).toContain('https://b.com');
      expect(links).toHaveLength(2);
    });

    it('should deduplicate URLs against the pool', () => {
      registerScrapedLinks(researchId, ['https://a.com']);
      
      const { kept, duplicates } = deduplicateUrls(
        ['https://a.com', 'https://b.com', 'http://a.com/'], 
        researchId
      );
      
      expect(kept).toEqual(['https://b.com']);
      expect(duplicates).toContain('https://a.com');
      expect(duplicates).toContain('http://a.com/');
    });

    it('should cleanup session', () => {
      registerScrapedLinks(researchId, ['https://a.com']);
      cleanupSharedLinks(researchId);
      expect(getScrapedLinks(researchId)).toHaveLength(0);
    });
  });

  describe('Per-Researcher Scrape Tracking', () => {
    it('should register and query per-researcher scrapes', () => {
      registerResearcherScrapes(researchId, 'r1', ['https://a.com', 'https://b.com']);
      registerResearcherScrapes(researchId, 'r2', ['https://c.com']);

      expect(didResearcherScrape(researchId, 'r1', 'https://a.com')).toBe(true);
      expect(didResearcherScrape(researchId, 'r1', 'https://c.com')).toBe(false);
      expect(didResearcherScrape(researchId, 'r2', 'https://c.com')).toBe(true);
      expect(didResearcherScrape(researchId, 'r2', 'https://a.com')).toBe(false);
    });

    it('should get all scrapes for a researcher', () => {
      registerResearcherScrapes(researchId, 'r1', ['https://a.com', 'https://b.com']);

      const scrapes = getResearcherScrapes(researchId, 'r1');
      expect(scrapes).toContain('https://a.com');
      expect(scrapes).toContain('https://b.com');
      expect(scrapes).toHaveLength(2);
    });

    it('should return empty array for unknown researcher', () => {
      expect(getResearcherScrapes(researchId, 'unknown')).toEqual([]);
    });

    it('should normalize URLs when registering', () => {
      registerResearcherScrapes(researchId, 'r1', ['http://example.com/']);
      expect(didResearcherScrape(researchId, 'r1', 'https://example.com')).toBe(true);
    });

    it('should accumulate scrapes across multiple calls', () => {
      registerResearcherScrapes(researchId, 'r1', ['https://a.com']);
      registerResearcherScrapes(researchId, 'r1', ['https://b.com']);

      expect(getResearcherScrapes(researchId, 'r1')).toHaveLength(2);
    });

    it('should clean up per-researcher data on session cleanup', () => {
      registerResearcherScrapes(researchId, 'r1', ['https://a.com']);
      cleanupSharedLinks(researchId);
      expect(getResearcherScrapes(researchId, 'r1')).toEqual([]);
    });
  });

  describe('cacheScrapedContent eviction', () => {
    it('re-caching an existing URL does not evict an unrelated entry (no over-eviction at capacity)', () => {
      const MAX = 500; // mirrors MAX_CACHED_CONTENT_PER_SESSION
      for (let i = 0; i < MAX; i++) {
        cacheScrapedContent(researchId, `https://example.com/p${i}`, `content-${i}`);
      }
      // At capacity; the oldest entry (p0) is still present.
      expect(getCachedScrapedContent(researchId, 'https://example.com/p0')).toBe('content-0');
      // Re-cache an EXISTING url — must update in place, evicting nothing.
      cacheScrapedContent(researchId, 'https://example.com/p250', 'updated-250');
      expect(getCachedScrapedContent(researchId, 'https://example.com/p250')).toBe('updated-250');
      // The unrelated oldest entry must survive (it was wrongly evicted before the fix).
      expect(getCachedScrapedContent(researchId, 'https://example.com/p0')).toBe('content-0');
    });
  });

  describe('cacheScrapedContent byte-bounding', () => {
    it('caps oversized content at MAX_SCRAPE_CONTENT_CHARS_PER_DOC with a truncation marker', () => {
      const huge = 'line of scraped text\n'.repeat(30_000); // 630k chars, above the cap
      cacheScrapedContent(researchId, 'https://example.com/huge-pdf', huge);
      const cached = getCachedScrapedContent(researchId, 'https://example.com/huge-pdf');
      expect(cached).toBeDefined();
      expect(cached!.length).toBeLessThanOrEqual(MAX_SCRAPE_CONTENT_CHARS_PER_DOC);
      expect(cached).toMatch(/\[content truncated: showing \d+ of \d+ chars\]$/);
      // Kept body is a prefix of the original content
      const body = cached!.slice(0, cached!.indexOf('\n\n[content truncated'));
      expect(huge.startsWith(body)).toBe(true);
    });

    it('stores content under the cap verbatim (no marker)', () => {
      const normal = 'regular article content '.repeat(100); // 2.4k chars
      cacheScrapedContent(researchId, 'https://example.com/article', normal);
      expect(getCachedScrapedContent(researchId, 'https://example.com/article')).toBe(normal);
    });
  });

  describe('buildSessionPoolFooter', () => {
    it('should return empty string when pool is empty', () => {
      expect(buildSessionPoolFooter(researchId, [])).toBe('');
    });

    it('should return URLs not in current batch', () => {
      registerScrapedLinks(researchId, ['https://a.com', 'https://b.com', 'https://c.com']);
      const footer = buildSessionPoolFooter(researchId, ['https://a.com']);
      expect(footer).not.toContain('https://a.com');
      expect(footer).toContain('https://b.com');
      expect(footer).toContain('https://c.com');
      cleanupSharedLinks(researchId);
    });

    it('should exclude URLs previously scraped by the given researcher', () => {
      registerScrapedLinks(researchId, ['https://own.com/page', 'https://other.com/page']);
      registerResearcherScrapes(researchId, 'R1', ['https://own.com/page']);
      const footer = buildSessionPoolFooter(researchId, [], 'R1');
      expect(footer).not.toContain('https://own.com/page');
      expect(footer).toContain('https://other.com/page');
      cleanupSharedLinks(researchId);
    });

    it('should return empty string when all URLs are excluded', () => {
      registerScrapedLinks(researchId, ['https://a.com']);
      const footer = buildSessionPoolFooter(researchId, ['https://a.com']);
      expect(footer).toBe('');
      cleanupSharedLinks(researchId);
    });

    it('should cap at 20 URLs with overflow', () => {
      const urls = Array.from({ length: 25 }, (_, i) => `https://pool.com/${i}`);
      registerScrapedLinks(researchId, urls);
      const footer = buildSessionPoolFooter(researchId, []);
      expect(footer).toContain('...and 5 more');
      expect(footer).toContain('Session URL Pool');
      cleanupSharedLinks(researchId);
    });

    it('should work without researcherId (no per-researcher filtering)', () => {
      registerScrapedLinks(researchId, ['https://a.com', 'https://b.com']);
      registerResearcherScrapes(researchId, 'R1', ['https://a.com']);
      // Without researcherId, all pool URLs (minus current batch) appear
      const footer = buildSessionPoolFooter(researchId, ['https://b.com']);
      expect(footer).toContain('https://a.com');
      expect(footer).not.toContain('https://b.com');
      cleanupSharedLinks(researchId);
    });
  });
});
