/**
 * Delegate Research Tool
 *
 * Allows the coordinator to spawn researcher agents via delegate_research tool.
 * Researchers run in parallel using worker pools for concurrent execution, with token tracking and flash indicators.
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
import { ensureAssistantResponse } from '../utils/text-utils.ts';
import {
  recordResearcherFailure,
  shouldStopResearch,
  getResearchStopMessage,
  getFailedResearchers,
} from '../utils/session-state.ts';
import { withTimeout, retryWithBackoff } from '../web-research/retry-utils.ts';

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
 * Create the delegate_research tool definition
 */
export function createDelegateTool(options: DelegateToolOptions): ToolDefinition {
  return {
    name: 'delegate_research',
    label: 'Delegate Research',
    description: 'Spawn researcher agents to investigate multiple topics in parallel. Researchers are numbered sequentially: 1, 2, 3, etc. Always honor user-specified complexity levels.',
    promptSnippet: 'Research multiple topics via parallel researcher agents',
    promptGuidelines: [
      'Use delegate_research to spawn researcher agents, but MINIMIZE initial researcher count.',
      'CRITICAL: If the user explicitly specified a complexity level ("level 1", "brief", "quick", "simple", "level 2", "level 3", "deep", "exhaustive"), honor that request exactly and do not escalate mid-research.',
      'Otherwise: Level 1 = brief (1-2 researchers, default for most queries), Level 2 = multi-faceted if explicitly requested (2-3 researchers), Level 3 = deep if explicitly requested (3-5 researchers).',
      'START WITH THE MINIMUM RESEARCHER COUNT. For Level 1, start with 1 researcher unless the query clearly has 2 distinct aspects. Do not add researchers "just in case."',
      'Do NOT expand scope mid-research. If you identify gaps in your research agenda, only spawn additional researchers to address those gaps.',
    ],
    parameters: Type.Object({
      slices: Type.Array(
        Type.String({ description: 'Research aspect per researcher' }),
        { minItems: 1 }
      ),
    }),
    async execute(
      _id: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown
    ): Promise<AgentToolResult<unknown>> {
      const { slices } = params as {
        slices: string[];
      };

      // Log execution mode
      logger.log(`[delegate] Running ${slices.length} research aspect(s) with ${Math.min(3, slices.length)} concurrent worker(s)`);

      // Check if research should stop due to too many cumulative failures
      const failedCount = getFailedResearchers(options.sessionId).length;
      logger.log(`[delegate] Checking cumulative failures for ${options.sessionId}. Current failed researchers: ${failedCount}`);
      if (shouldStopResearch(options.sessionId)) {
        const errorText = getResearchStopMessage(options.sessionId);
        logger.error('[delegate] STOPPING RESEARCH DUE TO CUMULATIVE FAILURES:', errorText);
        throw new Error(errorText);
      }

      const effectiveMaxConcurrency = 3;
      const assignments: Array<{ label: string; slice: string }> = slices.map((slice) => {
        const label = `${++options.breadthCounter.value}`;
        addSlice(options.panelState, label, label, true);
        return { label, slice };
      });

      const existingSharedLinks = loadSharedLinks(options.sessionId);
      const existingLinksContext = formatSharedLinksForPrompt(existingSharedLinks);
      const queue = [...assignments];

      const runOne = async (assignment: { label: string; slice: string }): Promise<[string, string]> => {
        const researcherId = assignment.label;
        const session = await createResearcherSession(options.researcherOptions);

        session.subscribe((event) => {
          if (event.type === 'message_end' && event.message.role === 'assistant') {
            const tokens = (event.message as any).usage?.totalTokens;
            if (tokens) options.onTokens(tokens);
          } else if (event.type === 'tool_execution_end') {
            const color = (event as any).isError ? 'red' : 'green';
            flashSlice(options.panelState, researcherId, color, options.flashTimeoutMs, options.onUpdate);
          }
        });

        const enhancedSlice = existingLinksContext ? `${assignment.slice}\n\n${existingLinksContext}` : assignment.slice;

        try {
          activateSlice(options.panelState, researcherId);
          options.onUpdate();

          await withTimeout(
            retryWithBackoff(async () => {
              await session.prompt(enhancedSlice);
              ensureAssistantResponse(session, researcherId);
            }, {
              maxRetries: 3,
              initialDelay: 1000,
              label: researcherId
            }),
            options.timeoutMs,
            researcherId,
            options.signal
          );

          const text = ensureAssistantResponse(session, researcherId);
          completeSlice(options.panelState, researcherId);
          options.onUpdate();

          return [researcherId, text];
        } catch (err) {
          recordResearcherFailure(options.sessionId, researcherId);
          completeSlice(options.panelState, researcherId);
          options.onUpdate();
          throw err;
        }
      };

      // Parallel execution with worker pool
      const results: [string, string][] = [];
      const workers = Array(Math.min(effectiveMaxConcurrency, assignments.length)).fill(null).map(async () => {
        while (queue.length > 0) {
          const a = queue.shift()!;
          try {
            results.push(await runOne(a));
          } catch (err) {
            results.push([a.label, `ERROR: ${err instanceof Error ? err.message : String(err)}`]);
          }
        }
      });
      await Promise.all(workers);

      const researcherResponses = new Map<string, string>(results);
      const newSharedLinks = buildSharedLinksPool(researcherResponses);
      const mergedPool: SharedLinksPool = existingSharedLinks ? { ...existingSharedLinks, ...newSharedLinks } : newSharedLinks;
      saveSharedLinks(options.sessionId, mergedPool);

      if (shouldStopResearch(options.sessionId)) {
        throw new Error(getResearchStopMessage(options.sessionId));
      }

      const combinedText = results.map(([label, text]) => `## Research ${label}\n\n${text}`).join('\n\n');
      return { content: [{ type: 'text', text: combinedText }], details: {} };
    },
  };
}
