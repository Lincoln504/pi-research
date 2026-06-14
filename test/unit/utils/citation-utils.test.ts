import { describe, it, expect } from 'vitest';
import { normalizeCitations, formatCitedLinks } from '../../../src/utils/citation-utils';

describe('citation-utils', () => {
  describe('normalizeCitations', () => {
    it('should normalize citations across multiple reports and deduplicate URLs', () => {
      const reports = new Map([
        ['res1', 'Findings in report 1 [1].\n\n### CITED LINKS\n[1] https://example.com — Source A'],
        ['res2', 'Findings in report 2 [1] and [2].\n\n### CITED LINKS\n[1] https://example.com — Source A\n[2] https://google.com — Search engine']
      ]);

      const { normalizedReports, globalCitations } = normalizeCitations(reports);

      // Verify global citations
      expect(globalCitations).toHaveLength(2);
      expect(globalCitations[0]!.url).toBe('https://example.com');
      expect(globalCitations[0]!.id).toBe(1);
      expect(globalCitations[1].url).toBe('https://google.com');
      expect(globalCitations[1].id).toBe(2);

      // Verify report 1 normalization
      const norm1 = normalizedReports.get('res1');
      expect(norm1).toContain('Findings in report 1 [1].');
      expect(norm1).not.toContain('### CITED LINKS');

      // Verify report 2 normalization
      const norm2 = normalizedReports.get('res2');
      expect(norm2).toContain('Findings in report 2 [1] and [2].');
      expect(norm2).not.toContain('### CITED LINKS');
    });

    it('should handle different local IDs for the same URL', () => {
      const reports = new Map([
        ['res1', 'Info [1].\n\n### CITED LINKS\n[1] https://common.com — Common'],
        ['res2', 'Info [2].\n\n### CITED LINKS\n[1] https://other.com — Other\n[2] https://common.com — Common']
      ]);

      const { normalizedReports, globalCitations } = normalizeCitations(reports);

      // https://common.com should have global ID 1 (first seen in res1)
      // https://other.com should have global ID 2 (first seen in res2)
      expect(globalCitations).toHaveLength(2);
      const commonId = globalCitations.find(c => c.url === 'https://common.com')?.id;
      expect(normalizedReports.get('res1')).toContain(`Info [${commonId}].`);
      expect(normalizedReports.get('res2')).toContain(`Info [${commonId}].`);
    });

    it('should handle missing CITED LINKS section gracefully', () => {
      const reports = new Map([
        ['res1', 'No citations here.']
      ]);

      const { normalizedReports, globalCitations } = normalizeCitations(reports);

      expect(globalCitations).toHaveLength(0);
      expect(normalizedReports.get('res1')).toBe('No citations here.');
    });

    it('should handle [N][M] combinations', () => {
      const reports = new Map([
        ['res1', 'Multi-cite [1][2].\n\n### CITED LINKS\n[1] https://a.com\n[2] https://b.com']
      ]);

      const { normalizedReports } = normalizeCitations(reports);
      expect(normalizedReports.get('res1')).toContain('Multi-cite [1][2].');
    });

    it('should handle URL normalization variations', () => {
      const reports = new Map([
        ['res1', 'Link [1].\n\n### CITED LINKS\n[1] https://example.com/'],
        ['res2', 'Link [1].\n\n### CITED LINKS\n[1] https://example.com']
      ]);

      const { globalCitations } = normalizeCitations(reports);
      // Both should map to the same global citation
      expect(globalCitations).toHaveLength(1);
    });
  });

  describe('formatCitedLinks', () => {
    it('should format global citations into a string', () => {
      const citations = [
        { id: 1, url: 'https://a.com', description: 'Desc A', source: 'Src A' },
        { id: 2, url: 'https://b.com', description: 'Desc B' }
      ];

      const formatted = formatCitedLinks(citations);
      expect(formatted).toContain('### CITED LINKS');
      expect(formatted).toContain('[1] https://a.com [Source: Src A] — Desc A');
      expect(formatted).toContain('[2] https://b.com — Desc B');
    });

    it('should return empty string for empty list', () => {
      expect(formatCitedLinks([])).toBe('');
    });
  });
});
