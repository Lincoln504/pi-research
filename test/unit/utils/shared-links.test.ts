/**
 * Shared Links Pool Unit Tests
 *
 * Tests pure functions for managing shared links across researchers.
 * File system operations use /tmp directory for testing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  generateSessionId,
  parseResearcherLinks,
  buildSharedLinksPool,
  saveSharedLinks,
  loadSharedLinks,
  cleanupSharedLinks,
  formatSharedLinksForPrompt,
  getSharedLinksSummary,
} from '../../../src/utils/shared-links';

describe('shared-links', () => {
  // Clean up any test files after each test
  afterEach(() => {
    const tempDir = '/tmp';
    const files = fs.readdirSync(tempDir).filter(f => f.startsWith('research-links-test-'));
    for (const file of files) {
      fs.unlinkSync(path.join(tempDir, file));
    }
  });

  describe('generateSessionId', () => {
    it('should generate session ID with base ID and hash', () => {
      const sessionId = generateSessionId('abc123');
      expect(sessionId).toMatch(/^abc123-[a-f0-9]{4}$/);
    });

    it('should generate unique session IDs', () => {
      const id1 = generateSessionId('base');
      const id2 = generateSessionId('base');
      const id3 = generateSessionId('base');
      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });

    it('should handle base IDs with special characters', () => {
      const sessionId = generateSessionId('test-with_special.123');
      expect(sessionId).toMatch(/^test-with_special\.123-[a-f0-9]{4}$/);
    });

    it('should handle empty base ID', () => {
      const sessionId = generateSessionId('');
      expect(sessionId).toMatch(/^-[a-f0-9]{4}$/);
    });

    it('should handle very long base ID', () => {
      const longId = 'a'.repeat(1000);
      const sessionId = generateSessionId(longId);
      expect(sessionId).toMatch(/^a{1000}-[a-f0-9]{4}$/);
    });

    it('should generate 4-character hex hash', () => {
      const sessionId = generateSessionId('test');
      const parts = sessionId.split('-');
      expect(parts).toHaveLength(2);
      expect(parts[1]!).toHaveLength(4);
      expect(parts[1]!).toMatch(/^[a-f0-9]{4}$/);
    });
  });

  describe('parseResearcherLinks', () => {
    describe('positive cases', () => {
      it('should parse empty response', () => {
        const result = parseResearcherLinks('');
        expect(result).toEqual({ cited: [], candidates: [] });
      });

      it('should parse response with only cited links', () => {
        const response = `
### CITED LINKS
* [https://example.com/article1] - Great article about topic
* [https://example.com/article2] - Another useful source
`;
        const result = parseResearcherLinks(response);
        expect(result.cited).toHaveLength(2);
        expect(result.cited[0]!.url).toBe('https://example.com/article1');
        expect(result.cited[0]!.description).toBe('Great article about topic');
        expect(result.candidates).toEqual([]);
      });

      it('should parse response with only scrape candidates', () => {
        const response = `
### SCRAPE CANDIDATES
* [https://example.com/candidate1] - Interesting but not used
* [https://example.com/candidate2] - Too technical
`;
        const result = parseResearcherLinks(response);
        expect(result.candidates).toHaveLength(2);
        expect(result.candidates[0]!.url).toBe('https://example.com/candidate1');
        expect(result.candidates[0]!.reason).toBe('Interesting but not used');
        expect(result.cited).toEqual([]);
      });

      it('should parse response with both cited and candidates', () => {
        const response = `
### CITED LINKS
* [https://example.com/article1] - Used in research
* [https://example.com/article2] - Primary source

### SCRAPE CANDIDATES
* [https://example.com/candidate1] - Not relevant
* [https://example.com/candidate2] - Broken link
`;
        const result = parseResearcherLinks(response);
        expect(result.cited).toHaveLength(2);
        expect(result.candidates).toHaveLength(2);
        expect(result.cited[0]!.url).toBe('https://example.com/article1');
        expect(result.candidates[0]!.url).toBe('https://example.com/candidate1');
      });

      it('should parse links without descriptions', () => {
        const response = `
### CITED LINKS
* [https://example.com/article1]
* [https://example.com/article2]
`;
        const result = parseResearcherLinks(response);
        expect(result.cited).toHaveLength(2);
        expect(result.cited[0]!.description).toBe('');
        expect(result.cited[1]!.description).toBe('');
      });

      it('should parse candidates without reasons', () => {
        const response = `
### SCRAPE CANDIDATES
* [https://example.com/candidate1]
* [https://example.com/candidate2]
`;
        const result = parseResearcherLinks(response);
        expect(result.candidates).toHaveLength(2);
        expect(result.candidates[0]!.reason).toBe('No reason provided');
        expect(result.candidates[1]!.reason).toBe('No reason provided');
      });

      it('should handle multiple links per section', () => {
        const response = `
### CITED LINKS
* [https://example.com/1] - First
* [https://example.com/2] - Second
* [https://example.com/3] - Third
* [https://example.com/4] - Fourth
* [https://example.com/5] - Fifth
`;
        const result = parseResearcherLinks(response);
        expect(result.cited).toHaveLength(5);
      });

      it('should handle markdown with extra whitespace', () => {
        const response = `

### CITED LINKS

* [https://example.com/article1] - Description

* [https://example.com/article2] - Another description

`;
        const result = parseResearcherLinks(response);
        expect(result.cited).toHaveLength(2);
        expect(result.cited[0]!.url).toBe('https://example.com/article1');
      });

      it('should parse alternative section header formats', () => {
        const response = `
#### CITED LINKS
* [https://example.com/article1] - Description
`;
        const result = parseResearcherLinks(response);
        expect(result.cited).toHaveLength(1);
      });

      it('should handle case-insensitive section headers', () => {
        const response = `
### cited links
* [https://example.com/article1] - Description

### Scrape Candidates
* [https://example.com/candidate1] - Not used
`;
        const result = parseResearcherLinks(response);
        expect(result.cited).toHaveLength(1);
        expect(result.candidates).toHaveLength(1);
      });
    });

    describe('negative cases', () => {
      it('should handle malformed link format', () => {
        const response = `
### CITED LINKS
* malformed link without brackets
* [https://example.com/article1] - This one is valid
`;
        const result = parseResearcherLinks(response);
        expect(result.cited).toHaveLength(1);
        expect(result.cited[0]!.url).toBe('https://example.com/article1');
      });

      it('should handle empty bullet points', () => {
        const response = `
### CITED LINKS
*
* [https://example.com/article1] - Valid link
`;
        const result = parseResearcherLinks(response);
        expect(result.cited).toHaveLength(1);
      });

      it('should handle response without sections', () => {
        const response = `
Some text about research
Another paragraph
`;
        const result = parseResearcherLinks(response);
        expect(result).toEqual({ cited: [], candidates: [] });
      });

      it('should throw on null input', () => {
        const response = null as any;
        expect(() => parseResearcherLinks(response)).toThrow(TypeError);
      });

      it('should throw on undefined input', () => {
        const response = undefined as any;
        expect(() => parseResearcherLinks(response)).toThrow(TypeError);
      });
    });

    describe('edge cases', () => {
      it('should handle very long URL', () => {
        const longUrl = 'https://example.com/' + 'a'.repeat(1000);
        const response = `
### CITED LINKS
* [${longUrl}] - Very long URL
`;
        const result = parseResearcherLinks(response);
        expect(result.cited).toHaveLength(1);
        expect(result.cited[0]!.url).toBe(longUrl);
      });

      it('should handle long description', () => {
        const longDesc = 'Description ' + 'text '.repeat(20);
        const response = `
### CITED LINKS
* [https://example.com/article] - ${longDesc}
`;
        const result = parseResearcherLinks(response);
        expect(result.cited).toHaveLength(1);
        expect(result.cited[0]!.description).toContain('Description');
        expect(result.cited[0]!.description.length).toBeGreaterThan(100);
      });

      it('should handle special characters in URLs', () => {
        const response = `
### CITED LINKS
* [https://example.com/path?query=1&param=test#fragment] - With query params
* [https://example.com/path with spaces] - With spaces
`;
        const result = parseResearcherLinks(response);
        expect(result.cited).toHaveLength(2);
      });

      it('should handle unicode characters', () => {
        const response = `
### CITED LINKS
* [https://example.com/日本語] - Japanese text
* [https://example.com/Тест] - Cyrillic text
`;
        const result = parseResearcherLinks(response);
        expect(result.cited).toHaveLength(2);
        expect(result.cited[0]!.url).toContain('日本語');
      });

      it('should handle mixed markdown formatting', () => {
        const response = `
## Research Results

### CITED LINKS
* [https://example.com/article1] - **Bold** and *italic* text

### SCRAPE CANDIDATES
* [https://example.com/candidate1] - Link with \`code\` block

More content here...
`;
        const result = parseResearcherLinks(response);
        expect(result.cited).toHaveLength(1);
        expect(result.candidates).toHaveLength(1);
      });
    });
  });

  describe('buildSharedLinksPool', () => {
    it('should build empty pool from empty map', () => {
      const responses = new Map<string, string>();
      const pool = buildSharedLinksPool(responses);
      expect(pool).toEqual({});
    });

    it('should build pool from single response', () => {
      const response = `
### CITED LINKS
* [https://example.com/article1] - Description
`;
      const responses = new Map([['1', response]]);
      const pool = buildSharedLinksPool(responses);
      expect(pool).toHaveProperty('1');
      expect(pool['1']!.cited).toHaveLength(1);
      expect(pool['1']!.cited[0]!.url).toBe('https://example.com/article1');
    });

    it('should build pool from multiple responses', () => {
      const response1 = `
### CITED LINKS
* [https://example.com/article1] - Description
`;
      const response2 = `
### CITED LINKS
* [https://example.com/article2] - Description
`;
      const responses = new Map([
        ['1', response1],
        ['2', response2],
      ]);
      const pool = buildSharedLinksPool(responses);
      expect(pool).toHaveProperty('1');
      expect(pool).toHaveProperty('2');
      expect(pool['1']!.cited).toHaveLength(1);
      expect(pool['2']!.cited).toHaveLength(1);
    });

    it('should preserve both cited and candidates', () => {
      const response = `
### CITED LINKS
* [https://example.com/article1] - Description

### SCRAPE CANDIDATES
* [https://example.com/candidate1] - Not used
`;
      const responses = new Map([['1', response]]);
      const pool = buildSharedLinksPool(responses);
      expect(pool['1']!.cited).toHaveLength(1);
      expect(pool['1']!.candidates).toHaveLength(1);
    });

    it('should handle empty responses', () => {
      const responses = new Map([
        ['1', ''],
        ['2', 'No links here'],
      ]);
      const pool = buildSharedLinksPool(responses);
      expect(pool['1']!.cited).toEqual([]);
      expect(pool['1']!.candidates).toEqual([]);
      expect(pool['2']!.cited).toEqual([]);
      expect(pool['2']!.candidates).toEqual([]);
    });
  });

  describe('saveSharedLinks and loadSharedLinks', () => {
    it('should save and load shared links pool', () => {
      const sessionId = generateSessionId('test');
      const pool = {
        '1': {
          cited: [{ url: 'https://example.com/article1', description: 'Description' }],
          candidates: [],
        },
      };

      saveSharedLinks(sessionId, pool);
      const loaded = loadSharedLinks(sessionId);

      expect(loaded).not.toBeNull();
      expect(loaded).toEqual(pool);
    });

    it('should return null for non-existent session', () => {
      const loaded = loadSharedLinks('non-existent-session');
      expect(loaded).toBeNull();
    });

    it('should handle empty pool', () => {
      const sessionId = generateSessionId('test');
      const pool = {};

      saveSharedLinks(sessionId, pool);
      const loaded = loadSharedLinks(sessionId);

      expect(loaded).toEqual({});
    });

    it('should handle complex pool', () => {
      const sessionId = generateSessionId('test');
      const pool = {
        '1': {
          cited: [
            { url: 'https://example.com/1', description: 'First' },
            { url: 'https://example.com/2', description: 'Second' },
          ],
          candidates: [
            { url: 'https://example.com/3', reason: 'Not used' },
          ],
        },
        '2': {
          cited: [
            { url: 'https://example.com/4', description: 'Another' },
          ],
          candidates: [],
        },
      };

      saveSharedLinks(sessionId, pool);
      const loaded = loadSharedLinks(sessionId);

      expect(loaded).toEqual(pool);
    });

    it('should save to correct file path', () => {
      const sessionId = 'test-session-abc1';
      const pool = {};

      saveSharedLinks(sessionId, pool);

      const expectedPath = `/tmp/research-links-${sessionId}.json`;
      expect(fs.existsSync(expectedPath)).toBe(true);

      // Cleanup
      if (fs.existsSync(expectedPath)) {
        fs.unlinkSync(expectedPath);
      }
    });
  });

  describe('cleanupSharedLinks', () => {
    it('should delete existing shared links file', () => {
      const sessionId = generateSessionId('test');
      const pool = {};

      saveSharedLinks(sessionId, pool);
      expect(loadSharedLinks(sessionId)).not.toBeNull();

      cleanupSharedLinks(sessionId);
      expect(loadSharedLinks(sessionId)).toBeNull();
    });

    it('should handle non-existent file', () => {
      const sessionId = 'non-existent-session';

      // Should not throw
      expect(() => cleanupSharedLinks(sessionId)).not.toThrow();
    });

    it('should handle file with special characters in session ID', () => {
      const sessionId = 'test-with_special.chars.123';
      const pool = {};

      saveSharedLinks(sessionId, pool);
      expect(loadSharedLinks(sessionId)).not.toBeNull();

      cleanupSharedLinks(sessionId);
      expect(loadSharedLinks(sessionId)).toBeNull();
    });
  });

  describe('formatSharedLinksForPrompt', () => {
    it('should return empty string for null pool', () => {
      const formatted = formatSharedLinksForPrompt(null);
      expect(formatted).toBe('');
    });

    it('should return empty string for empty pool', () => {
      const formatted = formatSharedLinksForPrompt({});
      expect(formatted).toBe('');
    });

    it('should format pool with cited links', () => {
      const pool = {
        '1': {
          cited: [
            { url: 'https://example.com/article1', description: 'Description' },
          ],
          candidates: [],
        },
      };

      const formatted = formatSharedLinksForPrompt(pool);

      expect(formatted).toContain('## Shared Links from Previous Research');
      expect(formatted).toContain('### Researcher 1');
      expect(formatted).toContain('### CITED LINKS');
      expect(formatted).toContain('https://example.com/article1');
      expect(formatted).toContain('Description');
      expect(formatted).toContain('Use this shared pool to avoid re-scraping');
    });

    it('should format pool with candidates', () => {
      const pool = {
        '1': {
          cited: [],
          candidates: [
            { url: 'https://example.com/candidate1', reason: 'Not used' },
          ],
        },
      };

      const formatted = formatSharedLinksForPrompt(pool);

      expect(formatted).toContain('### Researcher 1');
      expect(formatted).toContain('### SCRAPE CANDIDATES');
      expect(formatted).toContain('https://example.com/candidate1');
      expect(formatted).toContain('Not used');
    });

    it('should format pool with both cited and candidates', () => {
      const pool = {
        '1': {
          cited: [
            { url: 'https://example.com/article1', description: 'Used' },
          ],
          candidates: [
            { url: 'https://example.com/candidate1', reason: 'Not used' },
          ],
        },
      };

      const formatted = formatSharedLinksForPrompt(pool);

      expect(formatted).toContain('### CITED LINKS');
      expect(formatted).toContain('### SCRAPE CANDIDATES');
    });

    it('should format pool with multiple researchers', () => {
      const pool = {
        '1': {
          cited: [{ url: 'https://example.com/1', description: 'First' }],
          candidates: [],
        },
        '2': {
          cited: [{ url: 'https://example.com/2', description: 'Second' }],
          candidates: [],
        },
      };

      const formatted = formatSharedLinksForPrompt(pool);

      expect(formatted).toContain('### Researcher 1');
      expect(formatted).toContain('### Researcher 2');
    });

    it('should sort researchers numerically', () => {
      const pool = {
        '3': { cited: [], candidates: [] },
        '1': { cited: [], candidates: [] },
        '2': { cited: [], candidates: [] },
      };

      const formatted = formatSharedLinksForPrompt(pool);
      const researcher1Index = formatted.indexOf('### Researcher 1');
      const researcher2Index = formatted.indexOf('### Researcher 2');
      const researcher3Index = formatted.indexOf('### Researcher 3');

      expect(researcher1Index).toBeLessThan(researcher2Index);
      expect(researcher2Index).toBeLessThan(researcher3Index);
    });

    it('should format links without descriptions', () => {
      const pool = {
        '1': {
          cited: [{ url: 'https://example.com/article1', description: '' }],
          candidates: [],
        },
      };

      const formatted = formatSharedLinksForPrompt(pool);

      expect(formatted).toContain('* [https://example.com/article1]\n');
    });

    it('should indicate empty researcher', () => {
      const pool = {
        '1': {
          cited: [],
          candidates: [],
        },
      };

      const formatted = formatSharedLinksForPrompt(pool);

      expect(formatted).toContain('*No links reported*');
    });

    it('should handle special characters in URLs', () => {
      const pool = {
        '1': {
          cited: [
            { url: 'https://example.com/path?query=1&param=test#fragment', description: 'Special chars' },
          ],
          candidates: [],
        },
      };

      const formatted = formatSharedLinksForPrompt(pool);

      expect(formatted).toContain('https://example.com/path?query=1&param=test#fragment');
    });

    it('should handle unicode in descriptions', () => {
      const pool = {
        '1': {
          cited: [
            { url: 'https://example.com/article', description: '日本語 text with Тест and emoji 🎉' },
          ],
          candidates: [],
        },
      };

      const formatted = formatSharedLinksForPrompt(pool);

      expect(formatted).toContain('日本語');
      expect(formatted).toContain('Тест');
      expect(formatted).toContain('🎉');
    });
  });

  describe('getSharedLinksSummary', () => {
    it('should return message for null pool', () => {
      const summary = getSharedLinksSummary(null);
      expect(summary).toBe('No shared links yet');
    });

    it('should return message for empty pool', () => {
      const summary = getSharedLinksSummary({});
      expect(summary).toBe('No shared links yet');
    });

    it('should summarize pool with cited links', () => {
      const pool = {
        '1': {
          cited: [
            { url: 'https://example.com/1', description: 'First' },
            { url: 'https://example.com/2', description: 'Second' },
          ],
          candidates: [],
        },
      };

      const summary = getSharedLinksSummary(pool);

      expect(summary).toBe('1 researcher(s), 2 cited, 0 candidate(s)');
    });

    it('should summarize pool with candidates', () => {
      const pool = {
        '1': {
          cited: [],
          candidates: [
            { url: 'https://example.com/1', reason: 'Not used' },
            { url: 'https://example.com/2', reason: 'Not used' },
          ],
        },
      };

      const summary = getSharedLinksSummary(pool);

      expect(summary).toBe('1 researcher(s), 0 cited, 2 candidate(s)');
    });

    it('should summarize pool with multiple researchers', () => {
      const pool = {
        '1': {
          cited: [{ url: 'https://example.com/1', description: 'First' }],
          candidates: [],
        },
        '2': {
          cited: [{ url: 'https://example.com/2', description: 'Second' }],
          candidates: [],
        },
      };

      const summary = getSharedLinksSummary(pool);

      expect(summary).toBe('2 researcher(s), 2 cited, 0 candidate(s)');
    });

    it('should aggregate counts across researchers', () => {
      const pool = {
        '1': {
          cited: [{ url: 'https://example.com/1', description: 'First' }],
          candidates: [
            { url: 'https://example.com/2', reason: 'Not used' },
          ],
        },
        '2': {
          cited: [
            { url: 'https://example.com/3', description: 'Second' },
            { url: 'https://example.com/4', description: 'Third' },
          ],
          candidates: [],
        },
      };

      const summary = getSharedLinksSummary(pool);

      expect(summary).toBe('2 researcher(s), 3 cited, 1 candidate(s)');
    });

    it('should handle researcher with no links', () => {
      const pool = {
        '1': {
          cited: [],
          candidates: [],
        },
        '2': {
          cited: [{ url: 'https://example.com/1', description: 'First' }],
          candidates: [],
        },
      };

      const summary = getSharedLinksSummary(pool);

      expect(summary).toBe('2 researcher(s), 1 cited, 0 candidate(s)');
    });
  });
});
