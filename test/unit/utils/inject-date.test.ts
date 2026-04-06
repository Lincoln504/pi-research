/**
 * Date Injection Utility Tests
 */

import { describe, it, expect } from 'vitest';
import { injectCurrentDate } from '../../../src/utils/inject-date.ts';

describe('inject-date', () => {
  describe('injectCurrentDate', () => {
    it('should prepend current date to prompt', () => {
      const prompt = 'You are a researcher.';
      const result = injectCurrentDate(prompt, 'researcher');

      expect(result).toContain('**Current Date:**');
      expect(result).toContain(prompt);
      expect(result.indexOf('**Current Date:**')).toBe(0);
    });

    it('should include readable date format', () => {
      const prompt = 'Test prompt';
      const result = injectCurrentDate(prompt, 'coordinator');

      // Should match format like "Sunday, April 5, 2026"
      expect(result).toMatch(/\*\*Current Date:\*\* \w+, \w+ \d{1,2}, \d{4}/);
    });

    it('should preserve original prompt content', () => {
      const prompt = 'Original content\nWith multiple lines\nStill intact';
      const result = injectCurrentDate(prompt, 'researcher');

      expect(result).toContain(prompt);
      expect(result.endsWith(prompt)).toBe(true);
    });

    it('should add date for both coordinator and researcher agents', () => {
      const prompt = 'Agent prompt';

      const coordResult = injectCurrentDate(prompt, 'coordinator');
      const researcherResult = injectCurrentDate(prompt, 'researcher');

      expect(coordResult).toContain('**Current Date:**');
      expect(researcherResult).toContain('**Current Date:**');
      expect(coordResult).toContain(prompt);
      expect(researcherResult).toContain(prompt);
    });

    it('should include blank line separator after date', () => {
      const prompt = 'Content';
      const result = injectCurrentDate(prompt, 'researcher');

      expect(result).toMatch(/\*\*Current Date:.*\n\n/);
    });
  });
});
