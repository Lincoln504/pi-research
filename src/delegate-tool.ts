/**
 * Delegate Research Tool
 *
 * Allows the coordinator to spawn researcher agents via delegate_research tool.
 * Researchers run in parallel or sequential mode, with token tracking and flash indicators.
 */

import type { ToolDefinition, AgentToolResult } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { createResearcherSession, type CreateResearcherSessionOptions } from './researcher.js';
import type { ResearchPanelState } from './tui/research-panel.js';
import { addSlice, updateSliceLabel, completeSlice, flashSlice, getCapturedTui } from './tui/research-panel.js';
import { logger } from './logger.js';

export interface DelegateToolOptions {
  breadthCounter: { value: number }; // Mutable ref, incremented per call
  panelState: ResearchPanelState;
  onTokens: (n: number) => void;
  researcherOptions: CreateResearcherSessionOptions;
  signal?: AbortSignal;
  timeoutMs: number;
  flashTimeoutMs: number;
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
 * Wraps a promise with a timeout
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Researcher ${label} timeout after ${timeoutMs}ms`)),
        timeoutMs
      )
    ),
  ]);
}

/**
 * Checks if an error is transient and should trigger a retry
 */
function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  // Network errors
  if (message.includes('econnrefused') || message.includes('enotfound') || message.includes('timeout')) {
    return true;
  }

  // Rate limiting
  if (message.includes('429') || message.includes('rate') || message.includes('quota')) {
    return true;
  }

  // Temporary service unavailability
  if (message.includes('503') || message.includes('temporarily') || message.includes('unavailable')) {
    return true;
  }

  // Other transient HTTP errors
  if (message.includes('5xx') || message.includes('500') || message.includes('502') || message.includes('504')) {
    return true;
  }

  return false;
}

/**
 * Retries an operation with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 1000,
  label: string = 'operation'
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if error is transient
      if (!isTransientError(error)) {
        logger.debug(`[delegate] Non-transient error for ${label}, not retrying:`, lastError.message);
        throw error;
      }

      if (attempt > maxRetries) {
        logger.error(`[delegate] ${label} failed after ${maxRetries} retries:`, lastError.message);
        throw error;
      }

      // Calculate exponential backoff: 1s, 2s, 4s
      const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
      logger.debug(`[delegate] ${label} failed (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms:`, lastError.message);

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Should never reach here
  throw lastError || new Error('Retry exhausted');
}

/**
 * Create the delegate_research tool definition
 */
export function createDelegateTool(options: DelegateToolOptions): ToolDefinition {
  return {
    name: 'delegate_research',
    label: 'Delegate Research',
    description: 'Spawn researcher agents to investigate multiple topics in parallel or sequentially',
    parameters: Type.Object({
      slices: Type.Array(
        Type.String({ description: 'Research task per researcher' }),
        { minItems: 1 }
      ),
      simultaneous: Type.Boolean({
        description: 'Run all in parallel (true) or sequentially (false)',
      }),
    }),
    async execute(
      _id: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown
    ): Promise<AgentToolResult<unknown>> {
      const { slices, simultaneous } = params as { slices: string[]; simultaneous: boolean };

      logger.log(`[delegate] Spawning ${slices.length} researcher agents (${simultaneous ? 'parallel' : 'sequential'})`);

      // Assign labels and register slices in panelState
      // Labels use X.0 format: X = breadth counter, .0 = first (initial) research depth
      const assignments: Array<{ label: string; slice: string }> = slices.map((slice) => {
        const breadth = ++options.breadthCounter.value;
        const label = `${breadth}.0`;
        addSlice(options.panelState, label, label);
        return { label, slice };
      });

      getCapturedTui()?.requestRender?.();

      // Run a single researcher session
      const runOne = async ({ label: initialLabel, slice }: { label: string; slice: string }): Promise<[string, string]> => {
        logger.log(`[delegate] Starting researcher ${initialLabel}`);

        const sliceKey = initialLabel; // Map key — never changes (always "X.0")
        const breadthNum = initialLabel.split('.')[0]; // e.g. "3" from "3.0"
        let depth = 0; // tool-call depth counter

        const session = await createResearcherSession(options.researcherOptions);

        // Token tracking + tool-call flash + depth label updates
        session.subscribe((event) => {
          if (event.type === 'message_end' && event.message.role === 'assistant') {
            const tokens = (event.message as any).usage?.totalTokens;
            if (tokens) options.onTokens(tokens);
          } else if (event.type === 'tool_execution_start') {
            depth += 1;
            updateSliceLabel(options.panelState, sliceKey, `${breadthNum}.${depth}`);
          } else if (event.type === 'tool_execution_end') {
            const color = (event as any).isError ? 'red' : 'green';
            flashSlice(options.panelState, sliceKey, color, options.flashTimeoutMs);
          }
        });

        await withTimeout(
          withRetry(() => session.prompt(slice), 3, 1000, sliceKey),
          options.timeoutMs,
          sliceKey
        );

        // Extract final message text
        const msgs = session.messages;
        const last = [...msgs].reverse().find((m) => m.role === 'assistant');
        const text = extractText(last);
        logger.log(`[delegate] Completed researcher ${sliceKey}`);
        return [sliceKey, text];
      };

      // Mark completion (checkmark only, no flash)
      const runWithFlash = async (assignment: { label: string; slice: string }): Promise<[string, string]> => {
        try {
          const result = await runOne(assignment);
          completeSlice(options.panelState, result[0]); // use final label (may have updated)
          return result;
        } catch (err) {
          completeSlice(options.panelState, assignment.label);
          return [assignment.label, `Error: ${err instanceof Error ? err.message : String(err)}`];
        }
      };

      // Run parallel or sequential
      let pairs: [string, string][];
      if (simultaneous) {
        pairs = await Promise.all(assignments.map(runWithFlash));
      } else {
        pairs = [];
        for (const a of assignments) {
          pairs.push(await runWithFlash(a));
        }
      }

      // Format results for coordinator
      const result = pairs
        .map(([label, text]) => `## Researcher ${label}\n\n${text}`)
        .join('\n\n');

      return { content: [{ type: 'text', text: result }], details: {} };
    },
  };
}
