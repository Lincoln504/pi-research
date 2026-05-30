import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { logger } from '../logger.ts';

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
    const msg = last.errorMessage || 'Unknown error';
    if (msg.includes('429')) {
      throw new Error(`Model API rate limit (429) — wait a moment and retry. Details: ${msg}`);
    }
    throw new Error(`${label}: Provider error - ${msg}`);
  }

  // Warn if the response was truncated due to token limit
  if (last.stopReason === 'length') {
    const text = extractText(last);
    if (text.trim()) {
      logger.warn(`${label}: Response truncated by token limit — returning partial result`);
      return text;
    }
    throw new Error(`${label}: Response was truncated by token limit and produced no usable text.`);
  }

  const text = extractText(last);
  if (!text.trim()) {
    // No text content blocks in the final assistant message. This typically means
    // all tool calls failed and the model produced only
    // thinking blocks, or the session ended without a visible response.
    throw new Error(
      `${label}: Researcher produced no text output. ` +
      `This usually means the browser-based search engine was unavailable during the run — check system resources and retry.`
    );
  }
  return text;
}

export interface Citation {
  url: string;
  description: string;
  source?: string;
}

/**
 * Parses the CITED LINKS section from a researcher report, extracting URLs, sources, and their descriptions.
 * Handles both single-line 'URL - description' and multi-line 'Source:'/'Description:' formats.
 */
export function parseCitations(report: string): Citation[] {
  const sectionMatch = /###\s*CITED LINKS[\s\S]*$/i.exec(report);
  if (!sectionMatch) return [];
  const section = sectionMatch[0];

  const citations: Citation[] = [];
  // Match [N] or N. or **[N]** or **N.** with optional whitespace
  const blocks = section.split(/(?:\*\*|)\s*(?:\[\d+\]|\d+\.)\s*(?:\*\*|)/).slice(1);
  
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length === 0) continue;
    
    const firstLine = lines[0]!.trim();
    let url: string;
    let desc = '';
    let source = '';
    
    // Handles both plain inline format (URL — desc) and the format produced by
    // the researcher prompt template: URL [Source: Fresh Scrape] — desc.
    // Group 1: URL, Group 2: optional source tag contents, Group 3: description.
    const inlineMatch = /^(https?:\/\/[^\s\n]+)(?:\s+\[Source:\s*([^\]]*)\])?(?:\s*[—–-]\s*([^\n]*))?/.exec(firstLine);
    if (inlineMatch) {
      url = inlineMatch[1]!.trim().replace(/[*_~`]+$/, '').replace(/[,.)]+$/, '');
      source = (inlineMatch[2]?.trim() || '');
      desc = (inlineMatch[3]?.trim() || '').replace(/[*_~`]+$/, '');
    } else {
      const candidateUrl = firstLine.split(/\s+/)[0]!.trim().replace(/[*_~`]+$/, '').replace(/[,.)]+$/, '');
      if (!candidateUrl.startsWith('http')) continue;
      url = candidateUrl;
    }
    
    const descLines = [];
    let foundDescTag = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line.match(/^Source:/i)) {
        source = line.replace(/^Source:\s*/i, '').trim();
        continue;
      }
      if (!foundDescTag) {
        if (line.match(/^Description:/i)) {
          foundDescTag = true;
          descLines.push(line.replace(/^Description:\s*/i, ''));
        }
      } else {
        descLines.push(line);
      }
    }
    
    if (descLines.length > 0) {
      desc = descLines.join('\n').trim();
    }
    
    if (url) {
      citations.push({ url, description: desc, source });
    }
  }
  return citations;
}
