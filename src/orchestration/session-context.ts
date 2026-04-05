/**
 * Session Context Formatter
 *
 * Formats parent session context for the coordinator agent.
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { buildSessionContext } from '@mariozechner/pi-coding-agent';
import type { AssistantMessage, UserMessage } from '@mariozechner/pi-ai';
import { extractText } from '../utils/text-utils.ts';

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return typeof message === 'object' && message !== null && 'role' in message && (message as { role: string }).role === 'assistant';
}

function isUserMessage(message: unknown): message is UserMessage {
  return typeof message === 'object' && message !== null && 'role' in message && (message as { role: string }).role === 'user';
}

/**
 * Create a preview of text truncated to 200 characters
 */
function createPreview(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

export function formatParentContext(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch();
  const sessionContext = buildSessionContext(branch);
  const allMessages = sessionContext.messages;

  // Take last 10 messages
  const lastMessages = allMessages.slice(-10);

  if (lastMessages.length === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push('Context:');

  for (const message of lastMessages) {
    if (isUserMessage(message)) {
      const text = extractText(message);
      const preview = createPreview(text);
      lines.push(`[User]: ${preview}`);
    } else if (isAssistantMessage(message)) {
      const text = extractText(message);
      const preview = createPreview(text);
      lines.push(`[Assistant]: ${preview}`);
    } else if (message.role === 'compactionSummary' || message.role === 'branchSummary') {
      const summaryContent = (message as any).summary || (message as any).content;
      if (typeof summaryContent === 'string') {
        const preview = createPreview(summaryContent);
        lines.push(`[System Summary]: ${preview}`);
      }
    }
  }

  return lines.join('\n');
}
