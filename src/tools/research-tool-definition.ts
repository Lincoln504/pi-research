/**
 * Research Tool Definition
 *
 * Defines the research tool that orchestrates web/internet research:
 * - Quick research (depth 0) - Single session for simple queries
 * - Deep research (depth 1-3) - Multi-session coordinated research
 */

import type {
  ToolDefinition,
  AgentToolResult,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import type { Model } from '@mariozechner/pi-ai';
import type { ModelWithId } from '../types/extension-context.ts';
import type { ExtendedResearchContext, ResearchDepth } from '../types/index.ts';
import { Type } from 'typebox';
import { validateConfig } from '../config.ts';
import { runResearch } from '../orchestration/research-manager.ts';
import { createResearchRunId, logger, runWithLogContext, setLogger, createLogger, isVerboseFromEnv, getLogger } from '../logger.ts';
import { exportResearchReport, appendExportMessage } from '../utils/research-export.ts';
import { validateAndSanitizeQuery } from '../utils/input-validation.ts';
import { startResearchSession, registerSessionAbort } from '../utils/session-state.ts';
import { createResearchTuiManager, hideWorkingIndicator } from '../tui/research-tui-manager.ts';
import { createCleanupFunction } from '../cleanup/research-cleanup.ts';
import { createResearchObserver, createObserverState, stopObserverWaveAnimation } from '../observers/research-observer-impl.ts';
import type { ResearchState } from '../types/index.ts';
import { ensureFunctionalHealth, createHealthMonitor } from '../utils/research-health.ts';
import { getPiSessionMetadata } from '../utils/pi-session.ts';

/**
 * Create the research tool definition
 */
export function createResearchTool(): ToolDefinition {
  return {
    name: 'research',
    label: 'Research',
    description:
      'Perform web/internet research using an internal multi-source system. Synthesizes findings from web search, scraping, security databases, and Stack Exchange.',
    promptSnippet: 'Conduct comprehensive web/internet research',
    parameters: Type.Object({
      query: Type.String({
        description: 'Research query or topic to investigate',
      }),
      depth: Type.Optional(Type.Integer({
        minimum: 0,
        maximum: 3,
        description: [
          'Research complexity 0-3.',
          '0: Quick (single pass, fast)',
          '1: Normal (coordinated, thorough)',
          '2: Deep (multi-round, exhaustive)',
          '3: Ultra (maximum depth, extreme rigor)',
        ].join('\n'),
        default: 1,
      })),
      model: Type.Optional(Type.String({
        description: 'Model ID to use for coordination (optional)',
      })),
    }),
    renderShell: 'self',
    prepareArguments: (args: unknown) => {
      const rawArgs = args as Record<string, unknown>;
      const normalized: Record<string, unknown> = {
        query: rawArgs['query'] ?? '',
        model: rawArgs['model'],
      };

      const rawDepth = rawArgs['depth'];
      if (rawDepth !== undefined && rawDepth !== null) {
        if (typeof rawDepth === 'string') {
          const parsed = parseInt(rawDepth, 10);
          normalized['depth'] = isNaN(parsed) ? 0 : Math.max(0, Math.min(3, parsed));
        } else if (typeof rawDepth === 'number') {
          normalized['depth'] = Math.max(0, Math.min(3, rawDepth));
        } else {
          normalized['depth'] = 0;
        }
      } else {
        normalized['depth'] = 0;
      }

      return normalized;
    },
    async execute(
      _toolCallId: string,
      params: unknown,
      aborted: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const { query, depth, model: modelId } = params as { query: string; depth?: number; model?: string };
      const researchId = createResearchRunId();
      const piSessionId = ctx.sessionId || 'default';
      const internalAbort = new AbortController();
      let tuiManager: ReturnType<typeof createResearchTuiManager> | null = null;
      let healthMonitorInstance: ReturnType<typeof createHealthMonitor> | null = null;

      if (!query) {
        return { content: [{ type: 'text', text: 'Error: Research query is required' }], details: {} };
      }

      try {
        const researchRunResult = await (logger as any).runCapturingStderr(async () => {
          validateConfig();

          // When no explicit model parameter is given, use ctx.model directly.
          let selectedModel: ModelWithId | undefined;
          if (modelId) {
            selectedModel = await ctx.modelRegistry.getModel(modelId);
            if (!selectedModel) {
              logger.warn(`[research] Model ${modelId} not found, falling back to context model.`);
              selectedModel = ctx.model as ModelWithId;
            }
          } else {
            selectedModel = ctx.model as ModelWithId;
          }

          if (!selectedModel) {
             throw new Error('No research model specified or available in context.');
          }

          const sanitizedQuery = validateAndSanitizeQuery(query);
          
          // Setup TUI
          tuiManager = createResearchTuiManager({
            piSessionId,
            researchId,
            query: sanitizedQuery,
            modelId: selectedModel.id,
          }, { ctx });
          
          tuiManager.initializePanel();
          const { panelState } = tuiManager;

          // Perform health check
          await ensureFunctionalHealth({
            panelState,
            onUpdate: () => tuiManager?.debouncedRefresh(),
          });

          // Start health monitor for periodic checks
          healthMonitorInstance = createHealthMonitor();
          healthMonitorInstance.start();

          // Register with session state
          const session = startResearchSession(piSessionId, researchId);
          registerSessionAbort(piSessionId, researchId, () => internalAbort.abort());

          // Setup observer
          const observerState = createObserverState(panelState, () => tuiManager?.debouncedRefresh());
          const observer = createResearchObserver(observerState);

          // Setup cleanup
          const cleanup = createCleanupFunction(panelState, {
            piSessionId,
            researchId,
            tuiManager,
          }, { ctx });

          // Handle abort signal
          if (aborted) {
            aborted.addEventListener('abort', () => internalAbort.abort());
          }

          // Setup scoped logging
          const researchLogger = createLogger({ researchRunId: researchId, verbose: isVerboseFromEnv() });
          const previousLogger = getLogger();
          setLogger(researchLogger);

          // Hide working indicator
          hideWorkingIndicator(ctx);

          try {
            // Run research
            const result = await runResearch({
              ctx,
              query: sanitizedQuery,
              depth: (depth ?? 0) as ResearchDepth,
              model: selectedModel as Model<any>,
              observer,
              sessionId: piSessionId,
              researchId,
            }, internalAbort.signal);

            // Stop health monitor
            if (healthMonitorInstance) {
              healthMonitorInstance.stop();
            }

            // Stop wave animation
            stopObserverWaveAnimation(observerState, panelState as unknown as ResearchState);

            const exportPath = await exportResearchReport(sanitizedQuery, result, (depth ?? 0) === 0 ? 'quick' : 'deep', ctx.cwd);
            const finalResult = exportPath ? appendExportMessage(result, exportPath, panelState.totalCost) : result;

            return { result: finalResult, tokens: panelState.totalTokens };
          } catch (error) {
            if (aborted || internalAbort.signal.aborted) {
              return { result: 'Research cancelled.', tokens: 0 };
            }
            throw error;
          } finally {
            // Restore previous logger
            setLogger(previousLogger);
            await cleanup();
          }
        });

        return { content: [{ type: 'text', text: researchRunResult.result }], details: { totalTokens: researchRunResult.tokens } };
      } catch (error) {
        if (aborted || internalAbort.signal.aborted) {
          return { content: [{ type: 'text', text: 'Research cancelled.' }], details: {} };
        }
        
        const errMsg = String(error).toLowerCase();
        
        // Handle rate limits gracefully
        if (errMsg.includes('429') || errMsg.includes('rate limit') || errMsg.includes('too many requests') || errMsg.includes('quota')) {
            logger.warn('[research] Run halted gracefully due to rate limit:', error);
            if (ctx.ui?.notify) {
                ctx.ui.notify('Research halted: API rate limit reached', 'warning');
            }
            return {
                content: [{
                    type: 'text',
                    text: `[SYSTEM MESSAGE]: The research operation was halted gracefully because an API rate limit (HTTP 429) was reached. Please inform the user that the operation was stopped due to provider rate limits and they should wait a moment before trying again.\n\nDetails: ${String(error)}`
                }],
                details: {}
            };
        }

        logger.error('[research] run failed', error);
        return { content: [{ type: 'text', text: `Research failed: ${String(error)}` }], details: {} };
      }
    },
  };
}
