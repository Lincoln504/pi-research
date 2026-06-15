/**
 * Shared Links Normalization Unit Tests
 *
 * Focuses on behavior through property-based tests rather than testing
 * individual transformations which are covered by property-based tests.
 */

import { describe, it, expect } from 'vitest';
import { normalizeUrl, registerScrapedLinks, deduplicateUrls, cleanupSharedLinks } from '../../../src/utils/shared-links.ts';

describe('shared-links normalization', () => {
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

    it('terminates on non-special-scheme URLs with an opaque trailing-slash path', () => {
      // Regression: "www.x.org9f:" parses as a NON-special scheme, so both the
      // protocol force (https) and the pathname assignment in normalizeUrl are
      // silently ignored by the WHATWG URL setters. The trailing-slash strip
      // loop used to spin forever on the opaque path, blocking the event loop
      // (and even vitest's own test timeout). These must return promptly.
      const opaquePathUrls = [
        "www.site43.org9f:,'ip762*')-o1/?1f9)ueo]xr3bf0=@*a]?&6k+v).#",
        'foo.bar:baz/',
        'a.b.c:/x///',
        'scheme.with.dots:opaque/path/',
      ];
      for (const u of opaquePathUrls) {
        expect(() => normalizeUrl(u)).not.toThrow();
        expect(typeof normalizeUrl(u)).toBe('string');
      }
    });
  });

  describe('deduplication with normalization', () => {
    const sessionId = 'test-session';

    it('should recognize equivalent URLs', () => {
      cleanupSharedLinks(sessionId);
      registerScrapedLinks(sessionId, ['http://example.com/']);

      const { kept, duplicates } = deduplicateUrls(['https://example.com#section'], sessionId);
      expect(kept).toHaveLength(0);
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]!).toBe('https://example.com#section');
    });

    it('should keep unique URLs', () => {
      cleanupSharedLinks(sessionId);
      registerScrapedLinks(sessionId, ['https://example.com/page1']);

      const { kept, duplicates } = deduplicateUrls(['https://example.com/page2'], sessionId);
      expect(kept).toHaveLength(1);
      expect(kept[0]!).toBe('https://example.com/page2');
      expect(duplicates).toHaveLength(0);
    });
  });
});