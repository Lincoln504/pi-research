/**
 * stackexchange Tool
 *
 * Search and retrieve data from Stack Exchange network via REST API v2.3.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { stackexchangeCommand } from '../stackexchange/index.ts';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';

export function createStackexchangeTool(options: {
  ctx: ExtensionContext;
  tracker: ToolUsageTracker;
}): ToolDefinition {
  const { tracker } = options;

  return {
    name: 'stackexchange',
    label: 'Stack Exchange Search',
    description: 'Search and retrieve data from Stack Exchange network via REST API v2.3 (anonymous: 300 requests/day, with key: 10,000 requests/day)',
    promptSnippet: 'Search Stack Overflow and other Stack Exchange sites for questions, answers, and user information',
    promptGuidelines: [
      'Available for finding technical answers on Stack Overflow',
      'Great for finding code solutions, debugging help, and best practices',
      'Works with any Stack Exchange site (Stack Overflow, SuperUser, AskUbuntu, etc.)',
      'Anonymous access: 300 requests/day. Set STACKEXCHANGE_API_KEY env var for 10,000/day.',
      'Use tags to filter by specific topics.',
      'CRITICAL: You are allowed a maximum of 4 gathering calls total across ALL tools. Use them for breadth.',
    ],
    parameters: Type.Object({
      command: Type.String({
        description: 'Command: search, get, user, or site',
      }),
      query: Type.Optional(Type.String({
        description: 'Search query (for search command)',
      })),
      id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
      site: Type.Optional(Type.String({
        description: 'Stack Exchange site (default: stackoverflow.com)',
      })),
      limit: Type.Optional(Type.Number({
        description: 'Results count (1-100, default: 10)',
        default: 10,
        minimum: 1,
        maximum: 100,
      })),
      format: Type.Optional(Type.String({
        description: 'Output format: table, json, or compact (default: table)',
        default: 'table',
      })),
      tags: Type.Optional(Type.String({
        description: 'Filter by tags (comma-separated)',
      })),
    }),
    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      extensionCtx,
    ): Promise<AgentToolResult<unknown>> {
      // Record call in tracker - returns false if limit reached
      const allowed = tracker.recordCall('stackexchange');
      if (!allowed) {
        // THROW to prevent researcher from calling again
        throw new Error(tracker.getLimitMessage('stackexchange'));
      }

      const paramsRecord = params as Record<string, unknown>;
      const command = paramsRecord['command'] as string;

      if (!command || typeof command !== 'string') {
        throw new Error('Stack Exchange command is required and must be a string');
      }

      try {
        return await stackexchangeCommand({
          command,
          params: paramsRecord,
          ctx: extensionCtx,
          signal,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `# Stack Exchange Search Failed\n\n**Error:** ${errorMsg}\n\n**Command:** ${command}\n\nFailed to query Stack Exchange. This may be due to API rate limiting (300/day anonymous, 10,000/day with key), network issues, or invalid query parameters.`,
            },
          ],
          details: {
            command,
            error: errorMsg,
          },
        };
      }
    },
  };
}
