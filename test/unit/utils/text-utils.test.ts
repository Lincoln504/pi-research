/**
 * Text Utilities Unit Tests
 *
 * Tests pure functions that don't require refactoring.
 * Can run immediately with existing code.
 */

import { describe, it, expect } from 'vitest';
import { extractText } from '../../../src/utils/text-utils';

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

    it('should return empty string for null message', () => {
      expect(extractText(null)).toBe('');
    });

    it('should return empty string for undefined message', () => {
      expect(extractText(undefined)).toBe('');
    });

    it('should return empty string for message without content', () => {
      expect(extractText({})).toBe('');
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
});
