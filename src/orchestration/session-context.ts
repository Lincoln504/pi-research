/**
 * Session Context Formatter
 *
 * Formats the full parent session context for the initial coordinator.
 * Returns the uncompacted history of the current conversation branch.
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { 
  buildSessionContext, 
  convertToLlm, 
  serializeConversation 
} from '@mariozechner/pi-coding-agent';

/**
 * Formats parent context for the initial coordinator.
 * Provides the full linear history of the current branch.
 */
export async function formatParentContext(ctx: ExtensionContext): Promise<string> {
  const branch = ctx.sessionManager.getBranch();
  const sessionContext = buildSessionContext(branch);
  const allMessages = sessionContext.messages;

  if (allMessages.length === 0) {
    return 'No previous context available.';
  }

  const llmMessages = convertToLlm(allMessages);
  const serialized = serializeConversation(llmMessages);
    
  return [
    '## Parent Conversation History',
    'The following is the full history of the current conversation branch for your reference:',
    '',
    serialized
  ].join('\n');
}
