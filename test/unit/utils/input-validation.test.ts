/**
 * Input Validation Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  validateQuery,
  validateAndSanitizeQuery,
} from '../../../src/utils/input-validation';
import { MIN_QUERY_LENGTH, MAX_QUERY_LENGTH } from '../../../src/constants';

describe('validateQuery', () => {
  it('should accept valid queries', () => {
    const result = validateQuery('test query');
    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should reject empty queries', () => {
    const result = validateQuery('');
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('non-empty');
  });

  it('should reject undefined queries', () => {
    const result = validateQuery(undefined as any);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('non-empty');
  });

  it('should reject queries that are too short', () => {
    const result = validateQuery('hi');
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('at least 3 characters');
  });

  it('should reject queries that are too long', () => {
    const longQuery = 'a'.repeat(100001);
    const result = validateQuery(longQuery);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('at most 100000 characters');
  });

  it('should reject whitespace-only queries', () => {
    const result = validateQuery('   ');
    expect(result.isValid).toBe(false);
    // Note: This is caught by minimum length check, not whitespace-only check
    expect(result.error).toContain('at least 3 characters');
  });

  it('should reject script tags', () => {
    const result = validateQuery('<script>alert("xss")</script>');
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('dangerous');
  });

  it('should reject javascript: URLs', () => {
    const result = validateQuery('javascript:alert("xss")');
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('dangerous');
  });

  it('should reject event handlers', () => {
    const result = validateQuery('onclick=alert("xss")');
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('dangerous');
  });

  it('should reject iframes', () => {
    const result = validateQuery('<iframe src="evil.com"></iframe>');
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('dangerous');
  });

  it('should accept queries with special characters', () => {
    const result = validateQuery('What is C++ vs Java?');
    expect(result.isValid).toBe(true);
  });

  it('should accept queries with numbers', () => {
    const result = validateQuery('HTTP 2.0 vs HTTP 1.1');
    expect(result.isValid).toBe(true);
  });

  it('should accept queries with punctuation', () => {
    const result = validateQuery('How do I use "quotes" in this?');
    expect(result.isValid).toBe(true);
  });

  it('should reject tag-internal slash-delimited event handlers', () => {
    // Regression: the old boundary class [\s"'<] omitted '/', letting these through.
    for (const q of ['<svg/onload=alert(1)>', '<img/onerror=alert(1)>']) {
      const result = validateQuery(q);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('dangerous');
    }
  });

  it('should NOT false-positive on words ending in "on<digits>="', () => {
    // The negative-lookbehind requires a non-word char before "on", so these are safe.
    for (const q of ['pokemon2=red vs blue', 'compare season2= plot points']) {
      expect(validateQuery(q).isValid).toBe(true);
    }
  });
});



describe('validateAndSanitizeQuery', () => {
  it('should return sanitized query for valid input', () => {
    const result = validateAndSanitizeQuery('  test query  ');
    expect(result).toBe('test query');
  });

  it('should throw error for invalid input', () => {
    expect(() => validateAndSanitizeQuery('')).toThrow();
  });

  it('should throw error for too short input', () => {
    expect(() => validateAndSanitizeQuery('hi')).toThrow();
  });

  it('should throw error for dangerous input', () => {
    expect(() => validateAndSanitizeQuery('<script>alert(1)</script>')).toThrow();
  });
});

describe('validateQuery — Property-based tests', () => {
  it('should handle arbitrary strings safely', () => {
    const generateRandomString = (length: number) => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 <>/="\'';
      let result = '';
      for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    };

    // Span the real boundary on BOTH sides: from below MIN_QUERY_LENGTH up to
    // just past it, plus a few explicit cases at the upper bound, so the
    // length-limit assertions are actually reachable (the old test capped at
    // 1000 chars and asserted an unreachable 12000 limit that could never fail).
    const lengths = [
      ...Array.from({ length: 50 }, (_, k) => k), // 0..49 around MIN
      MAX_QUERY_LENGTH - 1,
      MAX_QUERY_LENGTH,
      MAX_QUERY_LENGTH + 1,
    ];

    for (const len of lengths) {
      const query = generateRandomString(len);
      const trimmed = query.trim();
      const result = validateQuery(query);

      if (result.isValid) {
        // Validity is decided on the TRIMMED length, against the real constants.
        expect(trimmed.length).toBeGreaterThanOrEqual(MIN_QUERY_LENGTH);
        expect(trimmed.length).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
        expect(query).not.toMatch(/<script/i);
        expect(query).not.toMatch(/javascript:/i);
        expect(query).not.toMatch(/onclick/i);
        // Validation must be stable/idempotent.
        expect(validateQuery(query).isValid).toBe(true);
      } else {
        // Every rejection carries a non-empty reason that matches its cause.
        expect(typeof result.error).toBe('string');
        expect(result.error!.length).toBeGreaterThan(0);
        const tooShort = trimmed.length < MIN_QUERY_LENGTH;
        const tooLong = trimmed.length > MAX_QUERY_LENGTH;
        // Mirror validateQuery's dangerous-pattern set exactly (tested on trimmed).
        const dangerous = /<script|javascript:|on\w+\s*=|<iframe|<object|<embed/i.test(trimmed);
        expect(tooShort || tooLong || dangerous).toBe(true);
      }
    }
  });
});
