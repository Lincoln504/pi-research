import { describe, it, expect, beforeEach } from 'vitest';
import { ResearchSynthesisService } from '../../../src/orchestration/research-synthesis-service.ts';
import { ServiceLifecycle } from '../../../src/core/service-registry.ts';
import { registerScrapedLinks, registerTranscribedLinks, clearAllSharedLinks } from '../../../src/utils/shared-links.ts';

// Suppress logger output during tests
import { vi } from 'vitest';
vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Helper: build a report string with a CITED LINKS section parseable by parseCitations
function reportWithCitations(urls: { url: string; desc?: string }[]): string {
  const lines = urls.map((u, i) => `[${i + 1}] ${u.url}${u.desc ? ` - ${u.desc}` : ''}`).join('\n');
  return `Some report content.\n\nCITED LINKS\n${lines}`;
}

// Helper: build a report whose CITED LINKS entries carry an explicit `Source:` tag
// (the inline `URL [Source: X] - desc` form parseCitations understands).
function reportWithSourcedCitations(entries: { url: string; source: string; desc?: string }[]): string {
  const lines = entries.map((u, i) => `[${i + 1}] ${u.url} [Source: ${u.source}]${u.desc ? ` - ${u.desc}` : ''}`).join('\n');
  return `Some report content.\n\nCITED LINKS\n${lines}`;
}

describe('ResearchSynthesisService', () => {
  let service: ResearchSynthesisService;

  beforeEach(() => {
    service = new ResearchSynthesisService();
    // The scrape-provenance registry is a module-level singleton — isolate tests.
    clearAllSharedLinks();
  });

  // ─── storeReport / getReport ────────────────────────────────────────────────

  describe('storeReport / getReport', () => {
    it('stores a report and retrieves it by ID', () => {
      service.storeReport('test-session', '1.A', 'Report A content');
      expect(service.getReport('test-session', '1.A')).toBe('Report A content');
    });

    it('returns undefined for a report ID that does not exist', () => {
      expect(service.getReport('test-session', '99.Z')).toBeUndefined();
    });

    it('overwrites an existing report when the same ID is stored again', () => {
      service.storeReport('test-session', '1.A', 'original');
      service.storeReport('test-session', '1.A', 'replacement');
      expect(service.getReport('test-session', '1.A')).toBe('replacement');
    });
  });

  // ─── getAllReports ───────────────────────────────────────────────────────────

  describe('getAllReports', () => {
    it('returns a copy of the internal map; mutating it does not affect the service', () => {
      service.storeReport('test-session', '1.A', 'report A');
      const copy = service.getAllReports('test-session');
      copy.set('1.A', 'mutated');
      copy.set('2.B', 'injected');
      // Original is unaffected
      expect(service.getReport('test-session', '1.A')).toBe('report A');
      expect(service.getReport('test-session', '2.B')).toBeUndefined();
    });
  });

  // ─── getReportsForRound ──────────────────────────────────────────────────────

  describe('getReportsForRound', () => {
    it('returns only the reports for the requested round', () => {
      service.storeReport('test-session', '1.A', 'r1a');
      service.storeReport('test-session', '1.B', 'r1b');
      service.storeReport('test-session', '2.A', 'r2a');

      const round1 = service.getReportsForRound('test-session', 1);
      expect(round1.size).toBe(2);
      expect(round1.get('1.A')).toBe('r1a');
      expect(round1.get('1.B')).toBe('r1b');
      expect(round1.has('2.A')).toBe(false);
    });

    it('returns an empty map when no reports exist for the round', () => {
      service.storeReport('test-session', '2.A', 'r2a');
      expect(service.getReportsForRound('test-session', 5).size).toBe(0);
    });

    it('does not include a key starting with "10" in round 1 results (prefix-match safeguard)', () => {
      service.storeReport('test-session', '1.A', 'round-one');
      service.storeReport('test-session', '10.A', 'round-ten');

      const round1 = service.getReportsForRound('test-session', 1);
      expect(round1.has('1.A')).toBe(true);
      expect(round1.has('10.A')).toBe(false);
    });
  });

  // ─── getReportCount / hasReports ────────────────────────────────────────────

  describe('getReportCount / hasReports', () => {
    it('returns count 0 and hasReports false on a fresh instance', () => {
      expect(service.getReportCount('test-session')).toBe(0);
      expect(service.hasReports('test-session')).toBe(false);
    });

    it('returns count 1 and hasReports true after storing one report', () => {
      service.storeReport('test-session', '1.A', 'content');
      expect(service.getReportCount('test-session')).toBe(1);
      expect(service.hasReports('test-session')).toBe(true);
    });
  });

  // ─── clearReports ───────────────────────────────────────────────────────────

  describe('clearReports', () => {
    it('removes all stored reports; count returns to 0', () => {
      service.storeReport('test-session', '1.A', 'a');
      service.storeReport('test-session', '1.B', 'b');
      service.clearReports();
      expect(service.getReportCount('test-session')).toBe(0);
      expect(service.hasReports('test-session')).toBe(false);
    });
  });

  // ─── buildFallbackSynthesis ──────────────────────────────────────────────────

  describe('buildFallbackSynthesis', () => {
    it('contains the "no reports" message when there are no reports', () => {
      const synthesis = service.buildFallbackSynthesis('test-session');
      expect(synthesis).toContain('No researcher reports were generated');
    });

    it('contains both researcher IDs and report contents when there are 2 reports', () => {
      service.storeReport('test-session', '1.A', 'Alpha report content');
      service.storeReport('test-session', '1.B', 'Beta report content');
      const synthesis = service.buildFallbackSynthesis('test-session');
      expect(synthesis).toContain('1.A');
      expect(synthesis).toContain('Alpha report content');
      expect(synthesis).toContain('1.B');
      expect(synthesis).toContain('Beta report content');
      expect(synthesis).toContain('automated synthesis');
    });

    it('contains "Round 2" when currentRound is 2', () => {
      const synthesis = service.buildFallbackSynthesis('test-session', 2);
      expect(synthesis).toContain('Round 2');
    });

    it('does NOT contain "Round 0" when currentRound defaults to 0', () => {
      const synthesis = service.buildFallbackSynthesis('test-session');
      expect(synthesis).not.toContain('Round 0');
    });
  });

  // ─── ensureCitedLinks ────────────────────────────────────────────────────────

  describe('ensureCitedLinks', () => {
    it('leaves the synthesis body intact when no reports are stored', () => {
      const input = 'Some findings.\n\nCITED LINKS\n[1] https://example.com - desc';
      const result = service.ensureCitedLinks('test-session', input);
      // Body and links preserved verbatim; only the unverified caveat is added
      // (nothing was retrieved this session, so nothing in it was checked).
      expect(result.startsWith(input)).toBe(true);
      expect(result).toContain('None of the links above could be verified');
    });

    it('appends a CITED LINKS section built from report URLs when missing', () => {
      service.storeReport('test-session', 
        '1.A',
        reportWithCitations([
          { url: 'https://example.org/page', desc: 'example site' },
          { url: 'https://another.org/page', desc: 'other site' },
        ])
      );
      const result = service.ensureCitedLinks('test-session', 'Synthesis without links.');
      expect(result).toContain('CITED LINKS');
      expect(result).not.toContain('###');
      expect(result).toContain('https://example.org/page');
      expect(result).toContain('https://another.org/page');
    });

    it('rebuilds CITED LINKS from scrape provenance when the report has no parseable citations', () => {
      // The researcher actually fetched two pages but its report omitted/mangled the
      // CITED LINKS block — the sources must still survive via the provenance registry.
      service.storeReport('test-session', '1.A', 'A report whose author forgot to format a CITED LINKS section.');
      registerScrapedLinks('test-session', ['https://provenance.org/a', 'https://provenance.org/b']);

      const result = service.ensureCitedLinks('test-session', 'Synthesis without links.');
      expect(result).toContain('CITED LINKS');
      expect(result).toContain('https://provenance.org/a');
      expect(result).toContain('https://provenance.org/b');
    });

    it('labels transcript-sourced URLs "YouTube Transcript" (not "Scrape") in the provenance fallback', () => {
      // Log-verified failure (Jul 4 Lebanon run): the researcher's CITED LINKS
      // block was unparseable, and the fallback relabeled the transcript's watch
      // URL — the report's actual source material — as [Source: Scrape].
      service.storeReport('test-session', '1.A', 'A transcript-grounded report with an unparseable citation block.');
      registerScrapedLinks('test-session', ['https://provenance.org/page', 'https://www.youtube.com/watch?v=KVEXmiAL2Q0']);
      registerTranscribedLinks('test-session', ['https://www.youtube.com/watch?v=KVEXmiAL2Q0']);

      const result = service.ensureCitedLinks('test-session', 'Synthesis without links.');
      const lines = result.split('\n');
      const ytIdx = lines.findIndex((l) => l.includes('watch?v=KVEXmiAL2Q0'));
      const pageIdx = lines.findIndex((l) => l.includes('provenance.org/page'));
      expect(ytIdx).toBeGreaterThan(-1);
      expect(lines.slice(ytIdx, ytIdx + 2).join('\n')).toContain('YouTube Transcript');
      expect(lines.slice(pageIdx, pageIdx + 2).join('\n')).toContain('Scrape');
    });

    it('folds in a second researcher\'s YouTube transcript source even when a first researcher cited normally (multi-researcher partial-citation regression)', () => {
      // Regression: the provenance fallback used to only run when globalCitations
      // was entirely empty (every researcher failed to cite), so a second
      // researcher's uncited YouTube transcript source was silently dropped
      // whenever a sibling researcher's report DID parse normally.
      service.storeReport(
        'test-session',
        '1.A',
        reportWithCitations([{ url: 'https://example.org/page', desc: 'cited normally' }]),
      );
      service.storeReport('test-session', '1.B', 'A transcript-grounded report with no parseable citation block.');
      registerScrapedLinks('test-session', ['https://example.org/page', 'https://www.youtube.com/watch?v=abc123']);
      registerTranscribedLinks('test-session', ['https://www.youtube.com/watch?v=abc123']);

      const result = service.ensureCitedLinks('test-session', 'Synthesis without links.');
      expect(result).toContain('https://example.org/page');
      expect(result).toContain('watch?v=abc123');
      const lines = result.split('\n');
      const ytIdx = lines.findIndex((l) => l.includes('watch?v=abc123'));
      expect(lines.slice(ytIdx, ytIdx + 2).join('\n')).toContain('YouTube Transcript');
    });

    it('does not duplicate a URL that is already covered by a parsed citation', () => {
      service.storeReport(
        'test-session',
        '1.A',
        reportWithCitations([{ url: 'https://example.org/page', desc: 'cited normally' }]),
      );
      registerScrapedLinks('test-session', ['https://example.org/page']);

      const result = service.ensureCitedLinks('test-session', 'Synthesis without links.');
      const occurrences = result.split('example.org/page').length - 1;
      expect(occurrences).toBe(1);
    });

    it('appends an explicit no-sources note when neither citations nor scrape provenance exist', () => {
      service.storeReport('test-session', '1.A', 'A report with no citation section at all.');
      const input = 'Synthesis without links.';
      const result = service.ensureCitedLinks('test-session', input);
      expect(result).toContain('CITED LINKS');
      expect(result).toContain('No web sources were successfully retrieved');
    });

    it('preserves an existing (unparseable) CITED LINKS block, but flags it as unverified', () => {
      // No reports, no provenance, but the synthesis already carries a links block:
      // never destroy what the model wrote — and never ship it as though the engine
      // had checked it, because reaching here means nothing was retrieved at all.
      const input = 'Some findings.\n\nCITED LINKS\n[1] https://example.com - desc';
      const result = service.ensureCitedLinks('test-session', input);
      expect(result.startsWith(input)).toBe(true);
      expect(result).toContain('https://example.com'); // block intact
      expect(result).toContain('None of the links above could be verified');
    });

    it('remaps inline [N] markers when the rebuilt list renumbers entries (quick-mode desync)', () => {
      // Quick mode: the synthesis IS the single report. Its own list numbers a
      // duplicate URL as [1] and [2]; dedup collapses them, shifting [3] → [2].
      const report = [
        'Fact from the first source [1]. Same source again [2]. Fact from the other source [3].',
        '',
        'CITED LINKS',
        '[1] https://dup.example.com/page',
        'Source: Scrape',
        'Description: First listing of the page.',
        '[2] https://dup.example.com/page',
        'Source: Scrape',
        'Description: Duplicate listing of the same page.',
        '[3] https://unique.example.com/other',
        'Source: Scrape',
        'Description: A different page.',
      ].join('\n');
      service.storeReport('test-session', '1.A', report);

      const result = service.ensureCitedLinks('test-session', report);
      const [body = '', links = ''] = result.split(/^CITED LINKS$/m);
      // The rebuilt list has exactly two entries…
      expect(links).toContain('[1] https://dup.example.com/page');
      expect(links).toContain('[2] https://unique.example.com/other');
      expect(links).not.toContain('[3]');
      // …and the body's marker for the unique source follows the renumbering.
      expect(body).toContain('Fact from the other source [2].');
      expect(body).not.toContain('[3]');
    });

    // ─── Citation preservation (was: provenance gate) ───────────────────────
    // A previous "provenance gate" DROPPED Scrape/Transcript-tagged citations whose
    // URL was absent from the successful-scrape pool. It was removed because it
    // conflated a failed/blocked scrape (real URL, content unretrieved) with
    // fabrication and, under the common high scrape-failure rate, mass-dropped
    // legitimate citations — then the remap turned their inline [N] markers into a
    // broken '[removed]' token. Citations are now KEPT (deduped by URL) and
    // '[removed]' is never emitted. These tests guard that behavior.

    it('KEEPS a Scrape-tagged citation even when its URL is absent from the scrape pool (failed/blocked scrapes are not treated as fabrication)', () => {
      // Regression guard for the '[removed]' regression. A real source the researcher
      // fetched, plus a real URL whose scrape was bot-blocked (absent from the pool).
      // Both must survive — a failed scrape is not fabrication — and no '[removed]'.
      service.storeReport(
        'test-session',
        '1.A',
        reportWithSourcedCitations([
          { url: 'https://real.example.com/a', source: 'Scrape', desc: 'a real source' },
          { url: 'https://blocked.example.com/page', source: 'Scrape', desc: 'a real URL whose scrape was bot-blocked' },
        ]),
      );
      registerScrapedLinks('test-session', ['https://real.example.com/a']);

      const result = service.ensureCitedLinks('test-session', 'Findings [1][2].');
      // BOTH citations survive into the shipped CITED LINKS.
      expect(result).toContain('https://real.example.com/a');
      expect(result).toContain('https://blocked.example.com/page');
      // No '[removed]' token ever reaches the output.
      expect(result).not.toContain('[removed]');
    });

    it('keeps an untagged citation even when it is absent from the scrape pool (conservative, avoids false positives)', () => {
      // A weak model may omit the Source tag on a real citation; dropping it would
      // be a false positive. The gate only targets EXPLICIT scrape/transcript
      // claims, so an untagged citation survives.
      service.storeReport(
        'test-session',
        '1.A',
        reportWithCitations([{ url: 'https://untagged.example.com/page', desc: 'no source tag' }]),
      );
      // Pool non-empty (so the gate is armed) but does NOT contain this URL.
      registerScrapedLinks('test-session', ['https://other.example.com/real']);

      const result = service.ensureCitedLinks('test-session', 'Findings [1].');
      expect(result).toContain('https://untagged.example.com/page');
    });

    it('keeps a Knowledge-Store-tagged citation absent from the scrape pool (external provenance is trusted on its tag)', () => {
      // Knowledge-store URLs come from a prior session's index, not this session's
      // scrape pool, so they are legitimately outside it; the tag attests the source.
      service.storeReport(
        'test-session',
        '1.A',
        reportWithSourcedCitations([
          { url: 'https://ks.example.com/entry', source: 'Project Knowledge Store', desc: 'prior-session finding' },
        ]),
      );
      registerScrapedLinks('test-session', ['https://real.example.com/a']);

      const result = service.ensureCitedLinks('test-session', 'Findings [1].');
      expect(result).toContain('https://ks.example.com/entry');
    });

    it('does not enforce the provenance gate when the scrape pool is empty (no baseline to check against)', () => {
      // No scraping was simulated, so there is no provenance baseline. A
      // Scrape-tagged citation must survive in that case (mirrors the original
      // trusting behavior and keeps unit tests that don't simulate scraping valid).
      service.storeReport(
        'test-session',
        '1.A',
        reportWithSourcedCitations([{ url: 'https://tagged.example.com/page', source: 'Scrape' }]),
      );
      // NOTE: no registerScrapedLinks call → empty pool.

      const result = service.ensureCitedLinks('test-session', 'Findings [1].');
      expect(result).toContain('https://tagged.example.com/page');
    });

    it('never emits "[removed]"; citations absent from the scrape pool are kept, not neutralized', () => {
      // Regression guard: the body cites a real [1] (scraped) and a [2] whose scrape
      // was blocked (absent from the pool). Previously the provenance gate dropped
      // [2] and the remap turned its inline marker into '[removed]'. Now [2] is KEPT
      // and no '[removed]' ships; both inline markers are remapped intact.
      const report = [
        'Fact from the real source [1]. Fact from the blocked-scrape source [2].',
        '',
        'CITED LINKS',
        '[1] https://real.example.com/a [Source: Scrape]',
        'Description: a real source.',
        '[2] https://blocked.example.com/page [Source: Scrape]',
        'Description: a real URL whose scrape was bot-blocked.',
      ].join('\n');
      service.storeReport('test-session', '1.A', report);
      registerScrapedLinks('test-session', ['https://real.example.com/a']);

      const result = service.ensureCitedLinks('test-session', report);
      // No '[removed]' token ever reaches the output.
      expect(result).not.toContain('[removed]');
      // Both citations survive (a failed scrape is not fabrication)...
      expect(result).toContain('https://real.example.com/a');
      expect(result).toContain('https://blocked.example.com/page');
      // ...and both inline markers are intact (remapped to their rebuilt numbers).
      expect(result).toContain('Fact from the real source [1].');
      expect(result).toContain('Fact from the blocked-scrape source [2].');
    });

    // ─── Prose URL sweep (Gap 2b) ─────────────────────────────────────────────
    // The synthesis body is otherwise passed through verbatim; an inline URL not
    // present in the verified source set is the one channel by which a fabricated
    // source can still reach the user, so it is redacted with a visible marker.

    it('redacts an unverified inline URL in the synthesis prose', () => {
      service.storeReport(
        'test-session',
        '1.A',
        reportWithSourcedCitations([{ url: 'https://real.example.com/a', source: 'Scrape' }]),
      );
      registerScrapedLinks('test-session', ['https://real.example.com/a']);
      // No existing CITED LINKS header → append path; prose has one verified and
      // one fabricated inline URL.
      const synthesis =
        'According to https://research-results-placeholder.com the value is high. See https://real.example.com/a for details.';

      const result = service.ensureCitedLinks('test-session', synthesis);
      expect(result).not.toContain('research-results-placeholder.com');
      expect(result).toContain('[link removed: not found in retrieved sources]');
      // The verified inline URL survives untouched.
      expect(result).toContain('https://real.example.com/a');
      expect(result).toContain('CITED LINKS');
    });

    it('redacts an unverified inline URL in the body even when a CITED LINKS section is present', () => {
      // Deep-mode shape: a prose body, then a CITED LINKS header. The fabricated
      // URL sits in the body (not the links section) and must be redacted while the
      // verified section is rebuilt untouched.
      service.storeReport(
        'test-session',
        '1.A',
        reportWithSourcedCitations([{ url: 'https://real.example.com/a', source: 'Scrape' }]),
      );
      registerScrapedLinks('test-session', ['https://real.example.com/a']);
      const synthesis = [
        'Findings: the value is high per https://research-results-placeholder.com [1].',
        '',
        'CITED LINKS',
        '[1] https://real.example.com/a [Source: Scrape] — real source',
      ].join('\n');

      const result = service.ensureCitedLinks('test-session', synthesis);
      expect(result).not.toContain('research-results-placeholder.com');
      expect(result).toContain('[link removed: not found in retrieved sources]');
      // The verified CITED LINKS section is rebuilt and intact.
      expect(result).toContain('[1] https://real.example.com/a');
    });

    it('preserves a verified inline URL in prose (no false-positive redaction)', () => {
      service.storeReport(
        'test-session',
        '1.A',
        reportWithSourcedCitations([{ url: 'https://real.example.com/a', source: 'Scrape' }]),
      );
      registerScrapedLinks('test-session', ['https://real.example.com/a']);
      const synthesis = 'See https://real.example.com/a and https://real.example.com/a again.';

      const result = service.ensureCitedLinks('test-session', synthesis);
      // Both occurrences of the verified URL survive; nothing is redacted.
      expect(result).not.toContain('[link removed');
      expect(result.split('https://real.example.com/a').length - 1).toBeGreaterThanOrEqual(2);
    });

    // ─── Markdown structure preservation ──────────────────────────────────────
    // The marker-rewrite pass once ended in a blanket `replace(/  +/g, ' ')` to tidy
    // the gap left by a deleted [N]. Being unanchored it also ate LEADING whitespace,
    // so every nesting level collapsed to one space and 4-space indented code blocks
    // stopped being code — silent structural corruption of essentially every report.

    it('preserves nested list indentation and indented code blocks in the body', () => {
      service.storeReport(
        'test-session',
        '1.A',
        reportWithSourcedCitations([{ url: 'https://real.example.com/a', source: 'Scrape' }]),
      );
      registerScrapedLinks('test-session', ['https://real.example.com/a']);
      const synthesis = [
        '## Findings',
        '',
        '- Top level [1]',
        '  - Nested two spaces',
        '    - Deeper four spaces',
        '',
        '    indented code line',
        '',
        'CITED LINKS',
        '[1] https://real.example.com/a [Source: Scrape]',
      ].join('\n');

      const result = service.ensureCitedLinks('test-session', synthesis);
      expect(result).toContain('  - Nested two spaces');
      expect(result).toContain('    - Deeper four spaces');
      expect(result).toContain('    indented code line');
    });

    it('preserves indentation on the append path too (no CITED LINKS header)', () => {
      service.storeReport(
        'test-session',
        '1.A',
        reportWithSourcedCitations([{ url: 'https://real.example.com/a', source: 'Scrape' }]),
      );
      registerScrapedLinks('test-session', ['https://real.example.com/a']);
      const synthesis = ['- Top level [1]', '  - Nested two spaces', '    - Deeper four spaces'].join('\n');

      const result = service.ensureCitedLinks('test-session', synthesis);
      expect(result).toContain('  - Nested two spaces');
      expect(result).toContain('    - Deeper four spaces');
    });

    it('deletes a dangling marker without leaving a double space or a space before punctuation', () => {
      const report = [
        'Body.',
        '',
        'CITED LINKS',
        '[1] https://real.example.com/a [Source: Scrape]',
      ].join('\n');
      service.storeReport('test-session', '1.A', report);
      registerScrapedLinks('test-session', ['https://real.example.com/a']);
      const synthesis = [
        'Kept [1] and dangling [2] mid-sentence, plus one at the end [2].',
        '',
        'CITED LINKS',
        '[1] https://real.example.com/a [Source: Scrape]',
        '[2] https://invented.example.com/nope [Source: Scrape]',
      ].join('\n');

      // [2]'s URL is not in any researcher report, so it is absent from the rebuilt
      // list and its markers dangle.
      const result = service.ensureCitedLinks('test-session', synthesis);
      const body = result.split('CITED LINKS')[0]!;
      expect(body).toContain('Kept [1] and dangling mid-sentence, plus one at the end.');
      expect(body).not.toMatch(/ {2}/);
      expect(body).not.toContain('[2]');
    });

    it('leaves an ordinary bracketed number in prose alone (not a citation marker)', () => {
      service.storeReport(
        'test-session',
        '1.A',
        reportWithSourcedCitations([{ url: 'https://real.example.com/a', source: 'Scrape' }]),
      );
      registerScrapedLinks('test-session', ['https://real.example.com/a']);
      // Append path strips every [N] outside the verified range; a year must not
      // be mistaken for a dangling citation and silently deleted.
      const synthesis = 'The spec was published [2023] and revised [1].';

      const result = service.ensureCitedLinks('test-session', synthesis);
      expect(result).toContain('[2023]');
    });

    it('leaves bracketed integers inside fenced code blocks alone', () => {
      service.storeReport(
        'test-session',
        '1.A',
        reportWithSourcedCitations([{ url: 'https://real.example.com/a', source: 'Scrape' }]),
      );
      registerScrapedLinks('test-session', ['https://real.example.com/a']);
      // Append path: every out-of-range [N] is dangling. A quoted array index is not a
      // citation, and deleting it would silently corrupt the user's code sample.
      const synthesis = [
        'Usage [1]:',
        '',
        '```js',
        'const first = items[12];',
        'const last = items[99];',
        '```',
        '',
        'Note that `queue[7]` is reserved.',
      ].join('\n');

      const result = service.ensureCitedLinks('test-session', synthesis);
      expect(result).toContain('const first = items[12];');
      expect(result).toContain('const last = items[99];');
      expect(result).toContain('`queue[7]`');
    });

    it('leaves [0] alone since citation numbering is 1-based', () => {
      service.storeReport(
        'test-session',
        '1.A',
        reportWithSourcedCitations([{ url: 'https://real.example.com/a', source: 'Scrape' }]),
      );
      registerScrapedLinks('test-session', ['https://real.example.com/a']);
      const synthesis = 'The header occupies row [0] of the table [1].';

      const result = service.ensureCitedLinks('test-session', synthesis);
      expect(result).toContain('row [0]');
    });

    it('does not redact a verified URL whose path contains balanced parentheses', () => {
      const wikiUrl = 'https://en.wikipedia.org/wiki/Python_(programming_language)';
      service.storeReport(
        'test-session',
        '1.A',
        reportWithSourcedCitations([{ url: wikiUrl, source: 'Scrape' }]),
      );
      registerScrapedLinks('test-session', [wikiUrl]);
      // Truncating the token at the first ')' would make it fail its own trusted
      // lookup and redact a real source.
      const synthesis = `Background is covered at ${wikiUrl} in detail.`;

      const result = service.ensureCitedLinks('test-session', synthesis);
      expect(result).not.toContain('[link removed');
      expect(result).toContain(wikiUrl);
    });

    it('redacts an unverified URL inside a markdown link without eating the closing paren', () => {
      service.storeReport(
        'test-session',
        '1.A',
        reportWithSourcedCitations([{ url: 'https://real.example.com/a', source: 'Scrape' }]),
      );
      registerScrapedLinks('test-session', ['https://real.example.com/a']);
      const synthesis = 'See [the study](https://fabricated.example.com/study) for more.';

      const result = service.ensureCitedLinks('test-session', synthesis);
      expect(result).not.toContain('fabricated.example.com');
      expect(result).toContain('[link removed: not found in retrieved sources])');
    });
  });

  // ─── appendSteeringGuidance ──────────────────────────────────────────────────

  describe('appendSteeringGuidance', () => {
    it('returns the synthesis unchanged when steeringMessages is empty', () => {
      const input = 'Final report content';
      expect(service.appendSteeringGuidance(input, [])).toBe(input);
    });

    it('returns the synthesis unchanged when steeringMessages is undefined', () => {
      const input = 'Final report content';
      expect(service.appendSteeringGuidance(input, undefined as any)).toBe(input);
    });

    it('appends a formatted steering guidance section for active messages', () => {
      const input = 'Final report content';
      const messages = [
        { id: '1', text: 'focus on modern times', status: 'active' as const, addedAt: Date.now(), consumedAt: Date.now(), poppedAt: null },
        { id: '2', text: 'ignore historical data', status: 'active' as const, addedAt: Date.now(), consumedAt: Date.now(), poppedAt: null },
      ];
      const result = service.appendSteeringGuidance(input, messages);

      expect(result).toContain('Final report content');
      expect(result).not.toContain('---');
      expect(result).toContain('The following guidance was provided by the user during the research process and influenced these results:');
      expect(result).toContain('focus on modern times');
      expect(result).toContain('ignore historical data');
    });

    it('appends guidance from SteeringMessage objects — only active messages', () => {
      const input = 'Final report content';
      const messages = [
        { id: '1', text: 'focus on active', status: 'active' as const, addedAt: Date.now(), consumedAt: Date.now(), poppedAt: null },
        { id: '2', text: 'still queued', status: 'queued' as const, addedAt: Date.now(), consumedAt: null, poppedAt: null },
      ];
      const result = service.appendSteeringGuidance(input, messages);
      
      expect(result).toContain('Final report content');
      expect(result).toContain('The following guidance was provided by the user during the research process and influenced these results:');
      expect(result).toContain('focus on active');
      // Queued messages should NOT be in the report
      expect(result).not.toContain('still queued');
    });

    it('excludes popped messages from SteeringMessage objects', () => {
      const input = 'Final report content';
      const messages = [
        { id: '1', text: 'popped message', status: 'popped' as const, addedAt: Date.now(), consumedAt: null, poppedAt: Date.now() },
      ];
      const result = service.appendSteeringGuidance(input, messages);
      
      // Only popped = no guidance section
      expect(result).toBe(input);
    });

    it('trims the synthesis before appending', () => {
      const input = '  Final report content  ';
      const messages = [
        { id: '1', text: 'steer', status: 'active' as const, addedAt: Date.now(), consumedAt: Date.now(), poppedAt: null },
      ];
      const result = service.appendSteeringGuidance(input, messages);
      expect(result.startsWith('Final report content')).toBe(true);
    });
  });

  // ─── extractAllCitations ─────────────────────────────────────────────────────

  describe('extractAllCitations', () => {
    it('returns deduplicated citations across multiple reports', () => {
      service.storeReport('test-session', 
        '1.A',
        reportWithCitations([
          { url: 'https://shared.example.org/page', desc: 'shared' },
          { url: 'https://only-a.example.org/page', desc: 'only in A' },
        ])
      );
      service.storeReport('test-session', 
        '1.B',
        reportWithCitations([
          { url: 'https://shared.example.org/page', desc: 'shared again' },
          { url: 'https://only-b.example.org/page', desc: 'only in B' },
        ])
      );

      const citations = service.extractAllCitations('test-session');
      const urls = citations.map((c) => c.url);

      expect(urls.filter((u) => u === 'https://shared.example.org/page').length).toBe(1);
      expect(urls).toContain('https://only-a.example.org/page');
      expect(urls).toContain('https://only-b.example.org/page');
      expect(citations.length).toBe(3);
    });
  });

  // ─── extractCitationsForRound ─────────────────────────────────────────────────

  describe('extractCitationsForRound', () => {
    it('only extracts citations from reports matching the specified round prefix', () => {
      service.storeReport('test-session', 
        '1.A',
        reportWithCitations([{ url: 'https://first-round.example.com/page', desc: 'round one result' }])
      );
      service.storeReport('test-session', 
        '2.A',
        reportWithCitations([{ url: 'https://second-round.example.com/page', desc: 'round two result' }])
      );

      const round1Citations = service.extractCitationsForRound('test-session', 1);
      const urls = round1Citations.map((c) => c.url);

      expect(urls).toContain('https://first-round.example.com/page');
      expect(urls).not.toContain('https://second-round.example.com/page');
    });
  });

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('starts with UNINITIALIZED lifecycle', () => {
      expect(service.lifecycle).toBe(ServiceLifecycle.UNINITIALIZED);
    });

    it('transitions to INITIALIZED after initialize()', async () => {
      await service.initialize();
      expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
    });

    it('initialize() is idempotent — calling it twice stays INITIALIZED', async () => {
      await service.initialize();
      await service.initialize();
      expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
    });

    it('transitions to DISPOSED after dispose(), and stored reports are cleared', async () => {
      service.storeReport('test-session', '1.A', 'some content');
      await service.initialize();
      await service.dispose();
      expect(service.lifecycle).toBe(ServiceLifecycle.DISPOSED);
      expect(service.hasReports('test-session')).toBe(false);
    });
  });
});
