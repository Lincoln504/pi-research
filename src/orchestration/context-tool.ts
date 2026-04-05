/**
 * Context Investigation Tool
 *
 * Allows the coordinator to inspect the project context without spawning a full researcher.
 * Uses only read and rg_grep tools - no web search or scraping.
 */

import type { ToolDefinition, AgentToolResult, ModelRegistry, AgentSession } from '@mariozechner/pi-coding-agent';
import type { Model } from '@mariozechner/pi-ai';
import { Type } from '@sinclair/typebox';
import { createAgentSession, createReadTool, SessionManager, SettingsManager } from '@mariozechner/pi-coding-agent';
import { createGrepTool } from '../tools/grep.ts';
import { makeResourceLoader } from '../utils/make-resource-loader.ts';
import { ToolUsageTracker, createDefaultToolLimits } from '../utils/tool-usage-tracker.ts';
import { logger } from '../logger.ts';
import { ensureAssistantResponse } from '../utils/text-utils.ts';

export interface ContextToolOptions {
  cwd: string;
  ctxModel: Model<any> | undefined;
  modelRegistry: ModelRegistry;
}

/**
 * Validate context tool parameters
 */
function validateContextParams(params: unknown): { question: string } {
  if (typeof params !== 'object' || params === null) {
    throw new Error('Invalid parameters: must be an object');
  }

  const question = (params as Record<string, unknown>)['question'];
  
  if (typeof question !== 'string') {
    throw new Error('Invalid question: must be a string');
  }
  
  if (!question.trim()) {
    throw new Error('Invalid question: cannot be empty');
  }
  
  return { question };
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
      try {
        const { question } = validateContextParams(params);

        logger.log(`[context] Investigating project context: ${question.slice(0, 50)}...`);

        // Create tracker for context investigation
        const tracker = new ToolUsageTracker(createDefaultToolLimits());

        let session: AgentSession;
        try {
          const result = await createAgentSession({
            cwd: options.cwd,
            tools: [createReadTool(options.cwd)],
            customTools: [createGrepTool({ tracker })], // read + rg only, no search/scrape
            sessionManager: SessionManager.inMemory(),
            settingsManager: SettingsManager.inMemory({ compaction: { enabled: true } }),
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
          const text = ensureAssistantResponse(session, 'context');
          
          if (!text || text.trim().length === 0) {
            logger.warn('[context] Investigation returned empty response');
            return {
              content: [{ type: 'text', text: 'Warning: Context investigation returned no usable output' }],
              details: {},
            };
          }

          logger.log('[context] Investigation complete');
          return { content: [{ type: 'text', text }], details: {} };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error('[context] Prompt failed:', errorMsg);
          session.abort().catch(() => {});
          return {
            content: [{ type: 'text', text: `Error: Context investigation failed: ${errorMsg}` }],
            details: {},
          };
        }
      } catch (validationError) {
        const errorMsg = validationError instanceof Error ? validationError.message : String(validationError);
        logger.error('[context] Parameter validation failed:', errorMsg);
        return {
          content: [{ type: 'text', text: `Error: ${errorMsg}` }],
          details: {},
        };
      }
    },
  };
}