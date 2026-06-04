/**
 * Grep Tool
 *
 * Thin wrapper around the SDK's built-in grep tool that adds
 * ToolUsageTracker budget enforcement before delegating execution.
 */

import { createGrepToolDefinition } from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import { MAX_GATHERING_CALLS } from '../constants.ts';

export function createGrepTool(options: {
  tracker: ToolUsageTracker;
  cwd?: string;
}): ToolDefinition {
  const cwd = options.cwd ?? process.cwd();
  const sdkGrep = createGrepToolDefinition(cwd);
  const { execute: sdkExecute } = sdkGrep;

  return {
    ...sdkGrep,
    label: 'Code Search',
    promptGuidelines: [
      'Available for fast recursive text search in codebases.',
      'Pattern supports regex. Use glob to scope to file types (e.g., "**/*.ts").',
      'Options: ignoreCase, literal (disable regex), context (lines around match), limit (max matches).',
      `CRITICAL: You are allowed a maximum of ${MAX_GATHERING_CALLS} gathering calls total across ALL tools.`,
    ],
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (!Value.Check(sdkGrep.parameters, params)) {
        return {
          content: [{ type: 'text', text: 'Invalid parameters for grep tool.' }],
          details: { error: 'invalid_parameters' },
        };
      }

      if (!options.tracker.recordCall('grep')) {
        return {
          content: [{ type: 'text', text: options.tracker.getLimitMessage('grep') }],
          details: { blocked: true, reason: 'limit_reached' },
        };
      }

      return sdkExecute(toolCallId, params as any, signal, onUpdate, ctx);
    },
  } as ToolDefinition;
}
