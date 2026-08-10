/**
 * Text Utilities Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { extractText, ensureAssistantResponse, parseCitations, stripThinkingTags, truncateWithMarker, formatDuration } from '../../../src/utils/text-utils';
import { stripTrailingLlmPunctuation } from '../../../src/utils/url-utils';

describe('text-utils', () => {
  describe('extractText', () => {
    it('should extract text from string content', () => {
      const message = { content: 'Hello, world!' };
      expect(extractText(message)).toBe('Hello, world!');
    });

    it('should extract text from array content with text blocks', () => {
      const message = {
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'text', text: 'Line 2' },
          { type: 'thinking', content: 'This is thinking' },
        ],
      };
      expect(extractText(message)).toBe('Line 1\nLine 2');
    });

    it('should strip thinking tags from string content', () => {
      const message = { content: '<thought>Internal monologue</thought>Visible response' };
      expect(extractText(message)).toBe('Visible response');
    });

    it('should strip multiple thinking tags from string content', () => {
      const message = { content: '<thinking>Wait</thinking>Hello <reasoning>Checking</reasoning>World' };
      expect(extractText(message)).toBe('Hello World');
    });

    it('should handle empty array', () => {
      expect(extractText({ content: [] })).toBe('');
    });

    it('should handle array with only non-text blocks', () => {
      const message = {
        content: [
          { type: 'thinking', content: 'This is thinking' },
          { type: 'tool_call', tool: 'search' },
        ],
      };
      expect(extractText(message)).toBe('');
    });
  });

  describe('stripThinkingTags', () => {
    it('should remove <thought> tags', () => {
      expect(stripThinkingTags('<thought>secret</thought>public')).toBe('public');
    });

    it('should remove <thinking> tags', () => {
      expect(stripThinkingTags('<thinking>secret</thinking>public')).toBe('public');
    });

    it('should remove <reasoning> tags', () => {
      expect(stripThinkingTags('<reasoning>secret</reasoning>public')).toBe('public');
    });

    it('should handle multi-line tags', () => {
      expect(stripThinkingTags('<thought>\nline1\nline2\n</thought>content')).toBe('content');
    });

    it('should be case-insensitive', () => {
      expect(stripThinkingTags('<THOUGHT>secret</THOUGHT>public')).toBe('public');
    });

    it('should handle mixed tags', () => {
      const input = '<thought>T1</thought>A<thinking>T2</thinking>B<reasoning>T3</reasoning>C';
      expect(stripThinkingTags(input)).toBe('ABC');
    });
  });

  describe('ensureAssistantResponse', () => {
    it('should extract text from the last assistant message', () => {
      const session = {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'response 1' },
          { role: 'user', content: 'next' },
          { role: 'assistant', content: 'response 2' },
        ],
      } as any;
      expect(ensureAssistantResponse(session, 'Test')).toBe('response 2');
    });

    it('should throw if no assistant message is found', () => {
      const session = {
        messages: [{ role: 'user', content: 'hello' }],
      } as any;
      expect(() => ensureAssistantResponse(session, 'Test')).toThrow('Test: No assistant response found');
    });

    it('should throw if last assistant message has error stop reason', () => {
      const session = {
        messages: [
          { role: 'assistant', content: 'partial', stopReason: 'error', errorMessage: 'provider failure' },
        ],
      } as any;
      expect(() => ensureAssistantResponse(session, 'Test')).toThrow('Test: Provider error - provider failure');
    });

    it('should handle 429 rate limit specifically', () => {
      const session = {
        messages: [
          { role: 'assistant', content: '', stopReason: 'error', errorMessage: 'Rate limit 429' },
        ],
      } as any;
      expect(() => ensureAssistantResponse(session, 'Test')).toThrow('Model API rate limit (429)');
    });

    it('should ignore errorMessage if stopReason is aborted', () => {
      const session = {
        messages: [
          { role: 'assistant', content: 'aborted findings', stopReason: 'aborted', errorMessage: 'Cancelled' },
        ],
      } as any;
      expect(ensureAssistantResponse(session, 'Test')).toBe('aborted findings');
    });

    it('should report an aborted session with no text as "Aborted", not a model-capability failure', () => {
      // A researcher interrupted mid-turn by quit/SIGTERM has an aborted final message with
      // no text block yet. This must NOT be misdiagnosed as "produced no text output —
      // model-capability issue" (the retry loop keys off the "Aborted" message to stop retrying).
      const session = {
        messages: [
          { role: 'assistant', content: [], stopReason: 'aborted' },
        ],
      } as any;
      expect(() => ensureAssistantResponse(session, 'Test')).toThrow('Test: Aborted');
      expect(() => ensureAssistantResponse(session, 'Test')).not.toThrow(/produced no text output/);
    });

    it('should return partial text when stopReason is length and text is present', () => {
      const session = {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'Partial answer before cutoff' }], stopReason: 'length' },
        ],
      } as any;
      expect(ensureAssistantResponse(session, 'Test')).toBe('Partial answer before cutoff');
    });

    it('should throw when stopReason is length and text is empty', () => {
      const session = {
        messages: [
          { role: 'assistant', content: [], stopReason: 'length' },
        ],
      } as any;
      expect(() => ensureAssistantResponse(session, 'Test'))
        .toThrow('truncated by token limit and produced no usable text');
    });

    it('should throw if last assistant message has zero text blocks', () => {
      const session = {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: [] }, // Empty array = zero text blocks
        ],
      } as any;
      expect(() => ensureAssistantResponse(session, 'Test'))
        .toThrow('Test: produced no text output');
    });

    it('should throw if last assistant message has only non-text blocks', () => {
      const session = {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: [
            { type: 'tool_call', tool: 'search', args: { query: 'test' } },
          ] },
        ],
      } as any;
      expect(() => ensureAssistantResponse(session, 'Test'))
        .toThrow('Test: produced no text output');
    });
  });

  describe('parseCitations', () => {
    it('returns empty array when no CITED LINKS section', () => {
      expect(parseCitations('No citations here.')).toEqual([]);
    });

    it('parses inline format [N] URL — description', () => {
      const report = `CITED LINKS\n[1] https://example.com — A great source\n`;
      const result = parseCitations(report);
      expect(result).toHaveLength(1);
      expect(result[0]!.url).toBe('https://example.com');
      expect(result[0]!.description).toBe('A great source');
    });

    it('parses multi-line Description: format', () => {
      const report = `CITED LINKS\n[1] https://example.com\nDescription: Detailed description here\n`;
      const result = parseCitations(report);
      expect(result).toHaveLength(1);
      expect(result[0]!.url).toBe('https://example.com');
      expect(result[0]!.description).toBe('Detailed description here');
    });

    it('parses URL with no description', () => {
      const report = `CITED LINKS\n[1] https://example.com\n`;
      const result = parseCitations(report);
      expect(result).toHaveLength(1);
      expect(result[0]!.url).toBe('https://example.com');
      expect(result[0]!.description).toBe('');
    });

    it('parses multiple citations', () => {
      const report = [
        'CITED LINKS',
        '[1] https://example.com — First source',
        '[2] https://other.org — Second source',
      ].join('\n');
      const result = parseCitations(report);
      expect(result).toHaveLength(2);
      expect(result[0]!.url).toBe('https://example.com');
      expect(result[1]!.url).toBe('https://other.org');
    });

    it('preserves URLs containing digits-then-dot (regression: bracket [N] form)', () => {
      // The old split delimiter matched any "N." run — inside URLs too — truncating
      // report-2024.pdf → "report-", /v2.0/ → "/v", and shredding IP literals entirely.
      const report = [
        'CITED LINKS',
        '[1] https://example.com/report-2024.pdf — annual report',
        '[2] https://blog.example.com/v2.0/changes — changelog',
        '[3] https://192.168.1.10/advisory — internal advisory',
      ].join('\n');
      const urls = parseCitations(report).map((c) => c.url);
      expect(urls).toEqual([
        'https://example.com/report-2024.pdf',
        'https://blog.example.com/v2.0/changes',
        'https://192.168.1.10/advisory',
      ]);
    });

    it('preserves digits-then-dot URLs in the numbered "N." marker form too', () => {
      const report = [
        'CITED LINKS',
        '1. https://example.com/report-2024.pdf',
        '2. https://192.168.1.10/advisory',
      ].join('\n');
      const urls = parseCitations(report).map((c) => c.url);
      expect(urls).toEqual([
        'https://example.com/report-2024.pdf',
        'https://192.168.1.10/advisory',
      ]);
    });

    it('strips an unbalanced trailing ) ] } from a URL (balance-aware)', () => {
      // Markdown noise brackets the LLM appends after a URL must be trimmed, or the
      // CITED LINKS entry ships a broken 404 link. Balanced brackets that belong to
      // the URL are preserved (handled in the next test).
      const report = [
        'CITED LINKS',
        '[1] https://example.com/a], — trailing ] and comma',
        '[2] https://example.com/b)}, — trailing } ) and comma',
      ].join('\n');
      const urls = parseCitations(report).map((c) => c.url);
      expect(urls).toEqual(['https://example.com/a', 'https://example.com/b']);
    });

    it('preserves balanced brackets but strips unbalanced ones (stripTrailingLlmPunctuation, unit)', () => {
      // Real-world balanced cases (Wikipedia disambiguation parens, IPv6 literals)
      // must be kept; a lone trailing noise bracket must be removed.
      expect(stripTrailingLlmPunctuation('https://en.wikipedia.org/wiki/Python_(programming_language)'))
        .toBe('https://en.wikipedia.org/wiki/Python_(programming_language)');
      expect(stripTrailingLlmPunctuation('http://[::1]:8080/path')).toBe('http://[::1]:8080/path');
      // Unbalanced noise brackets are trimmed.
      expect(stripTrailingLlmPunctuation('https://example.com/a]')).toBe('https://example.com/a');
      expect(stripTrailingLlmPunctuation('https://example.com/b}')).toBe('https://example.com/b');
      expect(stripTrailingLlmPunctuation('https://example.com/c)')).toBe('https://example.com/c');
      // Multiple stacked noise brackets are trimmed in one pass each (bounded loop).
      expect(stripTrailingLlmPunctuation('https://example.com/d]),')).toBe('https://example.com/d');
    });

    // Regression: a flat open/close COUNT comparison (rather than a running
    // balance) misjudges a string that both ends in a genuinely balanced pair
    // AND carries an earlier, unrelated unbalanced bracket — the earlier stray
    // ')' tips the total count (2 closes vs 1 open) even though the trailing
    // ')' really does close "(c)" right before it.
    it('does not strip a genuinely balanced trailing bracket when an earlier unbalanced one inflates the flat count', () => {
      expect(stripTrailingLlmPunctuation('http://example.com/a)b(c)'))
        .toBe('http://example.com/a)b(c)');
      // Still strips when there truly is no opener anywhere for the trailing bracket.
      expect(stripTrailingLlmPunctuation('http://example.com/a)b)'))
        .toBe('http://example.com/a)b');
    });

    it('drops a malformed/truncated URL fragment instead of emitting garbage (regression: "https://www")', () => {
      // A soft-wrapped URL leaves "https://www" on the first line of a citation.
      const report = [
        'CITED LINKS',
        '[1] https://www',
        '[2] https://realsource.com — Real source',
      ].join('\n');
      const result = parseCitations(report);
      // The fragment is skipped; only the real source survives, and it is NOT
      // shifted behind a garbage entry.
      expect(result).toHaveLength(1);
      expect(result[0]!.url).toBe('https://realsource.com');
    });

    it('rejects scheme-only / hostless URLs', () => {
      const report = [
        'CITED LINKS',
        '[1] https:// — broken',
        '[2] http://localhost — no TLD',
        '[3] https://good.example.com — fine',
      ].join('\n');
      const urls = parseCitations(report).map((c) => c.url);
      expect(urls).toEqual(['https://good.example.com']);
    });

    it('strips trailing punctuation from URL', () => {
      const report = `CITED LINKS\n[1] https://example.com.\n`;
      const result = parseCitations(report);
      expect(result[0]!.url).toBe('https://example.com');
    });

    it('preserves a balanced trailing paren but strips an unbalanced one (regression: Wikipedia disambiguation URLs)', () => {
      const report = [
        'CITED LINKS',
        '[1] https://en.wikipedia.org/wiki/Python_(programming_language) — the language',
        '[2] https://example.com/page) — trailing paren from prose "(see https://example.com/page)"',
      ].join('\n');
      const urls = parseCitations(report).map((c) => c.url);
      // The balanced paren is part of the URL and must survive; the unbalanced one is stripped.
      expect(urls).toEqual([
        'https://en.wikipedia.org/wiki/Python_(programming_language)',
        'https://example.com/page',
      ]);
    });

    it('parses bold **[N]** format', () => {
      const report = `CITED LINKS\n**[1]** https://example.com — Bold citation\n`;
      const result = parseCitations(report);
      expect(result).toHaveLength(1);
      expect(result[0]!.url).toBe('https://example.com');
      expect(result[0]!.description).toBe('Bold citation');
    });

    it('parses numbered list N. format', () => {
      const report = `CITED LINKS\n1. https://example.com — N. format citation\n`;
      const result = parseCitations(report);
      expect(result).toHaveLength(1);
      expect(result[0]!.url).toBe('https://example.com');
      expect(result[0]!.description).toBe('N. format citation');
    });

    it('parses numbered list **N.** format', () => {
      const report = `CITED LINKS\n**1.** https://example.com\nDescription: Bold N. format citation\n`;
      const result = parseCitations(report);
      expect(result).toHaveLength(1);
      expect(result[0]!.url).toBe('https://example.com');
      expect(result[0]!.description).toBe('Bold N. format citation');
    });

    it('skips entries without a valid http URL', () => {
      const report = `CITED LINKS\n[1] not-a-url\n[2] https://valid.com — Valid\n`;
      const result = parseCitations(report);
      expect(result).toHaveLength(1);
      expect(result[0]!.url).toBe('https://valid.com');
    });

    it('is case-insensitive for section header', () => {
      const report = `cited links\n[1] https://example.com — Found\n`;
      const result = parseCitations(report);
      expect(result).toHaveLength(1);
    });
  });

  describe('truncateWithMarker', () => {
    it('returns content unchanged when at or under the cap', () => {
      expect(truncateWithMarker('short content', 1000)).toBe('short content');
      const exact = 'a'.repeat(100);
      expect(truncateWithMarker(exact, 100)).toBe(exact);
    });

    it('truncates oversized content with an explicit marker and bounded total length', () => {
      const content = ('lorem ipsum dolor sit amet\n').repeat(1000); // 27k chars
      const out = truncateWithMarker(content, 5000);
      expect(out.length).toBeLessThanOrEqual(5000);
      expect(out).toMatch(/\[content truncated: showing \d+ of 27000 chars\]$/);
      // Body is a prefix of the original
      const body = out.slice(0, out.indexOf('\n\n[content truncated'));
      expect(content.startsWith(body)).toBe(true);
    });

    it('cuts at a clean boundary (no mid-word split) when one is near the cut point', () => {
      const content = ('word '.repeat(10000)).trim(); // spaces throughout
      const out = truncateWithMarker(content, 2000);
      const body = out.slice(0, out.indexOf('\n\n[content truncated'));
      // Ends exactly on a full word, not a fragment
      expect(body.endsWith('word')).toBe(true);
    });

    it('is idempotent — re-applying the same cap to truncated output is a no-op', () => {
      const content = 'x'.repeat(500_000);
      const once = truncateWithMarker(content, 80_000);
      const twice = truncateWithMarker(once, 80_000);
      expect(twice).toBe(once);
      // No nested markers
      expect(once.match(/\[content truncated/g)!.length).toBe(1);
    });

    it('never leaks a lone surrogate when the cut lands inside an astral character', () => {
      // slice() counts UTF-16 code units, so an odd `keep` lands between the halves
      // of a surrogate pair. Some providers reject (400) JSON payloads containing an
      // unpaired surrogate, so the cut must back off to the pair boundary.
      const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      // No whitespace anywhere, so the clean-boundary path cannot mask the raw cut.
      const content = '𝕏'.repeat(5000); // 10,000 code units, pairs at every even index
      // Sweep a window of caps so both parities of `keep` are exercised regardless
      // of the marker's exact length.
      for (let cap = 900; cap < 910; cap++) {
        const out = truncateWithMarker(content, cap);
        expect(out.length).toBeLessThanOrEqual(cap);
        expect(loneSurrogate.test(out)).toBe(false);
        expect(out).toMatch(/\[content truncated: showing \d+ of 10000 chars\]$/);
      }
    });

    it('reports accurate shown/total counts in the marker', () => {
      const content = 'b'.repeat(10_000);
      const out = truncateWithMarker(content, 1000);
      const m = out.match(/\[content truncated: showing (\d+) of (\d+) chars\]$/);
      expect(m).not.toBeNull();
      const shown = parseInt(m![1]!, 10);
      expect(parseInt(m![2]!, 10)).toBe(10_000);
      const body = out.slice(0, out.indexOf('\n\n[content truncated'));
      expect(body.length).toBe(shown);
    });
  });

  describe('formatDuration', () => {
    it('rolls over into the next minute instead of rendering "Xm 60s"', () => {
      // 119,601ms = 1m 59.601s. Rounding remainingSeconds independently of
      // minutes used to produce '1m 60s' — an invalid duration display.
      expect(formatDuration(119_601)).toBe('2m 0s');
    });

    it('formats sub-minute durations with one decimal', () => {
      expect(formatDuration(12_300)).toBe('12.3s');
    });

    it('formats whole minutes and seconds', () => {
      expect(formatDuration(83_000)).toBe('1m 23s');
    });

    it('formats hours and minutes, never seconds', () => {
      expect(formatDuration(2 * 3_600_000 + 15 * 60_000)).toBe('2h 15m');
    });

    it('formats sub-second durations in ms', () => {
      expect(formatDuration(500)).toBe('500ms');
    });
  });
});
