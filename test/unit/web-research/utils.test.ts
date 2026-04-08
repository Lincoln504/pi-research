/**
 * Web Research Utils Unit Tests
 *
 * Tests utility functions for validation.
 */

import { describe, it, expect } from 'vitest';
import {
  validateMaxConcurrency,
} from '../../../src/web-research/utils.js';

describe('web-research/utils', () => {
  describe('validateMaxConcurrency', () => {
    describe('positive cases', () => {
      it('should return default when undefined', () => {
        expect(validateMaxConcurrency(undefined)).toBe(10);
      });

      it('should return 1 for value of 1', () => {
        expect(validateMaxConcurrency(1)).toBe(1);
      });

      it('should return 20 for value of 20', () => {
        expect(validateMaxConcurrency(20)).toBe(20);
      });

      it('should return 5 for value of 5', () => {
        expect(validateMaxConcurrency(5)).toBe(5);
      });

      it('should floor decimal values', () => {
        expect(validateMaxConcurrency(3.5)).toBe(3);
        expect(validateMaxConcurrency(7.9)).toBe(7);
        expect(validateMaxConcurrency(10.1)).toBe(10);
      });

      it('should handle values in valid range', () => {
        expect(validateMaxConcurrency(2)).toBe(2);
        expect(validateMaxConcurrency(15)).toBe(15);
        expect(validateMaxConcurrency(19)).toBe(19);
      });
    });

    describe('negative cases', () => {
      it('should clamp to 1 for values less than 1', () => {
        expect(validateMaxConcurrency(0)).toBe(1);
        expect(validateMaxConcurrency(-1)).toBe(1);
        expect(validateMaxConcurrency(-100)).toBe(1);
        expect(validateMaxConcurrency(-5.5)).toBe(1);
      });

      it('should clamp to 20 for values greater than 20', () => {
        expect(validateMaxConcurrency(21)).toBe(20);
        expect(validateMaxConcurrency(50)).toBe(20);
        expect(validateMaxConcurrency(100)).toBe(20);
        expect(validateMaxConcurrency(999)).toBe(20);
      });

      it('should handle negative decimals', () => {
        expect(validateMaxConcurrency(-0.5)).toBe(1);
        expect(validateMaxConcurrency(-3.7)).toBe(1);
      });
    });

    describe('edge cases', () => {
      it('should handle 0.5', () => {
        expect(validateMaxConcurrency(0.5)).toBe(1);
      });

      it('should handle 20.5', () => {
        expect(validateMaxConcurrency(20.5)).toBe(20);
      });

      it('should handle 0.999', () => {
        expect(validateMaxConcurrency(0.999)).toBe(1);
      });

      it('should handle very large numbers', () => {
        expect(validateMaxConcurrency(Number.MAX_SAFE_INTEGER)).toBe(20);
        expect(validateMaxConcurrency(1e10)).toBe(20);
      });

      it('should handle very small negative numbers', () => {
        expect(validateMaxConcurrency(-1e10)).toBe(1);
        expect(validateMaxConcurrency(-Number.MAX_SAFE_INTEGER)).toBe(1);
      });
    });
  });
});
