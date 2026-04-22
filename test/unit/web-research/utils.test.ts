
import { describe, it, expect } from 'vitest';
import { validateMaxConcurrency } from '../../../src/web-research/utils.ts';

describe('web-research/utils', () => {
  describe('validateMaxConcurrency', () => {
    it('should return default 10 when undefined', () => {
      expect(validateMaxConcurrency(undefined)).toBe(10);
    });

    it('should handle values in valid range', () => {
      expect(validateMaxConcurrency(5)).toBe(5);
      expect(validateMaxConcurrency(15)).toBe(15);
    });

    it('should clamp to 1 for values less than 1', () => {
      expect(validateMaxConcurrency(0)).toBe(1);
      expect(validateMaxConcurrency(-5)).toBe(1);
    });

    it('should clamp to 20 for values greater than 20', () => {
      expect(validateMaxConcurrency(25)).toBe(20);
      expect(validateMaxConcurrency(100)).toBe(20);
    });

    it('should floor decimal values', () => {
      expect(validateMaxConcurrency(5.7)).toBe(5);
    });
  });
});
