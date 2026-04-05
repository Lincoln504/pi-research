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
 *
 * @param message - Message object with content field
 * @returns Extracted text string, or empty string if invalid
 */
export function extractText(message: any): string {
  // Validate message exists
  if (!message || typeof message !== 'object') {
    return '';
  }

  // Handle string content
  if (typeof message.content === 'string') {
    return message.content;
  }

  // Handle array of content blocks
  if (Array.isArray(message.content)) {
    try {
      return message.content
        .filter((b: any) => b && typeof b === 'object' && b.type === 'text')
        .map((b: any) => {
          // Safely extract text, validate it's a string
          const text = b.text;
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
