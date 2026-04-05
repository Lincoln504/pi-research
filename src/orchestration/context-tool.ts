/**
 * Context Investigation Tool
 *
 * Allows the coordinator to inspect the project context without spawning a full researcher.
 * Uses only read and rg_grep tools - no web search or scraping.
 */

import type { ToolDefinition, AgentToolResult, ModelRegistry } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { createAgentSession, createReadTool, SessionManager, SettingsManager } from '@mariozechner/pi-coding-agent';
import { createGrepTool } from '../tools/grep.ts';
import { makeResourceLoader } from '../make-resource-loader.ts';
import { logger } from '../logger.ts';

export interface ContextToolOptions {
  cwd: string;
  ctxModel: any; // Model<any> | undefined
  modelRegistry: ModelRegistry;
}

/**
 * Extract text content from a message
 */
function extractText(message: any): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
  }
  return '';
}

/**
 * Create the investigate_context tool definition
 */
export function createInvestigateContextTool(options: ContextToolOptions): ToolDefinition {
  return {
    name: 'investigate_context',
    label: 'Investigate Context',
    description: 'Inspect the local project codebase (read + grep only, no web search)',
    parameters: Type.Object({
      question: Type.String({
        description: 'What to investigate in the project context',
      }),
    }),
    async execute(
      _id: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown
    ): Promise<AgentToolResult<unknown>> {
      const { question } = params as { question: string };

      if (!question || typeof question !== 'string') {
        logger.error('[context] Invalid question parameter');
        return {
          content: [{ type: 'text', text: 'Error: question is required and must be a string' }],
          details: {},
        };
      }

      logger.log(`[context] Investigating project context: ${question.slice(0, 50)}...`);

      let session;
      try {
        const result = await createAgentSession({
          cwd: options.cwd,
          tools: [createReadTool(options.cwd)],
          customTools: [createGrepTool()], // read + rg only, no search/scrape
          sessionManager: SessionManager.inMemory(),
          settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
          model: options.ctxModel,
          modelRegistry: options.modelRegistry,
          resourceLoader: makeResourceLoader('You investigate project context. Use read and rg_grep only.'),
        });
        session = result.session;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error('[context] Failed to create session:', errorMsg);
        return {
          content: [{ type: 'text', text: `Error: Failed to create context investigation session: ${errorMsg}` }],
          details: {},
        };
      }

      try {
        await session.prompt(question);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error('[context] Prompt failed:', errorMsg);
        session.abort().catch(() => {});
        return {
          content: [{ type: 'text', text: `Error: Context investigation failed: ${errorMsg}` }],
          details: {},
        };
      }

      const msgs = session.messages;
      const last = [...msgs].reverse().find((m) => m.role === 'assistant');

      if (!last) {
        logger.error('[context] No assistant message in response');
        return {
          content: [{ type: 'text', text: 'Error: No response from context investigation' }],
          details: {},
        };
      }

      if (last.stopReason === 'error' || (last.errorMessage && last.stopReason !== 'aborted')) {
        const errorMsg = last.errorMessage || last.stopReason || 'Unknown error';
        logger.error('[context] Provider error:', errorMsg);
        return {
          content: [{ type: 'text', text: `Error: Context investigation encountered provider error: ${errorMsg}` }],
          details: {},
        };
      }

      const text = extractText(last);
      if (!text || text.trim().length === 0) {
        logger.warn('[context] Investigation returned empty response');
        return {
          content: [{ type: 'text', text: 'Warning: Context investigation returned no usable output' }],
          details: {},
        };
      }

      logger.log('[context] Investigation complete');
      return { content: [{ type: 'text', text }], details: {} };
    },
  };
}
