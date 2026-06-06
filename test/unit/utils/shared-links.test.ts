/**
 * Shared Links Pool Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateSessionId,
  formatLightweightLinkUpdate,
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

  describe('formatLightweightLinkUpdate', () => {
    it('returns empty string for empty URL list', () => {
      expect(formatLightweightLinkUpdate([], 'r1', 'Researcher 1')).toBe('');
    });

    it('returns formatted advisory with researcher ID and URL list', () => {
      const result = formatLightweightLinkUpdate(
        ['https://a.com', 'https://b.com'],
        'r2',
        'Researcher 2',
      );
      expect(result).toContain('Researcher r2');
      expect(result).toContain('https://a.com');
      expect(result).toContain('https://b.com');
    });

    it('each URL appears on its own line', () => {
      const result = formatLightweightLinkUpdate(
        ['https://x.com', 'https://y.com'],
        'r3',
        'Researcher 3',
      );
      const lines = result.split('\n');
      expect(lines.some(l => l.includes('https://x.com'))).toBe(true);
      expect(lines.some(l => l.includes('https://y.com'))).toBe(true);
    });
  });
});
