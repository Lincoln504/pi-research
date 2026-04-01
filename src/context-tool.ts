/**
 * Context Investigation Tool
 *
 * Allows the coordinator to inspect the project context without spawning a full researcher.
 * Uses only read and rg_grep tools - no web search or scraping.
 */

import type { ToolDefinition, AgentToolResult, ModelRegistry } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { createAgentSession, createReadTool, SessionManager, SettingsManager } from '@mariozechner/pi-coding-agent';
import { rgGrepTool } from './rg-grep.js';
import { makeResourceLoader } from './make-resource-loader.js';

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

      console.log(`[context] Investigating project context: ${question.slice(0, 50)}...`);

      const { session } = await createAgentSession({
        cwd: options.cwd,
        tools: [createReadTool(options.cwd)],
        customTools: [rgGrepTool], // read + rg only, no search/scrape
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
        model: options.ctxModel,
        modelRegistry: options.modelRegistry,
        resourceLoader: makeResourceLoader('You investigate project context. Use read and rg_grep only.'),
      });

      await session.prompt(question);

      const msgs = session.messages;
      const last = [...msgs].reverse().find((m) => m.role === 'assistant');
      const text = extractText(last);

      console.log('[context] Investigation complete');
      return { content: [{ type: 'text', text }], details: {} };
    },
  };
}
