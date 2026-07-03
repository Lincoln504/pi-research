/**
 * Text Utilities Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { extractText, ensureAssistantResponse, parseCitations, stripThinkingTags } from '../../../src/utils/text-utils';

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
});
