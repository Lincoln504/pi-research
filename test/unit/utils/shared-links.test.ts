/**
 * Shared Links Pool Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateSessionId,
  formatSharedLinksFromState,
  registerScrapedLinks,
  getScrapedLinks,
  deduplicateUrls,
  normalizeUrl,
  resetScrapedLinks,
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

    it('should reset pool', () => {
      registerScrapedLinks(researchId, ['https://a.com']);
      resetScrapedLinks(researchId);
      expect(getScrapedLinks(researchId)).toHaveLength(0);
    });

    it('should cleanup session', () => {
      registerScrapedLinks(researchId, ['https://a.com']);
      cleanupSharedLinks(researchId);
      expect(getScrapedLinks(researchId)).toHaveLength(0);
    });
  });

  describe('formatSharedLinksFromState', () => {
    it('should return empty string for no reports', () => {
      const aspects = {
        '1.1': { id: '1.1', query: 'q1' }
      };
      expect(formatSharedLinksFromState(aspects)).toBe('');
    });

    it('should format links from reports', () => {
      const aspects = {
        '1.1': {
          id: '1.1',
          query: 'q1',
          report: `
### CITED LINKS
* [Example](https://example.com/1) - Desc 1

### SCRAPE CANDIDATES
* [Another](https://example.com/2) - Reason 2
`
        }
      };

      const result = formatSharedLinksFromState(aspects);
      expect(result).toContain('Shared Links from Sibling Researchers');
      expect(result).toContain('Aspect: q1 (ID: 1.1)');
      expect(result).toContain('https://example.com/1');
      expect(result).toContain('https://example.com/2');
    });
  });
});
