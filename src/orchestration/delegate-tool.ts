/**
 * Delegate Research Tool
 *
 * Allows the coordinator to spawn researcher agents via delegate_research tool.
 * Researchers run in parallel or sequential mode, with token tracking and flash indicators.
 *
 * Robust failure tracking:
 * - Uses session state to track failures across ALL delegate_research calls
 * - Counts unique failed researchers (same researcher failing N times = 1 failure)
 * - Stops research when 2+ different researchers fail in entire session
 */

import type { ToolDefinition, AgentToolResult } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { createResearcherSession, type CreateResearcherSessionOptions } from './researcher.ts';
import { addSlice, completeSlice, flashSlice, activateSlice, type ResearchPanelState } from '../tui/research-panel.ts';
import { logger } from '../logger.ts';
import {
  buildSharedLinksPool,
  saveSharedLinks,
  loadSharedLinks,
  formatSharedLinksForPrompt,
  type SharedLinksPool,
} from '../utils/shared-links.ts';
import { extractText } from '../utils/text-utils.ts';
import {
  recordResearcherFailure,
  shouldStopResearch,
  getResearchStopMessage,
  getFailedResearchers,
} from '../utils/session-state.ts';

export interface DelegateToolOptions {
  sessionId: string; // Unique session ID for shared links
  breadthCounter: { value: number }; // Mutable ref, incremented per call
  panelState: ResearchPanelState;
  onTokens: (n: number) => void;
  onUpdate: () => void; // Callback to trigger widget re-render
  researcherOptions: CreateResearcherSessionOptions;
  signal?: AbortSignal;
  timeoutMs: number;
  flashTimeoutMs: number;
}

/**
 * Wraps a promise with a timeout and abort signal support
 */
/**
 * Wraps a promise with a timeout and abort signal support
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  const timeoutController = new AbortController();
  const timeoutSignal = timeoutController.signal;
  const combinedSignal = signal
    ? AbortSignal.any([timeoutSignal, signal])
    : timeoutSignal;
  logger.log(`[withTimeout] Starting ${label} with timeout ${timeoutMs}ms. External signal aborted: ${signal?.aborted ?? 'no signal'}`);

  let raceWon = false;
  let timeoutId: NodeJS.Timeout | undefined;

  const wrappedPromise = promise.then((val) => {
    raceWon = true;
    if (timeoutId) clearTimeout(timeoutId);
    return val;
  });

  const rejectPromise = new Promise<T>((_, reject) => {
    // Timeout handler
    timeoutId = setTimeout(() => {
      logger.error(`[withTimeout] ${label} TIMEOUT after ${timeoutMs}ms`);
      timeoutController.abort();
      reject(new Error(`Researcher ${label} timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    if (combinedSignal.aborted) {
      logger.error(`[withTimeout] ${label} ALREADY ABORTED at start`);
      clearTimeout(timeoutId);
      reject(new Error(`Researcher ${label} cancelled`));
    } else {
      combinedSignal.addEventListener('abort', () => {
        if (!raceWon) {
          logger.error(`[withTimeout] ${label} ABORT SIGNAL FIRED`);
          if (timeoutId) clearTimeout(timeoutId);
          reject(new Error(`Researcher ${label} cancelled`));
        }
      }, { once: true });
    }
  });

  return Promise.race([wrappedPromise, rejectPromise]).finally(() => {
    // Clean up on completion or error
    if (timeoutId) clearTimeout(timeoutId);
    timeoutController.abort();
  });
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
    description: 'Spawn researcher agents to investigate multiple topics in parallel or sequentially. Labels use "X:Y" format: X = slice number, Y = iteration number. Complexity: Level 0 (1 slice, no follow-ups), Level 1 (1-2 slices, up to 1 follow-up), Level 2 (3-5 slices, up to 2 follow-ups), Level 3 (5+ slices, up to 3-4 follow-ups). Always honor user-specified complexity levels.',
    promptSnippet: 'Research multiple topics via parallel or sequential researcher agents',
    promptGuidelines: [
      'Use delegate_research to spawn researcher agents, but MINIMIZE initial slice count.',
      'CRITICAL: If the user explicitly specified a complexity level ("level 0", "level 1", "brief", "quick", "simple", "level 2", "level 3", "deep", "exhaustive"), honor that request exactly and do not escalate mid-research.',
      'Otherwise: Level 0 = fact (1 slice, no follow-ups), Level 1 = brief (1-2 slices, default for most queries, max 1 follow-up), Level 2 = multi-faceted if explicitly requested (3-4 slices, max 2 follow-ups), Level 3 = deep if explicitly requested (5+ slices, max 3-4 follow-ups).',
      'START WITH THE MINIMUM SLICE COUNT. For Level 1, start with 1 slice unless the query clearly has 2 distinct parts. Do not add slices "just in case."',
      'Do NOT expand scope mid-research. If findings suggest more research is needed, only do follow-up delegations if they directly answer a gap in the user\'s question.',
      'Use simultaneous: true for parallel execution, simultaneous: false for sequential order.',
    ],
    parameters: Type.Object({
      slices: Type.Array(
        Type.String({ description: 'Research task per researcher' }),
        { minItems: 1 }
      ),
      simultaneous: Type.Boolean({
        description: 'Run all in parallel (true) or sequentially (false). In non-concurrent mode, this is forced to false.',
      }),
      nonConcurrent: Type.Optional(Type.Boolean({
        description: 'If true, run slices one at a time (max concurrency = 1). UI shows one active slice at a time, completing slices stay visible. Same structure and logic as concurrent mode, just limited to 1 active slice.',
        default: false,
      })),
      iterateOn: Type.Optional(Type.String({
        description: 'Slice identifier to iterate on (e.g., "1" to create "1:2", "2" to create "2:3"). Omit for new slices.',
      })),
      iterationNumber: Type.Optional(Type.Number({
        description: 'Explicit iteration number to use (e.g., 2 for "1:2"). Defaults to auto-increment if omitted.',
      })),
    }),
    async execute(
      _id: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown
    ): Promise<AgentToolResult<unknown>> {
      const { slices, simultaneous, nonConcurrent = false, iterateOn, iterationNumber } = params as {
        slices: string[];
        simultaneous: boolean;
        nonConcurrent?: boolean;
        iterateOn?: string;
        iterationNumber?: number;
      };

      // Check if research should stop due to too many cumulative failures
      // This checks across ALL delegate_research calls in the session, not just this one
      const failedCount = getFailedResearchers(options.sessionId).length;
      logger.log(`[delegate] Checking cumulative failures for ${options.sessionId}. Current failed researchers: ${failedCount}`);
      if (shouldStopResearch(options.sessionId)) {
        const errorText = getResearchStopMessage(options.sessionId);
        logger.error('[delegate] STOPPING RESEARCH DUE TO CUMULATIVE FAILURES:', errorText);
        throw new Error(errorText);
      }
      logger.log('[delegate] Cumulative failure check: PASS - proceeding with research');

      const effectiveMaxConcurrency = nonConcurrent ? 1 : 3;
      const mode = nonConcurrent ? 'non-concurrent (1)' : (simultaneous ? 'parallel' : 'sequential');
      logger.log(`[delegate] Spawning ${slices.length} researcher agents (${mode}, max concurrency: ${effectiveMaxConcurrency})`);
      // Assign labels and register slices in panelState
      // Labels use "X:Y" format: X = slice number, Y = iteration number
      // New slices start at iteration 1, follow-ups increment iteration
      const assignments: Array<{ label: string; slice: string }> = slices.map((slice, index) => {
        let sliceNum: string;
        let iterNum: number;
        if (iterateOn) {
          // Follow-up: iterate on existing slice
          // Use iterationNumber + index for multiple parallel follow-up tasks
          sliceNum = iterateOn;
          iterNum = (iterationNumber ?? 1) + index;
        } else {
          // New slice: increment breadth counter
          sliceNum = `${++options.breadthCounter.value}`;
          iterNum = 1; // First iteration for new slices
        }
        const label = `${sliceNum}:${iterNum}`;
        // Mark all slices as queued initially (hidden from UI)
        addSlice(options.panelState, label, label, true);
        return { label, slice };
      });

      // Queue of unprocessed assignments (index-based for order)
      const queueIndex = { value: 0 };
      const allAssignments = assignments;
      const activeCount = { value: 0 };

      // Activate slices up to max concurrency
      const activateNextSlice = () => {
        if (queueIndex.value < allAssignments.length && activeCount.value < effectiveMaxConcurrency) {
          const assignment = allAssignments[queueIndex.value]!;
          activateSlice(options.panelState, assignment.label);
          queueIndex.value++;
          activeCount.value++;
          options.onUpdate();
          return true;
        }
        return false;
      };

      // Load existing shared links from previous researchers
      const existingSharedLinks = loadSharedLinks(options.sessionId);
      const existingLinksContext = formatSharedLinksForPrompt(existingSharedLinks);
      // Activate initial slices
      while (activateNextSlice()) {
        // Activate slices up to maxConcurrency
      }
      options.onUpdate();

      // Run a single researcher session
      const runOne = async ({ label: initialLabel, slice }: { label: string; slice: string }): Promise<[string, string]> => {
        logger.log(`[delegate] Starting researcher ${initialLabel}`);

        const sliceKey = initialLabel; // Map key — never changes (e.g., "1:1", "1:2", etc.)
        logger.log(`[delegate] Creating researcher session for ${sliceKey}...`);
        const session = await createResearcherSession(options.researcherOptions);
        logger.log(`[delegate] Researcher session created for ${sliceKey}`);

        // Token tracking and tool-call flash visualization
        // Note: Failure detection is done AFTER prompt() completes, not here
        session.subscribe((event) => {
          if (event.type === 'message_end' && event.message.role === 'assistant') {
            const tokens = (event.message as any).usage?.totalTokens;
            if (tokens) options.onTokens(tokens);
          } else if (event.type === 'tool_execution_end') {
            const color = (event as any).isError ? 'red' : 'green';
            flashSlice(options.panelState, sliceKey, color, options.flashTimeoutMs, options.onUpdate);
          }
        });

        // Append shared links context to researcher prompt
        const enhancedSlice = existingLinksContext
          ? `${slice}\n\n${existingLinksContext}`
          : slice;
        try {
          logger.log(`[delegate] Calling prompt for ${sliceKey}. External signal aborted: ${options.signal?.aborted ?? 'no signal'}`);
          await withTimeout(
            withRetry(async () => {
              await session.prompt(enhancedSlice);
              // Check for provider errors after prompt completes and retry if detected
              const msgs = session.messages;
              const last = [...msgs].reverse().find((m) => m.role === 'assistant');
              if (last?.stopReason === 'error') {
                throw new Error(`Provider error: ${last?.errorMessage || 'Unknown error'}`);
              }
            }, 3, 1000, sliceKey),
            options.timeoutMs,
            sliceKey,
            options.signal
          );
          logger.log(`[delegate] Prompt completed successfully for ${sliceKey}`);
        } catch (err) {
          logger.error(`[delegate] Prompt failed for ${sliceKey}:`, err instanceof Error ? err.message : String(err));
          session.abort().catch(() => {}); // stop ongoing API calls from this researcher
          throw err;
        }

        // Extract final message text and check for failure AFTER prompt completes
        const msgs = session.messages;
        if (!Array.isArray(msgs) || msgs.length === 0) {
          logger.error(`[delegate] Researcher ${sliceKey}: No messages in session`);
          recordResearcherFailure(options.sessionId, sliceKey);
          throw new Error(`Researcher ${sliceKey} produced no output`);
        }

        const last = [...msgs].reverse().find((m) => m && typeof m === 'object' && m.role === 'assistant');

        if (!last) {
          logger.error(`[delegate] Researcher ${sliceKey}: No assistant message found`);
          recordResearcherFailure(options.sessionId, sliceKey);
          throw new Error(`Researcher ${sliceKey} produced no assistant message`);
        }

        // Check if agent failed due to error (not abort, which is normal cleanup)
        // This is the single, authoritative failure check point
        // NOTE: stopReason === 'aborted' is NORMAL (cleanup signal), not a failure.
        // Only treat 'error' as a failure, and only if there's an actual error message.
        const isFailed = last.stopReason === 'error' || (last.errorMessage && last.stopReason !== 'aborted');
        if (isFailed) {
          // Abort session on provider error to cancel inflight API calls
          session.abort().catch(() => {});
          // Record failure in session state (persists across delegate_research calls)
          recordResearcherFailure(options.sessionId, sliceKey);
          const errorMsg = last.errorMessage || last.stopReason || 'Unknown error';
          logger.error(`[delegate] Researcher ${sliceKey} FAILED: ${errorMsg}`);
          throw new Error(`Researcher ${sliceKey} failed: ${errorMsg}`);
        }

        // Extract text safely
        const text = extractText(last);

        // Add diagnostic logging when extractText returns empty
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
          const contentBlocks = last.content || [];
          logger.error(`[delegate] Researcher ${sliceKey}: Failed to extract valid text from message`, {
            stopReason: last.stopReason,
            errorMessage: last.errorMessage,
            contentBlockTypes: contentBlocks.map((block: any) => block.type),
            contentBlockCount: contentBlocks.length,
            hasToolUseContent: contentBlocks.some((block: any) => block.type === 'tool_use'),
            hasTextContent: contentBlocks.some((block: any) => block.type === 'text'),
            messageRole: last.role,
            totalContentLength: JSON.stringify(last.content || []).length,
          });

          // DEBUG: If stopReason is 'aborted', show why it was aborted
          if (last.stopReason === 'aborted') {
            logger.error(`[delegate] ${sliceKey} was aborted - likely due to:`, {
              stopReason: 'aborted',
              hadError: !!last.errorMessage,
              errorMsg: last.errorMessage,
              contentEmpty: (contentBlocks || []).length === 0,
            });
          }
        }

        // Aborted is normal - check that we have actual output
        if (last.stopReason === 'aborted' && !text) {
          logger.warn(`[delegate] Researcher ${sliceKey} aborted with no output`);
          recordResearcherFailure(options.sessionId, sliceKey);
          throw new Error(`Researcher ${sliceKey} produced no output`);
        }

        if (!text || typeof text !== 'string') {
          logger.error(`[delegate] Researcher ${sliceKey}: Failed to extract valid text from message`);
          recordResearcherFailure(options.sessionId, sliceKey);
          throw new Error(`Researcher ${sliceKey} returned invalid output format`);
        }

        const trimmedText = text.trim();
        if (trimmedText.length === 0) {
          logger.warn(`[delegate] Researcher ${sliceKey}: Message contains only whitespace`);
          recordResearcherFailure(options.sessionId, sliceKey);
          throw new Error(`Researcher ${sliceKey} produced empty output`);
        }

        logger.log(`[delegate] Researcher ${sliceKey} completed successfully. Output length: ${trimmedText.length} chars`);
        return [sliceKey, trimmedText];
      };
      // Mark completion
      const runWithFlash = async (assignment: { label: string; slice: string }): Promise<[string, string]> => {
        try {
          const result = await runOne(assignment);
          completeSlice(options.panelState, result[0]); // result[0] is sliceKey
          options.onUpdate();  // Update widget to show checkmark
          return result;
        } catch (err) {
          completeSlice(options.panelState, assignment.label);
          options.onUpdate();  // Update widget to show checkmark
          const errorMsg = err instanceof Error ? err.message : String(err);
          return [assignment.label, `ERROR: ${errorMsg}`];
        }
      };

      // Run parallel or sequential (with queue management)
      let pairs: [string, string][];
      if (nonConcurrent) {
        // Non-concurrent mode: run one at a time
        // Each slice is activated, run, and completed before moving to next
        pairs = [];
        for (const a of allAssignments) {
          // Activate slice (if not already)
          activateSlice(options.panelState, a.label);
          options.onUpdate();
          
          // Run this slice
          pairs.push(await runWithFlash(a));
          // Slice completed, stays visible with checkmark
          // Next slice will be activated and run in next iteration
        }
      } else if (simultaneous) {
        // Parallel mode with queue: use pool pattern
        // Maintain a queue of slices to run
        const runQueue: Array<{ assignment: typeof allAssignments[0]; resolve: (result: [string, string]) => void; reject: (error: Error) => void }> = [];
        
        // Worker function that pulls from queue
        const worker = async (): Promise<void> => {
          while (true) {
            const item = runQueue.shift();
            if (!item) break; // Queue empty, stop worker

            // Activate slice in TUI (no-op if already active for the initial batch)
            activateSlice(options.panelState, item.assignment.label);
            options.onUpdate();

            try {
              const result = await runWithFlash(item.assignment);
              item.resolve(result);
            } catch (err) {
              item.reject(err instanceof Error ? err : new Error(String(err)));
            }
          }
        };
        
        // Populate queue with all slices
        const promises = allAssignments.map(a => {
          return new Promise<[string, string]>((resolve, reject) => {
            runQueue.push({ assignment: a, resolve, reject });
          });
        });
        
        // Start workers up to maxConcurrency
        const workers = [];
        const initialWorkers = Math.min(effectiveMaxConcurrency, allAssignments.length);
        for (let i = 0; i < initialWorkers; i++) {
          workers.push(worker());
        }
        
        // Wait for all to complete
        pairs = await Promise.all(promises);
      } else {
        // Sequential mode (original behavior, no queue)
        // Mark all as active (not queued)
        for (const a of allAssignments) {
          activateSlice(options.panelState, a.label);
        }
        options.onUpdate();
        
        pairs = [];
        for (const a of allAssignments) {
          pairs.push(await runWithFlash(a));
        }
      }

      // Build and save shared links pool from researcher responses
      const researcherResponses = new Map<string, string>(pairs);
      const newSharedLinks = buildSharedLinksPool(researcherResponses);
      const mergedPool: SharedLinksPool = existingSharedLinks
        ? { ...existingSharedLinks, ...newSharedLinks }
        : newSharedLinks;
      saveSharedLinks(options.sessionId, mergedPool);
      logger.log(`[delegate] Shared links saved: ${Object.keys(mergedPool).length} slice(s)`);
      // Check if too many cumulative failures - abort research
      // This check runs AFTER all researchers complete (or one throws in sequential mode)
      // Failures are tracked across ALL delegate_research calls in the session
      if (shouldStopResearch(options.sessionId)) {
        const errorText = getResearchStopMessage(options.sessionId);
        logger.error('[delegate]', errorText);
        throw new Error(errorText);
      }
      // Format results for coordinator
      const result = pairs
        .map(([label, text]) => `## Researcher ${label}\n\n${text}`)
        .join('\n\n');
      return { content: [{ type: 'text', text: result }], details: {} };

    },
  };
}
