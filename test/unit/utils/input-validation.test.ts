/**
 * Input Validation Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  validateQuery,
  sanitizeQuery,
  validateAndSanitizeQuery,
  validateComplexity,
} from '../../../src/utils/input-validation';

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
    const longQuery = 'a'.repeat(12001);
    const result = validateQuery(longQuery);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('at most 12000 characters');
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

    for (let i = 0; i < 100; i++) {
      const len = Math.floor(Math.random() * 1000);
      const query = generateRandomString(len);
      const result = validateQuery(query);
      
      if (result.isValid) {
        expect(query.length).toBeGreaterThanOrEqual(3);
        expect(query.length).toBeLessThanOrEqual(12000);
        expect(query).not.toMatch(/<script/i);
        expect(query).not.toMatch(/javascript:/i);
        expect(query).not.toMatch(/onclick/i);
      } else {
        // If invalid, there must be a reason
        expect(result.error).toBeDefined();
      }
    }
  });
});
