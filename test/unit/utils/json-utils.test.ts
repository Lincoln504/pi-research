/**
 * JSON Utils Unit Tests
 *
 * Tests all extraction paths with real inputs — no mocks, pure functions.
 * Emphasis on the depth-tracking brace scanner introduced to replace the
 * fragile first-{/last-} heuristic.
 */

import { describe, it, expect } from 'vitest';
import {
  extractJsonFromCodeBlocks,
  extractJsonObject,
  extractJsonArray,
  extractJson,
} from '../../../src/utils/json-utils';

// ---------------------------------------------------------------------------
// extractJsonFromCodeBlocks
// ---------------------------------------------------------------------------

describe('extractJsonFromCodeBlocks', () => {
  it('extracts from a ```json block', () => {
    const text = 'Here is the plan:\n```json\n{"action":"continue"}\n```\nDone.';
    const result = extractJsonFromCodeBlocks(text);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ action: 'continue' });
    expect(result.method).toBe('code-block');
  });

  it('extracts from a bare ``` block', () => {
    const text = '```\n{"key":"value"}\n```';
    const result = extractJsonFromCodeBlocks(text);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ key: 'value' });
  });

  it('returns the first valid block when multiple exist', () => {
    const text = '```json\n{"first":1}\n```\n```json\n{"second":2}\n```';
    const result = extractJsonFromCodeBlocks(text);
    expect(result.success).toBe(true);
    expect((result.value as any).first).toBe(1);
  });

  it('skips an invalid block and returns the next valid one', () => {
    const text = '```json\nnot json\n```\n```json\n{"good":true}\n```';
    const result = extractJsonFromCodeBlocks(text);
    expect(result.success).toBe(true);
    expect((result.value as any).good).toBe(true);
  });

  it('fails when no code blocks are present', () => {
    const result = extractJsonFromCodeBlocks('{"plain":"object"}');
    expect(result.success).toBe(false);
  });

  it('fails when all blocks contain invalid JSON', () => {
    const text = '```json\nnot json\n```';
    const result = extractJsonFromCodeBlocks(text);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractJsonObject — depth-tracking brace scanner
// ---------------------------------------------------------------------------

describe('extractJsonObject', () => {
  it('ignores leading prose and extracts the object', () => {
    const result = extractJsonObject('Here is the plan: {"action":"delegate"}');
    expect(result.success).toBe(true);
    expect((result.value as any).action).toBe('delegate');
  });

  it('ignores trailing text after the closing brace', () => {
    const result = extractJsonObject('{"a":1} and some trailing prose');
    expect(result.success).toBe(true);
    expect((result.value as any).a).toBe(1);
  });

  it('handles nested objects correctly', () => {
    const text = '{"outer":{"inner":42}}';
    const result = extractJsonObject(text);
    expect(result.success).toBe(true);
    expect((result.value as any).outer.inner).toBe(42);
  });

  it('handles brace characters inside string values', () => {
    const text = '{"pattern":"use { } notation","count":3}';
    const result = extractJsonObject(text);
    expect(result.success).toBe(true);
    expect((result.value as any).pattern).toBe('use { } notation');
    expect((result.value as any).count).toBe(3);
  });

  it('extracts the FIRST object when multiple appear in the text', () => {
    // The old first-{/last-} approach would span across both objects, producing
    // invalid JSON. Depth-tracking stops at the correct closing brace.
    const text = 'Result A: {"id":"a","score":1} then Result B: {"id":"b","score":2}';
    const result = extractJsonObject(text);
    expect(result.success).toBe(true);
    expect((result.value as any).id).toBe('a');
  });

  it('handles escaped quotes inside string values', () => {
    const text = '{"message":"she said \\"hello\\""}';
    const result = extractJsonObject(text);
    expect(result.success).toBe(true);
    expect((result.value as any).message).toBe('she said "hello"');
  });

  it('handles escaped backslashes before quotes', () => {
    const text = '{"path":"C:\\\\windows\\\\"}';
    const result = extractJsonObject(text);
    expect(result.success).toBe(true);
    expect((result.value as any).path).toBe('C:\\windows\\');
  });

  it('handles deeply nested objects', () => {
    const text = '{"a":{"b":{"c":{"d":1}}}}';
    const result = extractJsonObject(text);
    expect(result.success).toBe(true);
    expect((result.value as any).a.b.c.d).toBe(1);
  });

  it('returns failure when no opening brace exists', () => {
    const result = extractJsonObject('no json here at all');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No JSON object boundaries found');
  });

  it('successfully salvages unclosed strings during local repair', () => {
    // New logic now closes unclosed quotes before appending braces
    const result = extractJsonObject('{"key": "unclosed string');
    expect(result.success).toBe(true);
    expect((result.value as any).key).toBe('unclosed string');
  });

  it('returns failure for an empty string', () => {
    const result = extractJsonObject('');
    expect(result.success).toBe(false);
  });

  it('extracts an object with arrays as values', () => {
    const text = '{"researchers":[{"id":"1","queries":["a","b"]}]}';
    const result = extractJsonObject(text);
    expect(result.success).toBe(true);
    const val = result.value as any;
    expect(val.researchers[0]!.queries).toEqual(['a', 'b']);
  });

  it('attempts local repair for truncated JSON', () => {
    const text = 'Here is some text {"a": 1, "b": {"c": 2}';
    const result = extractJsonObject(text);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ a: 1, b: { c: 2 } });
    expect(result.method).toBe('raw-object');
  });

  it('scans past a prose brace to the real payload', () => {
    // The first `{` candidate ({placeholder}) closes but is not JSON — extraction
    // must advance to the next candidate instead of reporting "no valid JSON".
    const result = extractJsonObject('Fill {placeholder} like this: {"score": 5}');
    expect(result.success).toBe(true);
    expect((result.value as any).score).toBe(5);
  });

  it('scans past multiple prose braces', () => {
    const result = extractJsonObject('Use {a} or {b} then output {"ok": true}');
    expect(result.success).toBe(true);
    expect((result.value as any).ok).toBe(true);
  });

  it('still applies truncated repair at the first unclosed candidate after skipping prose braces', () => {
    const result = extractJsonObject('Fill {placeholder} then: {"a": 1, "b": {"c": 2}');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ a: 1, b: { c: 2 } });
  });

  it('keeps the existing error shape when every candidate fails to parse', () => {
    const result = extractJsonObject('choose {x} or {y} or {z}');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to parse JSON object');
  });

  it('bounds the forward scan on brace-dense non-JSON text', () => {
    // A payload buried past the candidate cap is not found — the scan must stay
    // bounded rather than walking arbitrarily many prose braces.
    const result = extractJsonObject('{x} '.repeat(20) + '{"ok": true}');
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractJsonArray
// ---------------------------------------------------------------------------

describe('extractJsonArray', () => {
  it('extracts an array of objects', () => {
    const result = extractJsonArray('[{"id":1},{"id":2}]');
    expect(result.success).toBe(true);
    expect((result.value as any)[0].id).toBe(1);
  });

  it('attempts local repair for truncated array', () => {
    const text = 'Results: [{"id":1}, {"id":2}';
    const result = extractJsonArray(text);
    expect(result.success).toBe(true);
    expect(result.value).toHaveLength(2);
    expect(result.method).toBe('raw-array');
  });

  it('fails on text that is not an array', () => {
    const result = extractJsonArray('{"key":"value"}');
    expect(result.success).toBe(false);
  });

  it('fails on plain text', () => {
    const result = extractJsonArray('just text');
    expect(result.success).toBe(false);
  });

  it('scans past a citation-style bracket to the real array', () => {
    // The first `[` candidate ([citation needed]) closes but is not JSON —
    // extraction must advance to the next candidate.
    const result = extractJsonArray('[citation needed] the queries are: ["a", "b"]');
    expect(result.success).toBe(true);
    expect(result.value).toEqual(['a', 'b']);
  });

  it('still applies truncated repair at the first unclosed candidate after skipping a citation bracket', () => {
    const result = extractJsonArray('[see note] then: ["a", "b"');
    expect(result.success).toBe(true);
    expect(result.value).toEqual(['a', 'b']);
    expect(result.method).toBe('raw-array');
  });

  it('keeps the existing error shape when every candidate fails to parse', () => {
    const result = extractJsonArray('[citation needed] and [another note]');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to parse JSON array');
  });
});

// ---------------------------------------------------------------------------
// extractJson — full fallback chain
// ---------------------------------------------------------------------------

describe('extractJson', () => {
  it('direct-parses a pure-JSON payload before fenced-block extraction (fenced example inside a string field must not win)', () => {
    // The whole response IS the JSON payload, and one string value contains a
    // fenced ```json example whose content is itself valid JSON ([1, 2, 3] —
    // no quotes, so it survives JSON string escaping verbatim). Code-block-first
    // extraction used to latch onto the example and return it instead.
    const payload = { report: 'Example output:\n```json\n[1, 2, 3]\n```\ndone', ok: true };
    const text = JSON.stringify(payload);
    const result = extractJson<typeof payload>(text, 'any');
    expect(result.success).toBe(true);
    expect(result.value).toEqual(payload);
    expect(result.method).toBe('raw-object');
  });

  it('direct parse respects targetType (whole-string array is rejected for targetType=object)', () => {
    const result = extractJson('["a","b"]', 'object');
    expect(result.success).toBe(false);
  });

  it('direct parse does not accept scalars (falls through to the extraction chain)', () => {
    const result = extractJson('42', 'any');
    expect(result.success).toBe(false);
  });

  it('prefers code blocks over raw extraction', () => {
    // Raw object also present — code block should win
    const text = '{"wrong":true}\n```json\n{"correct":true}\n```';
    const result = extractJson(text, 'object');
    expect(result.success).toBe(true);
    expect((result.value as any).correct).toBe(true);
    expect(result.method).toBe('code-block');
  });

  it('falls back to raw object when no code block exists', () => {
    const result = extractJson('some text {"action":"continue"} more text', 'object');
    expect(result.success).toBe(true);
    expect((result.value as any).action).toBe('continue');
    expect(result.method).toBe('raw-object');
  });

  it('falls back to raw array when targetType is array', () => {
    const result = extractJson('["a","b"]', 'array');
    expect(result.success).toBe(true);
    expect(result.value).toEqual(['a', 'b']);
    expect(result.method).toBe('raw-array');
  });

  it('tries both object and array when targetType is any', () => {
    const objectResult = extractJson('{"x":1}', 'any');
    expect(objectResult.success).toBe(true);
    expect(objectResult.method).toBe('raw-object');
  });

  it('does not try array extraction when targetType is object', () => {
    const result = extractJson('["a","b"]', 'object');
    expect(result.success).toBe(false);
  });

  it('does not try object extraction when targetType is array', () => {
    const result = extractJson('{"k":"v"}', 'array');
    expect(result.success).toBe(false);
  });

  it('returns failure when all methods fail', () => {
    const result = extractJson('no json anywhere', 'any');
    expect(result.success).toBe(false);
    expect(result.value).toBeUndefined();
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it('handles the coordinator plan shape end-to-end', () => {
    const plan = {
      action: 'delegate',
      researchers: [
        { id: '1.1', name: 'Researcher A', goal: 'find X', queries: ['query 1', 'query 2'] },
      ],
      allQueries: ['query 1', 'query 2'],
    };
    const text = `The coordinator has decided:\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\nProceeding.`;
    const result = extractJson<typeof plan>(text, 'object');
    expect(result.success).toBe(true);
    expect(result.value?.researchers[0]?.queries).toEqual(['query 1', 'query 2']);
  });
});
