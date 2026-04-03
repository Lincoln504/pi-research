/**
 * pi_stackexchange Tool
 *
 * Search and retrieve data from Stack Exchange network via REST API v2.3.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { stackexchangeCommand } from '../stackexchange/index.js';

export function createPiStackexchangeTool(options: {
  ctx: ExtensionContext;
}): ToolDefinition {
  const { ctx } = options;

  return {
    name: 'pi_stackexchange',
    label: 'Stack Exchange Search',
    description: 'Search and retrieve data from Stack Exchange network via REST API v2.3 (anonymous: 300 requests/day, with key: 10,000 requests/day)',
    promptSnippet: 'Search Stack Overflow and other Stack Exchange sites for questions, answers, and user information',
    promptGuidelines: [
      'Use pi_stackexchange to find technical answers on Stack Overflow',
      'Great for finding code solutions, debugging help, and best practices',
      'Works with any Stack Exchange site (Stack Overflow, SuperUser, AskUbuntu, etc.)',
      'Anonymous access: 300 requests/day. Set STACKEXCHANGE_API_KEY env var for 10,000/day.',
      'Use tags to filter by specific topics.',
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
      _extensionCtx,
    ): Promise<AgentToolResult<unknown>> {
      const paramsRecord = params as Record<string, unknown>;
      const command = paramsRecord['command'] as string;


      return stackexchangeCommand({
        command,
        params: paramsRecord,
        ctx,
        signal,
      });
    },
  };
}
