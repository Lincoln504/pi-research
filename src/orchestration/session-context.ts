/**
 * Session Context Formatter
 *
 * Formats parent session context for the coordinator agent.
 * Implements a "fork vs compact" strategy:
 * - Low token count: Returns a serialized conversation history (last 15 messages).
 * - High token count: Returns a compacted summary of the conversation.
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { 
  buildSessionContext, 
  estimateTokens, 
  convertToLlm, 
  serializeConversation 
} from '@mariozechner/pi-coding-agent';
import { complete } from '@mariozechner/pi-ai';
import { logger } from '../logger.ts';

const CONTEXT_THRESHOLD_TOKENS = 2000;
const MAX_MESSAGES_FOR_FORK = 15;

const COMPACTION_PROMPT = `You are a context transfer assistant. Given the conversation history, generate a focused, compact summary that:
1. Summarizes the core goal and specific progress made so far.
2. Lists any key decisions, findings, or identified constraints.
3. Clearly state the current problem or task to be researched.
Keep the summary concise and objective. Avoid conversational filler.`;

/**
 * Formats parent context for the coordinator.
 * Returns either a direct conversation history or a compacted summary based on token count.
 */
export async function formatParentContext(ctx: ExtensionContext): Promise<string> {
  const branch = ctx.sessionManager.getBranch();
  const sessionContext = buildSessionContext(branch);
  const allMessages = sessionContext.messages;

  if (allMessages.length === 0) {
    return 'No previous context available.';
  }

  // 1. Estimate tokens for the entire branch
  const llmMessages = convertToLlm(allMessages);
  const totalTokens = llmMessages.reduce((acc, msg) => acc + estimateTokens(msg), 0);

  logger.log(`[session-context] Parent branch has ~${totalTokens} tokens and ${allMessages.length} messages.`);

  // 2. Decide: Fork (Direct Messages) vs Compact (Summary)
  if (totalTokens < CONTEXT_THRESHOLD_TOKENS) {
    // --- FORK MODE: Provide actual history ---
    const lastMessages = allMessages.slice(-MAX_MESSAGES_FOR_FORK);
    const serialized = serializeConversation(convertToLlm(lastMessages));
    
    return [
      '## Recent Conversation History',
      'The following is a direct excerpt from the current conversation:',
      '',
      serialized
    ].join('\n');
  } else {
    // --- COMPACT MODE: Provide LLM-generated summary ---
    logger.log('[session-context] Threshold exceeded. Generating compacted context summary...');
    
    try {
      if (!ctx.model) {
        throw new Error('No model available for compaction.');
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok) {
        throw new Error(`Auth failed: ${auth.error}`);
      }
      if (!auth.apiKey) {
        throw new Error('Auth failed: No API key');
      }

      const conversationText = serializeConversation(llmMessages);
      const response = await complete(
        ctx.model,
        { 
          systemPrompt: COMPACTION_PROMPT, 
          messages: [
            { 
              role: 'user', 
              content: [{ type: 'text', text: `## Conversation History\n\n${conversationText}` }],
              timestamp: Date.now()
            }
          ] 
        },
        { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal }
      );

      const summary = response.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');

      return [
        '## Compacted Context Summary',
        'The following is a summary of the parent conversation (compacted due to length):',
        '',
        summary
      ].join('\n');
    } catch (error) {
      logger.error('[session-context] Failed to generate compacted summary:', error);
      // Fallback: Just return the last few messages if summary fails
      const lastMessages = allMessages.slice(-5);
      const serialized = serializeConversation(convertToLlm(lastMessages));
      return `## Recent Context (Summary Failed)\n\n${serialized}`;
    }
  }
}
