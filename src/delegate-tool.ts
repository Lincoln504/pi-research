/**
 * Delegate Research Tool
 *
 * Allows the coordinator to spawn researcher agents via delegate_research tool.
 * Researchers run in parallel or sequential mode, with token tracking and flash indicators.
 *
 * Supports both TUI modes:
 * - 'simple': 3-line display (uses SimplePanelState)
 * - 'full': Boxed grid layout (uses FullPanelState)
 */

import type { ToolDefinition, AgentToolResult } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { createResearcherSession, type CreateResearcherSessionOptions } from './researcher.js';
import { TUI_MODE } from './config.js';
import type { SimplePanelState, FullPanelState } from './tui/panel-factory.js';
import { setAgentFlash, addAgent, getCapturedTui } from './tui/panel-factory.js';

export type PanelState = SimplePanelState | FullPanelState;
export interface DelegateToolOptions {
  breadthCounter: { value: number }; // Mutable ref, incremented per call
  panelState: PanelState;
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
        console.debug(`[delegate] Non-transient error for ${label}, not retrying:`, lastError.message);
        throw error;
      }

      if (attempt > maxRetries) {
        console.error(`[delegate] ${label} failed after ${maxRetries} retries:`, lastError.message);
        throw error;
      }

      // Calculate exponential backoff: 1s, 2s, 4s
      const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
      console.debug(`[delegate] ${label} failed (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms:`, lastError.message);

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Should never reach here
  throw lastError || new Error('Retry exhausted');
}

/**
 * Set flash indicator for an agent
 */
function setFlash(label: string, color: 'green' | 'red', options: DelegateToolOptions): void {
  setAgentFlash(
    (options.panelState as any).agents,
    label,
    color,
    options.flashTimeoutMs
  );
}

/**
 * Add agent to panel state
 */
function registerAgent(label: string, options: DelegateToolOptions): void {
  if (TUI_MODE === 'full') {
    // In full mode, we need sliceNumber and depthNumber
    // For now, use simple numbering based on breadthCounter
    const sliceNumber = options.breadthCounter.value;
    addAgent(options.panelState as FullPanelState, label, sliceNumber, undefined);
  } else {
    // In simple mode, just add to the Map
    (options.panelState as SimplePanelState).agents.set(label, { label, flash: null });
  }
  getCapturedTui()?.requestRender?.();
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

      console.log(`[delegate] Spawning ${slices.length} researcher agents (${simultaneous ? 'parallel' : 'sequential'})`);

      // Assign labels and register in panelState
      const assignments: Array<{ label: string; slice: string }> = slices.map((slice) => {
        const label = String(++options.breadthCounter.value);
        registerAgent(label, options);
        return { label, slice };
      });

      // Run a single researcher session
      const runOne = async ({ label, slice }: { label: string; slice: string }): Promise<[string, string]> => {
        console.log(`[delegate] Starting researcher ${label}`);
        const session = await createResearcherSession(options.researcherOptions);

        // Token tracking
        session.subscribe((event) => {
          if (event.type === 'message_end' && event.message.role === 'assistant') {
            const tokens = (event.message as any).usage?.totalTokens;
            if (tokens) options.onTokens(tokens);
          }
        });

        await withTimeout(
          withRetry(() => session.prompt(slice), 3, 1000, label),
          options.timeoutMs,
          label
        );

        // Extract final message text
        const msgs = session.messages;
        const last = [...msgs].reverse().find((m) => m.role === 'assistant');
        const text = extractText(last);
        console.log(`[delegate] Completed researcher ${label}`);
        return [label, text];
      };

      // Flash on completion
      const runWithFlash = async (assignment: { label: string; slice: string }): Promise<[string, string]> => {
        try {
          const result = await runOne(assignment);
          setFlash(assignment.label, 'green', options);
          return result;
        } catch (err) {
          setFlash(assignment.label, 'red', options);
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
