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
  cleanupSharedLinks
} from '../../../src/utils/shared-links.ts';

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
});
