/**
 * Text Utilities Unit Tests
 *
 * Tests pure functions that don't require refactoring.
 * Can run immediately with existing code.
 */

import { describe, it, expect } from 'vitest';
import { extractText, ensureAssistantResponse } from '../../../src/utils/text-utils';

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

    it('should throw if last assistant message has zero text blocks', () => {
      const session = {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: [] }, // Empty array = zero text blocks
        ],
      } as any;
      expect(() => ensureAssistantResponse(session, 'Test'))
        .toThrow('Test: Researcher produced no text output');
    });

    it('should throw if last assistant message has only non-text blocks', () => {
      const session = {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: [
            { type: 'thinking', content: 'Internal reasoning...' },
            { type: 'tool_call', tool: 'search', args: { query: 'test' } },
          ] },
        ],
      } as any;
      expect(() => ensureAssistantResponse(session, 'Test'))
        .toThrow('Test: Researcher produced no text output');
    });
  });
});
