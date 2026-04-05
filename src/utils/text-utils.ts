import type { AgentSession } from '@mariozechner/pi-coding-agent';
import type { AssistantMessage } from '@mariozechner/pi-ai';

/**
 * Text Utilities
 *
 * Shared text extraction and formatting functions.
 */

/**
 * Extract text content from a message
 *
 * Handles various message content formats:
 * - String content
 * - Array of content blocks (TextContent, ThinkingContent, ToolCall, etc.)
 * - Accepts any object with a content field for robustness
 *
 * @param message - Message object with content field, or undefined/null
 * @returns Extracted text string, or empty string if invalid
 */
export function extractText(message: unknown): string {
  // Validate message exists and is an object
  if (!message || typeof message !== 'object') {
    return '';
  }

  const msg = message as Record<string, unknown>;
  const { content } = msg;

  // Handle string content
  if (typeof content === 'string') {
    return content;
  }

  // Handle array of content blocks
  if (Array.isArray(content)) {
    try {
      return (content as unknown[])
        .filter((b) => b && typeof b === 'object' && (b as Record<string, unknown>)['type'] === 'text')
        .map((b) => {
          const blockObj = b as Record<string, unknown>;
          const text = blockObj['text'];
          return typeof text === 'string' ? text : '';
        })
        .filter((t: string) => t.length > 0) // Filter empty strings
        .join('\n');
    } catch (_error) {
      // If array processing fails, return empty string
    }
  }

  // Unknown content format
  return '';
}

/**
 * Ensures the assistant completed successfully and returns the text content.
 * Throws an error if the assistant failed or stopped with an error.
 * 
 * @param session - The agent session to check
 * @param label - Label for error reporting
 * @returns The extracted text content
 * @throws Error if assistant failed
 */
export function ensureAssistantResponse(session: AgentSession, label: string): string {
  const msgs = session.messages;
  const last = [...msgs].reverse().find((m) => m.role === 'assistant') as AssistantMessage | undefined;

  if (!last) {
    throw new Error(`${label}: No assistant response found`);
  }

  // Check for explicit error stop reason or error message
  if (last.stopReason === 'error' || (last.errorMessage && last.stopReason !== 'aborted')) {
    throw new Error(`${label}: Provider error - ${last.errorMessage || 'Unknown error'}`);
  }

  return extractText(last);
}
