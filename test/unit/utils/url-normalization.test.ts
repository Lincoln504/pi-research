/**
 * Shared Links Normalization Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { normalizeUrl, registerScrapedLinks, deduplicateUrls, resetScrapedLinks } from '../../../src/utils/shared-links.ts';

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

  describe('normalizeUrl — Property-based tests', () => {
    it('should handle variations of same URL consistently', () => {
      const base = 'https://example.com/path';
      const variations = [
        'http://example.com/path',
        'https://EXAMPLE.COM/path/',
        'https://example.com/path#section',
        'https://example.com/path?#',
        'https://example.com/path/',
      ];

      for (const v of variations) {
        expect(normalizeUrl(v)).toBe(base);
      }
    });

    it('should handle arbitrary input strings without crashing', () => {
      const generateRandomUrlLike = () => {
        const parts = ['http://', 'https://', 'www.', 'ftp://', '', 'invalid'];
        const domains = ['com', 'org', 'net', ''];
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789-._~:/?#[]@!$&\'()*+,;=';
        
        let res = parts[Math.floor(Math.random() * parts.length)]!;
        res += 'site' + Math.floor(Math.random() * 100);
        const d = domains[Math.floor(Math.random() * domains.length)];
        if (d) res += '.' + d;
        
        const len = Math.floor(Math.random() * 50);
        for (let i = 0; i < len; i++) {
          res += chars[Math.floor(Math.random() * chars.length)];
        }
        return res;
      };

      for (let i = 0; i < 100; i++) {
        const url = generateRandomUrlLike();
        expect(() => normalizeUrl(url)).not.toThrow();
        const normalized = normalizeUrl(url);
        expect(typeof normalized).toBe('string');
        // Hostname part should be lowercased if it was a valid URL
        if (normalized.startsWith('https://')) {
          let hostname = normalized.split('/')[2];
          if (hostname) {
            // Ignore encoded parts when checking case, as %5B vs %5b can vary
            hostname = hostname.replace(/%[0-9A-F]{2}/gi, '');
            expect(hostname).toBe(hostname.toLowerCase());
          }
        }
      }

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
