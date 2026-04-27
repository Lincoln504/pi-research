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
  normalizeStringArrayDetailed,
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
  it('extracts a simple object', () => {
    const result = extractJsonObject('{"key":"value"}');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ key: 'value' });
    expect(result.method).toBe('raw-object');
  });

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

  it('returns failure when the brace is never closed', () => {
    const result = extractJsonObject('{"unclosed":1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No matching closing brace found');
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
    expect(val.researchers[0].queries).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// extractJsonArray
// ---------------------------------------------------------------------------

describe('extractJsonArray', () => {
  it('extracts a simple string array', () => {
    const result = extractJsonArray('["one","two","three"]');
    expect(result.success).toBe(true);
    expect(result.value).toEqual(['one', 'two', 'three']);
    expect(result.method).toBe('raw-array');
  });

  it('extracts an array of objects', () => {
    const result = extractJsonArray('[{"id":1},{"id":2}]');
    expect(result.success).toBe(true);
    expect((result.value as any)[0].id).toBe(1);
  });

  it('fails on text that is not an array', () => {
    const result = extractJsonArray('{"key":"value"}');
    expect(result.success).toBe(false);
  });

  it('fails on plain text', () => {
    const result = extractJsonArray('just text');
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractJson — full fallback chain
// ---------------------------------------------------------------------------

describe('extractJson', () => {
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
    expect(result.error).toBeTruthy();
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

// ---------------------------------------------------------------------------
// normalizeStringArrayDetailed
// ---------------------------------------------------------------------------

describe('normalizeStringArrayDetailed', () => {
  it('passes through a clean string array unchanged', () => {
    const result = normalizeStringArrayDetailed(['alpha', 'beta', 'gamma']);
    expect(result.strings).toEqual(['alpha', 'beta', 'gamma']);
    expect(result.skippedCount).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('trims whitespace from strings', () => {
    const result = normalizeStringArrayDetailed(['  hello  ', '\tworld\n']);
    expect(result.strings).toEqual(['hello', 'world']);
  });

  it('skips empty strings and reports them', () => {
    const result = normalizeStringArrayDetailed(['good', '', '  ']);
    expect(result.strings).toEqual(['good']);
    expect(result.skippedCount).toBe(2);
  });

  it('extracts the query field from object items', () => {
    const result = normalizeStringArrayDetailed([{ query: 'find CVEs' }, 'plain']);
    expect(result.strings).toEqual(['find CVEs', 'plain']);
    expect(result.extractedCount).toBe(1);
  });

  it('extracts topic, text, task fields as fallbacks', () => {
    const items = [
      { topic: 'security' },
      { text: 'analyze' },
      { task: 'search' },
    ];
    const result = normalizeStringArrayDetailed(items);
    expect(result.strings).toEqual(['security', 'analyze', 'search']);
  });

  it('stringifies objects with no recognized key and warns', () => {
    const result = normalizeStringArrayDetailed([{ unknown: 'field' }]);
    expect(result.strings).toHaveLength(1);
    expect(result.strings[0]).toContain('unknown');
    expect(result.warnings.some(w => w.includes('stringified'))).toBe(true);
  });

  it('converts numbers and booleans to strings', () => {
    const result = normalizeStringArrayDetailed([42, true, false]);
    expect(result.strings).toEqual(['42', 'true', 'false']);
  });
});
