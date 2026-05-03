/**
 * Shared Links Normalization Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { normalizeUrl, registerScrapedLinks, getScrapedLinks, deduplicateUrls, resetScrapedLinks } from '../../../src/utils/shared-links.ts';

describe('shared-links normalization', () => {
  describe('normalizeUrl', () => {
    it('should force https', () => {
      expect(normalizeUrl('http://example.com')).toBe('https://example.com');
    });

    it('should remove trailing slashes', () => {
      expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
      expect(normalizeUrl('https://example.com/path/')).toBe('https://example.com/path');
    });

    it('should remove hash fragments', () => {
      expect(normalizeUrl('https://example.com/#section')).toBe('https://example.com');
      expect(normalizeUrl('https://example.com/path?query=1#hash')).toBe('https://example.com/path?query=1');
    });

    it('should lowercase the hostname', () => {
      expect(normalizeUrl('https://EXAMPLE.com/Path')).toBe('https://example.com/Path');
    });

    it('should handle invalid URLs gracefully', () => {
      expect(normalizeUrl('not-a-url/')).toBe('not-a-url');
      expect(normalizeUrl('not-a-url#hash')).toBe('not-a-url');
    });
  });

  describe('deduplication with normalization', () => {
    const sessionId = 'test-session';

    it('should recognize equivalent URLs', () => {
      resetScrapedLinks(sessionId);
      registerScrapedLinks(sessionId, ['http://example.com/']);
      
      const { kept, duplicates } = deduplicateUrls(['https://example.com#section'], sessionId);
      expect(kept).toHaveLength(0);
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]).toBe('https://example.com#section');
    });

    it('should keep unique URLs', () => {
      resetScrapedLinks(sessionId);
      registerScrapedLinks(sessionId, ['https://example.com/page1']);
      
      const { kept, duplicates } = deduplicateUrls(['https://example.com/page2'], sessionId);
      expect(kept).toHaveLength(1);
      expect(kept[0]).toBe('https://example.com/page2');
      expect(duplicates).toHaveLength(0);
    });
  });
});
