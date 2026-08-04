import { describe, it, expect } from 'vitest';
import { normalizeCitations, formatCitedLinks } from '../../../src/utils/citation-utils';

describe('citation-utils', () => {
  describe('normalizeCitations', () => {
    it('should normalize citations across multiple reports and deduplicate URLs', () => {
      const reports = new Map([
        ['res1', 'Findings in report 1 [1].\n\nCITED LINKS\n[1] https://example.com — Source A'],
        ['res2', 'Findings in report 2 [1] and [2].\n\nCITED LINKS\n[1] https://example.com — Source A\n[2] https://google.com — Search engine']
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
      expect(norm1).not.toContain('CITED LINKS');

      // Verify report 2 normalization
      const norm2 = normalizedReports.get('res2');
      expect(norm2).toContain('Findings in report 2 [1] and [2].');
      expect(norm2).not.toContain('CITED LINKS');
    });

    it('does not let a malformed URL fragment take a global ID slot (regression)', () => {
      // res1's first CITED LINKS line is a soft-wrapped fragment "https://www".
      // It must be dropped so the real first source keeps global id 1 and the
      // inline [1] in the body still resolves to the real source.
      const reports = new Map([
        ['res1', 'Geography point [1].\n\nCITED LINKS\n[1] https://www\n[2] https://geo.example.com — Geography'],
      ]);

      const { normalizedReports, globalCitations } = normalizeCitations(reports);

      expect(globalCitations).toHaveLength(1);
      expect(globalCitations[0]!.url).toBe('https://geo.example.com');
      // The body's [1] should NOT survive as a dangling reference to a garbage
      // entry — there is no global id for the dropped fragment.
      expect(globalCitations.some(c => c.url === 'https://www')).toBe(false);
      expect(normalizedReports.get('res1')).not.toContain('https://www');
    });

    /**
     * Regression guard for a silent misattribution bug.
     *
     * An unmapped marker used to be left verbatim. Because global ids are assigned
     * densely from 1, a surviving `[1]` stops meaning "this report's first source"
     * and instead resolves against the RENUMBERED global list — pointing at an
     * unrelated document. The normalized body feeds the synthesis prompt, which is
     * told the numbering is already global, so the model reproduces the wrong
     * attribution and the regenerated CITED LINKS looks consistent with it.
     *
     * The prior assertion in the test above ("not.toContain('https://www')") could
     * never catch this: it is structurally guaranteed by the CITED-LINKS slice
     * regardless of how markers are handled.
     */
    it('drops a dangling marker instead of silently retargeting it at another source', () => {
      const reports = new Map([
        [
          'res1',
          'Finding A is supported by evidence [1]. Finding B is separate [2].\n\n' +
            'CITED LINKS\n' +
            '[1] http://localhost:8080/internal — dropped: hostname has no dot\n' +
            '[2] https://example.com/real-source — Real',
        ],
      ]);

      const { normalizedReports, globalCitations } = normalizeCitations(reports);
      const body = normalizedReports.get('res1')!;

      // Only the plausible URL survives, and it becomes global [1].
      expect(globalCitations).toHaveLength(1);
      expect(globalCitations[0]!.url).toBe('https://example.com/real-source');

      // Finding B keeps its (remapped) citation...
      expect(body).toContain('Finding B is separate [1].');
      // ...and Finding A must NOT have inherited it. Before the fix this read
      // "Finding A is supported by evidence [1]." — citing a source that never
      // supported it.
      expect(body).toContain('Finding A is supported by evidence.');
      expect(body).not.toMatch(/evidence\s*\[1\]/);
    });

    it('leaves bracketed integers inside code spans alone when dropping dangling markers', () => {
      const reports = new Map([
        [
          'res1',
          'Use `items[12]` to index.\n\n```js\nconst x = arr[7];\n```\n\nReal cite [1].\n\n' +
            'CITED LINKS\n[1] https://example.com/a — A',
        ],
      ]);

      const body = normalizeCitations(reports).normalizedReports.get('res1')!;
      expect(body).toContain('`items[12]`');
      expect(body).toContain('arr[7]');
      expect(body).toContain('Real cite [1].');
    });

    it('should handle different local IDs for the same URL', () => {
      const reports = new Map([
        ['res1', 'Info [1].\n\nCITED LINKS\n[1] https://common.com — Common'],
        ['res2', 'Info [2].\n\nCITED LINKS\n[1] https://other.com — Other\n[2] https://common.com — Common']
      ]);

      const { normalizedReports, globalCitations } = normalizeCitations(reports);

      // https://common.com should have global ID 1 (first seen in res1)
      // https://other.com should have global ID 2 (first seen in res2)
      expect(globalCitations).toHaveLength(2);
      const commonId = globalCitations.find(c => c.url === 'https://common.com')?.id;
      expect(normalizedReports.get('res1')).toContain(`Info [${commonId}].`);
      expect(normalizedReports.get('res2')).toContain(`Info [${commonId}].`);
    });

    it('remaps inline [N] by the written label, not list position (non-sequential numbering)', () => {
      // res1 numbers its CITED LINKS non-sequentially: [1] then [3] (no [2]). The inline [3] must
      // map to its written entry (https://third.com), not dangle. With the old position-based
      // mapping only keys 1 and 2 existed, so [3] was left unmapped.
      const reports = new Map([
        ['res1', 'A [1] and C [3].\n\nCITED LINKS\n[1] https://first.com — First\n[3] https://third.com — Third'],
      ]);
      const { normalizedReports, globalCitations } = normalizeCitations(reports);
      const firstId = globalCitations.find(c => c.url === 'https://first.com')?.id;
      const thirdId = globalCitations.find(c => c.url === 'https://third.com')?.id;
      expect(firstId).toBeDefined();
      expect(thirdId).toBeDefined();
      expect(normalizedReports.get('res1')).toContain(`A [${firstId}] and C [${thirdId}].`);
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
        ['res1', 'Multi-cite [1][2].\n\nCITED LINKS\n[1] https://a.com\n[2] https://b.com']
      ]);

      const { normalizedReports } = normalizeCitations(reports);
      expect(normalizedReports.get('res1')).toContain('Multi-cite [1][2].');
    });

    it('should handle URL normalization variations', () => {
      const reports = new Map([
        ['res1', 'Link [1].\n\nCITED LINKS\n[1] https://example.com/'],
        ['res2', 'Link [1].\n\nCITED LINKS\n[1] https://example.com']
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
      expect(formatted).toContain('CITED LINKS');
      expect(formatted).not.toContain('###');
      expect(formatted).toContain('[1] https://a.com [Source: Src A] — Desc A');
      expect(formatted).toContain('[2] https://b.com — Desc B');
    });

    it('should return empty string for empty list', () => {
      expect(formatCitedLinks([])).toBe('');
    });
  });
});
