/**
 * Session Context Formatter Unit Tests
 *
 * Tests pure functions for formatting session context.
 * No external dependencies required.
 */

import { describe, it, expect } from 'vitest';

describe('orchestration/session-context', () => {
  // Import the functions we're testing
  const isAssistantMessage = (message: unknown): message is { role: 'assistant'; content: string | unknown[] } => {
    return typeof message === 'object' && message !== null && 'role' in message && (message as { role: string }).role === 'assistant';
  };

  const isUserMessage = (message: unknown): message is { role: 'user'; content: string | unknown[] } => {
    return typeof message === 'object' && message !== null && 'role' in message && (message as { role: string }).role === 'user';
  };

  const extractTextContent = (message: { role: string; content: string | unknown[] }): string => {
    const content = message.content;

    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .filter((block) => (block as { type?: string }).type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('\n');
    }

    return '';
  };

  const isMessageEntry = (entry: any): entry is { type: 'message'; message: { role: string; content: string | unknown[] } } => {
    return entry != null && entry.type === 'message';
  };

  const formatParentContext = (ctx: { sessionManager: { getBranch: () => any[] } }): string => {
    const entries = ctx.sessionManager.getBranch();

    // Filter for message entries only
    const messageEntries = entries.filter(isMessageEntry);

    // Take last 10 messages
    const lastMessages = messageEntries.slice(-10);

    if (lastMessages.length === 0) {
      return '';
    }

    // Format messages
    const formatted = lastMessages.map((entry) => {
      const message = entry.message;
      const role = message.role;
      const text = extractTextContent(message);

      return `${role}: ${text}`;
    });

    return formatted.join('\n\n');
  };

  describe('isAssistantMessage', () => {
    describe('positive cases', () => {
      it('should identify assistant message with string content', () => {
        const message = { role: 'assistant', content: 'Hello' };
        expect(isAssistantMessage(message)).toBe(true);
      });

      it('should identify assistant message with array content', () => {
        const message = { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] };
        expect(isAssistantMessage(message)).toBe(true);
      });

      it('should identify assistant message with empty string content', () => {
        const message = { role: 'assistant', content: '' };
        expect(isAssistantMessage(message)).toBe(true);
      });

      it('should identify assistant message with additional properties', () => {
        const message = { role: 'assistant', content: 'Hello', metadata: { key: 'value' } };
        expect(isAssistantMessage(message)).toBe(true);
      });
    });

    describe('negative cases', () => {
      it('should reject user message', () => {
        const message = { role: 'user', content: 'Hello' };
        expect(isAssistantMessage(message)).toBe(false);
      });

      it('should reject system message', () => {
        const message = { role: 'system', content: 'Hello' };
        expect(isAssistantMessage(message)).toBe(false);
      });

      it('should reject null', () => {
        expect(isAssistantMessage(null)).toBe(false);
      });

      it('should reject undefined', () => {
        expect(isAssistantMessage(undefined)).toBe(false);
      });

      it('should reject string', () => {
        expect(isAssistantMessage('assistant')).toBe(false);
      });

      it('should reject number', () => {
        expect(isAssistantMessage(123)).toBe(false);
      });

      it('should reject array', () => {
        expect(isAssistantMessage([])).toBe(false);
      });

      it('should reject object without role', () => {
        const message = { content: 'Hello' };
        expect(isAssistantMessage(message)).toBe(false);
      });

      it('should reject object with null role', () => {
        const message = { role: null, content: 'Hello' };
        expect(isAssistantMessage(message)).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should handle mixed case role', () => {
        const message = { role: 'Assistant', content: 'Hello' };
        expect(isAssistantMessage(message)).toBe(false);
      });

      it('should handle uppercase role', () => {
        const message = { role: 'ASSISTANT', content: 'Hello' };
        expect(isAssistantMessage(message)).toBe(false);
      });
    });
  });

  describe('isUserMessage', () => {
    describe('positive cases', () => {
      it('should identify user message with string content', () => {
        const message = { role: 'user', content: 'Hello' };
        expect(isUserMessage(message)).toBe(true);
      });

      it('should identify user message with array content', () => {
        const message = { role: 'user', content: [{ type: 'text', text: 'Hello' }] };
        expect(isUserMessage(message)).toBe(true);
      });

      it('should identify user message with empty string content', () => {
        const message = { role: 'user', content: '' };
        expect(isUserMessage(message)).toBe(true);
      });
    });

    describe('negative cases', () => {
      it('should reject assistant message', () => {
        const message = { role: 'assistant', content: 'Hello' };
        expect(isUserMessage(message)).toBe(false);
      });

      it('should reject system message', () => {
        const message = { role: 'system', content: 'Hello' };
        expect(isUserMessage(message)).toBe(false);
      });

      it('should reject null', () => {
        expect(isUserMessage(null)).toBe(false);
      });

      it('should reject undefined', () => {
        expect(isUserMessage(undefined)).toBe(false);
      });

      it('should reject object without role', () => {
        const message = { content: 'Hello' };
        expect(isUserMessage(message)).toBe(false);
      });
    });
  });

  describe('extractTextContent', () => {
    describe('positive cases', () => {
      it('should extract text from string content', () => {
        const message = { role: 'assistant', content: 'Hello, world!' };
        expect(extractTextContent(message)).toBe('Hello, world!');
      });

      it('should extract text from array content with text blocks', () => {
        const message = {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Line 1' },
            { type: 'text', text: 'Line 2' },
          ],
        };
        expect(extractTextContent(message)).toBe('Line 1\nLine 2');
      });

      it('should filter out non-text blocks', () => {
        const message = {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Line 1' },
            { type: 'thinking', content: 'Thinking...' },
            { type: 'text', text: 'Line 2' },
          ],
        };
        expect(extractTextContent(message)).toBe('Line 1\nLine 2');
      });

      it('should handle array with only text blocks', () => {
        const message = {
          role: 'assistant',
          content: [
            { type: 'text', text: 'First' },
            { type: 'text', text: 'Second' },
            { type: 'text', text: 'Third' },
          ],
        };
        expect(extractTextContent(message)).toBe('First\nSecond\nThird');
      });

      it('should handle empty string content', () => {
        const message = { role: 'assistant', content: '' };
        expect(extractTextContent(message)).toBe('');
      });

      it('should handle array with empty text blocks', () => {
        const message = {
          role: 'assistant',
          content: [{ type: 'text', text: '' }, { type: 'text', text: 'Hello' }],
        };
        expect(extractTextContent(message)).toBe('\nHello');
      });
    });

    describe('negative cases', () => {
      it('should return empty string for null content', () => {
        const message = { role: 'assistant', content: null } as unknown as { role: string; content: string | unknown[] };
        expect(extractTextContent(message)).toBe('');
      });

      it('should return empty string for undefined content', () => {
        const message = { role: 'assistant', content: undefined } as unknown as { role: string; content: string | unknown[] };
        expect(extractTextContent(message)).toBe('');
      });

      it('should return empty string for empty array', () => {
        const message = { role: 'assistant', content: [] };
        expect(extractTextContent(message)).toBe('');
      });

      it('should return empty string for array with no text blocks', () => {
        const message = {
          role: 'assistant',
          content: [
            { type: 'thinking', content: 'Thinking...' },
            { type: 'tool_call', tool: 'search' },
          ],
        };
        expect(extractTextContent(message)).toBe('');
      });

      it('should return empty string for array with malformed text blocks', () => {
        const message = {
          role: 'assistant',
          content: [
            { type: 'text' }, // Missing text property
            { type: 'other', data: 'test' },
          ],
        };
        expect(extractTextContent(message)).toBe('');
      });
    });

    describe('edge cases', () => {
      it('should handle very long string content', () => {
        const longText = 'A'.repeat(10000);
        const message = { role: 'assistant', content: longText };
        expect(extractTextContent(message)).toBe(longText);
      });

      it('should handle unicode characters', () => {
        const message = { role: 'assistant', content: '日本語 Тест emoji 🎉' };
        expect(extractTextContent(message)).toContain('日本語');
        expect(extractTextContent(message)).toContain('Тест');
        expect(extractTextContent(message)).toContain('🎉');
      });

      it('should handle special characters', () => {
        const message = { role: 'assistant', content: 'Hello & "quotes" and <html>' };
        expect(extractTextContent(message)).toBe('Hello & "quotes" and <html>');
      });

      it('should handle newlines in string content', () => {
        const message = { role: 'assistant', content: 'Line 1\nLine 2\nLine 3' };
        expect(extractTextContent(message)).toBe('Line 1\nLine 2\nLine 3');
      });
    });
  });

  describe('isMessageEntry', () => {
    describe('positive cases', () => {
      it('should identify message entry', () => {
        const entry = { type: 'message' };
        expect(isMessageEntry(entry)).toBe(true);
      });

      it('should identify message entry with additional properties', () => {
        const entry = { type: 'message', message: { role: 'user' } };
        expect(isMessageEntry(entry)).toBe(true);
      });
    });

    describe('negative cases', () => {
      it('should reject non-message entry', () => {
        const entry = { type: 'tool' };
        expect(isMessageEntry(entry)).toBe(false);
      });

      it('should reject null', () => {
        expect(isMessageEntry(null)).toBe(false);
      });

      it('should reject undefined', () => {
        expect(isMessageEntry(undefined)).toBe(false);
      });

      it('should reject object without type', () => {
        const entry = { id: 123 };
        expect(isMessageEntry(entry)).toBe(false);
      });

      it('should reject object with null type', () => {
        const entry = { type: null };
        expect(isMessageEntry(entry)).toBe(false);
      });

      it('should reject mixed case type', () => {
        const entry = { type: 'Message' };
        expect(isMessageEntry(entry)).toBe(false);
      });
    });
  });

  describe('formatParentContext', () => {
    describe('positive cases', () => {
      it('should format empty session', () => {
        const ctx = {
          sessionManager: {
            getBranch: () => [],
          },
        };
        expect(formatParentContext(ctx)).toBe('');
      });

      it('should format single user message', () => {
        const ctx = {
          sessionManager: {
            getBranch: () => [
              { type: 'message', message: { role: 'user', content: 'Hello' } },
            ],
          },
        };
        expect(formatParentContext(ctx)).toBe('user: Hello');
      });

      it('should format single assistant message', () => {
        const ctx = {
          sessionManager: {
            getBranch: () => [
              { type: 'message', message: { role: 'assistant', content: 'Hi there!' } },
            ],
          },
        };
        expect(formatParentContext(ctx)).toBe('assistant: Hi there!');
      });

      it('should format multiple messages', () => {
        const ctx = {
          sessionManager: {
            getBranch: () => [
              { type: 'message', message: { role: 'user', content: 'Question 1' } },
              { type: 'message', message: { role: 'assistant', content: 'Answer 1' } },
              { type: 'message', message: { role: 'user', content: 'Question 2' } },
            ],
          },
        };
        expect(formatParentContext(ctx)).toBe('user: Question 1\n\nassistant: Answer 1\n\nuser: Question 2');
      });

      it('should limit to last 10 messages', () => {
        const messages = Array.from({ length: 15 }, (_, i) => ({
          type: 'message',
          message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i + 1}` },
        }));

        const ctx = {
          sessionManager: {
            getBranch: () => messages,
          },
        };

        const result = formatParentContext(ctx);
        expect(result).toContain('Message 6'); // First of last 10
        expect(result).toContain('Message 15'); // Last message
        expect(result).not.toContain('Message 5'); // Before last 10
      });

      it('should filter out non-message entries', () => {
        const ctx = {
          sessionManager: {
            getBranch: () => [
              { type: 'tool', name: 'search' },
              { type: 'message', message: { role: 'user', content: 'Hello' } },
              { type: 'tool', name: 'scrape' },
              { type: 'message', message: { role: 'assistant', content: 'Hi!' } },
            ],
          },
        };
        expect(formatParentContext(ctx)).toBe('user: Hello\n\nassistant: Hi!');
      });

      it('should handle array content in messages', () => {
        const ctx = {
          sessionManager: {
            getBranch: () => [
              {
                type: 'message',
                message: {
                  role: 'user',
                  content: [{ type: 'text', text: 'Line 1' }, { type: 'text', text: 'Line 2' }],
                },
              },
            ],
          },
        };
        expect(formatParentContext(ctx)).toBe('user: Line 1\nLine 2');
      });
    });

    describe('negative cases', () => {
      it('should handle messages with empty content', () => {
        const ctx = {
          sessionManager: {
            getBranch: () => [
              { type: 'message', message: { role: 'user', content: '' } },
              { type: 'message', message: { role: 'assistant', content: 'Hi!' } },
            ],
          },
        };
        expect(formatParentContext(ctx)).toBe('user: \n\nassistant: Hi!');
      });

      it('should handle messages with null content', () => {
        const ctx = {
          sessionManager: {
            getBranch: () => [
              { type: 'message', message: { role: 'user', content: null } },
            ],
          },
        };
        expect(formatParentContext(ctx)).toBe('user: ');
      });

      it('should handle messages with no text blocks', () => {
        const ctx = {
          sessionManager: {
            getBranch: () => [
              {
                type: 'message',
                message: {
                  role: 'user',
                  content: [{ type: 'thinking', content: 'Thinking...' }],
                },
              },
            ],
          },
        };
        expect(formatParentContext(ctx)).toBe('user: ');
      });
    });

    describe('edge cases', () => {
      it('should handle very long messages', () => {
        const longText = 'A'.repeat(10000);
        const ctx = {
          sessionManager: {
            getBranch: () => [
              { type: 'message', message: { role: 'user', content: longText } },
            ],
          },
        };
        expect(formatParentContext(ctx)).toBe(`user: ${longText}`);
      });

      it('should handle unicode in messages', () => {
        const ctx = {
          sessionManager: {
            getBranch: () => [
              { type: 'message', message: { role: 'user', content: '日本語 🎉' } },
              { type: 'message', message: { role: 'assistant', content: 'Тест emoji' } },
            ],
          },
        };
        expect(formatParentContext(ctx)).toContain('日本語 🎉');
        expect(formatParentContext(ctx)).toContain('Тест emoji');
      });

      it('should handle exactly 10 messages', () => {
        const messages = Array.from({ length: 10 }, (_, i) => ({
          type: 'message',
          message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i + 1}` },
        }));

        const ctx = {
          sessionManager: {
            getBranch: () => messages,
          },
        };

        const result = formatParentContext(ctx);
        expect(result).toContain('Message 1');
        expect(result).toContain('Message 10');
      });
    });
  });
});
