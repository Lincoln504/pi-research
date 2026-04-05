/**
 * Session Context Formatter
 *
 * Formats parent session context for the coordinator agent.
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { buildSessionContext } from '@mariozechner/pi-coding-agent';
import type { AssistantMessage, UserMessage } from '@mariozechner/pi-ai';

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return typeof message === 'object' && message !== null && 'role' in message && (message as { role: string }).role === 'assistant';
}

function isUserMessage(message: unknown): message is UserMessage {
  return typeof message === 'object' && message !== null && 'role' in message && (message as { role: string }).role === 'user';
}

function extractTextContent(message: AssistantMessage | UserMessage): string {
  const content = message.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n');
  }

  return '';
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
      const text = extractTextContent(message);
      const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
      lines.push(`[User]: ${preview}`);
    } else if (isAssistantMessage(message)) {
      const text = extractTextContent(message);
      const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
      lines.push(`[Assistant]: ${preview}`);
    } else if (message.role === 'compactionSummary' || message.role === 'branchSummary') {
      const summaryContent = (message as any).summary || (message as any).content;
      if (typeof summaryContent === 'string') {
        const preview = summaryContent.length > 200 ? `${summaryContent.slice(0, 200)}...` : summaryContent;
        lines.push(`[System Summary]: ${preview}`);
      }
    }
  }

  return lines.join('\n');
}
