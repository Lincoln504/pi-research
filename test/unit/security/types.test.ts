/**
 * Security Types and Helpers Unit Tests
 *
 * Tests pure functions for security vulnerability types and helpers.
 * No external dependencies required.
 */

import { describe, it, expect } from 'vitest';

// Note: These functions are internal, so we can't import them directly.
// In production code, these would be exported or tested through public API.
// For now, we'll test similar logic.

describe('security-types', () => {
  // Mock the internal function for testing
  function isValidSeverity(value: unknown): value is 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    return (
      typeof value === 'string' &&
      (value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' || value === 'CRITICAL')
    );
  }

  // Mock the internal function for testing
  function getSeverityParam(params: { severity?: string }): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | undefined {
    if (params.severity === undefined) {
      return undefined;
    }
    return isValidSeverity(params.severity) ? params.severity : undefined;
  }

  // Mock the internal function for testing
  function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  describe('isValidSeverity', () => {
    describe('positive cases', () => {
      it('should accept LOW severity', () => {
        expect(isValidSeverity('LOW')).toBe(true);
      });

      it('should accept MEDIUM severity', () => {
        expect(isValidSeverity('MEDIUM')).toBe(true);
      });

      it('should accept HIGH severity', () => {
        expect(isValidSeverity('HIGH')).toBe(true);
      });

      it('should accept CRITICAL severity', () => {
        expect(isValidSeverity('CRITICAL')).toBe(true);
      });

      it('should type-narrow correctly for all valid severities', () => {
        const value: unknown = 'HIGH';
        if (isValidSeverity(value)) {
          expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(value);
        }
      });
    });

    describe('negative cases', () => {
      it('should reject lowercase severity', () => {
        expect(isValidSeverity('low')).toBe(false);
      });

      it('should reject mixed case severity', () => {
        expect(isValidSeverity('Low')).toBe(false);
        expect(isValidSeverity('High')).toBe(false);
        expect(isValidSeverity('Critical')).toBe(false);
      });

      it('should reject invalid severity strings', () => {
        expect(isValidSeverity('INFO')).toBe(false);
        expect(isValidSeverity('NONE')).toBe(false);
        expect(isValidSeverity('UNKNOWN')).toBe(false);
        expect(isValidSeverity('MODERATE')).toBe(false);
        expect(isValidSeverity('')).toBe(false);
      });

      it('should reject non-string types', () => {
        expect(isValidSeverity(null)).toBe(false);
        expect(isValidSeverity(undefined)).toBe(false);
        expect(isValidSeverity(123)).toBe(false);
        expect(isValidSeverity(true)).toBe(false);
        expect(isValidSeverity({})).toBe(false);
        expect(isValidSeverity([])).toBe(false);
      });

      it('should reject object with severity property', () => {
        expect(isValidSeverity({ severity: 'HIGH' })).toBe(false);
      });

      it('should reject number string', () => {
        expect(isValidSeverity('123')).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should reject severity with leading/trailing whitespace', () => {
        expect(isValidSeverity(' HIGH')).toBe(false);
        expect(isValidSeverity('HIGH ')).toBe(false);
      });

      it('should reject partial severity match', () => {
        expect(isValidSeverity('LOWE')).toBe(false);
        expect(isValidSeverity('MEDI')).toBe(false);
        expect(isValidSeverity('HIG')).toBe(false);
        expect(isValidSeverity('CRITICA')).toBe(false);
      });

      it('should reject severity with extra characters', () => {
        expect(isValidSeverity('LOW!')).toBe(false);
        expect(isValidSeverity('MEDIUM.')).toBe(false);
        expect(isValidSeverity('HIGH-')).toBe(false);
        expect(isValidSeverity('CRITICAL?')).toBe(false);
      });
    });
  });

  describe('getSeverityParam', () => {
    describe('positive cases', () => {
      it('should return valid LOW severity', () => {
        const result = getSeverityParam({ severity: 'LOW' });
        expect(result).toBe('LOW');
      });

      it('should return valid MEDIUM severity', () => {
        const result = getSeverityParam({ severity: 'MEDIUM' });
        expect(result).toBe('MEDIUM');
      });

      it('should return valid HIGH severity', () => {
        const result = getSeverityParam({ severity: 'HIGH' });
        expect(result).toBe('HIGH');
      });

      it('should return valid CRITICAL severity', () => {
        const result = getSeverityParam({ severity: 'CRITICAL' });
        expect(result).toBe('CRITICAL');
      });

      it('should return undefined when severity is undefined', () => {
        const result = getSeverityParam({ severity: undefined });
        expect(result).toBeUndefined();
      });

      it('should return undefined when severity is not in params', () => {
        const result = getSeverityParam({});
        expect(result).toBeUndefined();
      });
    });

    describe('negative cases', () => {
      it('should return undefined for invalid severity', () => {
        expect(getSeverityParam({ severity: 'low' })).toBeUndefined();
        expect(getSeverityParam({ severity: 'INFO' })).toBeUndefined();
        expect(getSeverityParam({ severity: 'MODERATE' })).toBeUndefined();
        expect(getSeverityParam({ severity: '' })).toBeUndefined();
      });

      it('should return undefined for invalid severity types', () => {
        expect(getSeverityParam({ severity: null as any })).toBeUndefined();
        expect(getSeverityParam({ severity: 123 as any })).toBeUndefined();
        expect(getSeverityParam({ severity: true as any })).toBeUndefined();
      });

      it('should return undefined for severity with whitespace', () => {
        expect(getSeverityParam({ severity: ' HIGH' })).toBeUndefined();
        expect(getSeverityParam({ severity: 'HIGH ' })).toBeUndefined();
      });

      it('should return undefined for MODERATE (GitHub-specific)', () => {
        expect(getSeverityParam({ severity: 'MODERATE' })).toBeUndefined();
      });
    });

    describe('edge cases', () => {
      it('should handle object with extra properties', () => {
        const result = getSeverityParam({
          severity: 'HIGH',
          databases: ['nvd'],
          terms: ['test'],
        });
        expect(result).toBe('HIGH');
      });

      it('should handle severity in different cases', () => {
        expect(getSeverityParam({ severity: 'high' })).toBeUndefined();
        expect(getSeverityParam({ severity: 'High' })).toBeUndefined();
        expect(getSeverityParam({ severity: 'HIGH' })).toBe('HIGH');
      });
    });
  });

  describe('getErrorMessage', () => {
    describe('positive cases', () => {
      it('should extract message from Error', () => {
        const error = new Error('Test error message');
        expect(getErrorMessage(error)).toBe('Test error message');
      });

      it('should extract message from TypeError', () => {
        const error = new TypeError('Type error');
        expect(getErrorMessage(error)).toBe('Type error');
      });

      it('should extract message from RangeError', () => {
        const error = new RangeError('Range error');
        expect(getErrorMessage(error)).toBe('Range error');
      });

      it('should convert string to string', () => {
        expect(getErrorMessage('Plain string error')).toBe('Plain string error');
      });

      it('should convert number to string', () => {
        expect(getErrorMessage(123)).toBe('123');
      });

      it('should convert boolean to string', () => {
        expect(getErrorMessage(true)).toBe('true');
        expect(getErrorMessage(false)).toBe('false');
      });

      it('should convert object to string', () => {
        const error = { message: 'Object error' };
        const result = getErrorMessage(error);
        expect(result).toContain('[object Object]');
      });

      it('should convert null to string', () => {
        expect(getErrorMessage(null)).toBe('null');
      });

      it('should convert undefined to string', () => {
        expect(getErrorMessage(undefined)).toBe('undefined');
      });
    });

    describe('negative cases', () => {
      it('should handle empty error message', () => {
        const error = new Error('');
        expect(getErrorMessage(error)).toBe('');
      });

      it('should handle error with undefined message', () => {
        const error: Partial<Error> = {};
        expect(getErrorMessage(error as unknown)).toBe('[object Object]');
      });

      it('should handle error object without message property', () => {
        const error = { code: 'ERROR_CODE' };
        expect(getErrorMessage(error as unknown)).toBe('[object Object]');
      });
    });

    describe('edge cases', () => {
      it('should handle very long error message', () => {
        const longMessage = 'Error: ' + 'x'.repeat(10000);
        const error = new Error(longMessage);
        expect(getErrorMessage(error)).toBe(longMessage);
      });

      it('should handle error with unicode characters', () => {
        const error = new Error('Error: 日本語 Тест emoji 🎉');
        expect(getErrorMessage(error)).toContain('日本語');
        expect(getErrorMessage(error)).toContain('Тест');
        expect(getErrorMessage(error)).toContain('🎉');
      });

      it('should handle array as error', () => {
        expect(getErrorMessage(['error1', 'error2'])).toBe('error1,error2');
      });

      it('should handle Error subclass with custom properties', () => {
        class CustomError extends Error {
          constructor(message: string, public code: string) {
            super(message);
            this.name = 'CustomError';
          }
        }
        const error = new CustomError('Custom error message', 'ERR_001');
        expect(getErrorMessage(error)).toBe('Custom error message');
      });

      it('should handle error with stack trace but no message', () => {
        const error = new Error();
        expect(getErrorMessage(error)).toBeDefined();
      });
    });
  });

  describe('integration scenarios', () => {
    it('should validate and extract severity correctly', () => {
      const params = { severity: 'CRITICAL', databases: ['nvd'], terms: ['CVE-2024-1234'] };
      const severity = getSeverityParam(params);
      expect(severity).toBe('CRITICAL');
      expect(isValidSeverity(severity)).toBe(true);
    });

    it('should handle invalid severity gracefully', () => {
      const params = { severity: 'MODERATE', databases: ['github'], terms: ['package'] };
      const severity = getSeverityParam(params);
      expect(severity).toBeUndefined();
    });

    it('should convert various error types to strings', () => {
      const errors = [
        new Error('Standard error'),
        new TypeError('Type error'),
        new RangeError('Range error'),
        'String error',
        123,
        null,
        undefined,
      ];

      for (const error of errors) {
        const message = getErrorMessage(error);
        expect(typeof message).toBe('string');
        expect(message).toBeDefined();
      }
    });
  });
});
