/**
 * Shared Links Pool Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  generateSessionId,
  formatSharedLinksFromState,
} from '../../../src/utils/shared-links';

describe('shared-links', () => {
  describe('generateSessionId', () => {
    it('should generate session ID with base ID and hash', () => {
      const sessionId = generateSessionId('abc123');
      expect(sessionId).toMatch(/^abc123-[a-f0-9]{4}$/);
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
* [https://example.com/1] - Desc 1

### SCRAPE CANDIDATES
* [https://example.com/2] - Reason 2
`
        }
      };

      const result = formatSharedLinksFromState(aspects);
      expect(result).toContain('Shared Links from Previous Research');
      expect(result).toContain('Aspect: q1 (ID: 1.1)');
      expect(result).toContain('https://example.com/1');
      expect(result).toContain('https://example.com/2');
    });
  });
});
