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
import { errorTracker } from '../utils/error-tracker.ts';
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
          '0=Quick — single direct session. Simple facts, lookups. ~85% of queries.',
          '1=Normal — up to 2 siblings per round, up to 2 rounds.',
          '2=Deep — up to 3 siblings per round, up to 3 rounds.',
          '3=Ultra — up to 5 siblings per round, up to 5 rounds. Very expensive.',
          'Team size is flexible — the coordinator plans as many as needed (up to the max).',
          '"deep" → depth 2, NOT 3. depth 3 only for "ultra"/"exhaustive"/"comprehensive"/"deep-dive".',
        ].join(' '),
      })),
      model: Type.Optional(Type.String({
        description: 'Model ID to use for all research agents (defaults to current active model)',
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
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const { query, model: modelId, depth } = params as { query: string; depth?: number; model?: string; };

      if (!query) {
        return { content: [{ type: 'text', text: 'Error: Research query is required' }], details: {} };
      }

      const sanitizedQuery = validateAndSanitizeQuery(query);
      const baseModel = ctx.model;

      if (!baseModel && !modelId) {
         return { content: [{ type: 'text', text: 'Error: No research model specified or available in context' }], details: {} };
      }

      const researchRunId = createResearchRunId();
      const metadata = getPiSessionMetadata(ctx);
      const piSessionId = metadata.piSessionId;

      // Create a per-run logger with unique file path
      const previousLogger = getLogger();
      const runLogger = createLogger({ verbose: isVerboseFromEnv(), researchRunId });
      setLogger(runLogger);

      return runWithLogContext({ ...metadata, researchRunId, toolName: 'research' }, async () => {
        let aborted = false;
        let cleanup: any = null;
        const internalAbort = new AbortController();
        let tuiManager: ReturnType<typeof createResearchTuiManager> | null = null;
        let healthMonitorInstance: ReturnType<typeof createHealthMonitor> | null = null;

        try {
          return await runLogger.runCapturingStderr(async () => {
            validateConfig();

            // When no explicit model parameter is given, use ctx.model directly.
            // ID-based lookup can match the wrong provider when the same model ID
            // exists under multiple providers (e.g. built-in "zai/glm-4.7" vs
            // user-configured "glm-coding/glm-4.7"), causing auth failures.
            let selectedModel = baseModel;
            const extendedCtx = ctx as unknown as ExtendedResearchContext;
            if (modelId && extendedCtx.model?.id !== modelId) {
                selectedModel = ctx.modelRegistry.getAll().find(m => m.id === modelId) || baseModel;
            }

            if (!selectedModel) {
                return { content: [{ type: 'text', text: 'Error: No research model specified or available in context' }], details: {} };
            }

            const typedModel = selectedModel as ModelWithId;
            const modelIdStr = typedModel?.id || 'unknown';

            const researchId = startResearchSession(piSessionId);
            registerSessionAbort(piSessionId, researchId, internalAbort);

            // Initialize TUI manager
            tuiManager = createResearchTuiManager(
              {
                piSessionId,
                researchId,
                query: sanitizedQuery,
                modelId: modelIdStr,
              },
              { ctx }
            );
            
            const { panelState, masterWidgetId, debouncedRefresh, initializePanel } = tuiManager;
            initializePanel();

            // Create cleanup function
            const cleanupContext = {
              researchId,
              piSessionId,
              masterWidgetId,
              panelState,
              waveTimer: null,
              unsubOrder: tuiManager.unsubOrder,
              unsubInput: tuiManager.unsubInput,
            };
            cleanup = createCleanupFunction(cleanupContext, { ctx });

            // Initialize health monitor
            healthMonitorInstance = createHealthMonitor();

            hideWorkingIndicator(ctx);

            // Ensure functional health
            await ensureFunctionalHealth({ panelState, onUpdate: debouncedRefresh });

            // Start periodic health monitoring for long runs
            healthMonitorInstance.start();

            signal?.addEventListener('abort', async () => {
              aborted = true;
              internalAbort.abort();
              await cleanup?.();
            }, { once: true });

            // Create observer state and observer
            const observerState = createObserverState();
            const observer = createResearchObserver(
              {
                panelState,
                debouncedRefresh,
                researchComplexity: depth ?? 0,
              },
              observerState
            );

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

            // Append error summary if any errors were tracked during this research
            const errorReport = errorTracker.getReport();
            let resultWithErrorSummary = result;
            if (errorReport.totalErrors > 0) {
              resultWithErrorSummary = appendErrorSummary(result, errorReport);
            }

            const exportPath = await exportResearchReport(sanitizedQuery, resultWithErrorSummary, (depth ?? 0) === 0 ? 'quick' : 'deep', ctx.cwd);
            const finalResult = exportPath ? appendExportMessage(resultWithErrorSummary, exportPath, panelState.totalCost) : resultWithErrorSummary;

            await cleanup?.();
            return { content: [{ type: 'text', text: finalResult }], details: { totalTokens: panelState.totalTokens } };
          });
        } catch (error) {
          if (aborted || internalAbort.signal.aborted) {
            await cleanup?.();
            return { content: [{ type: 'text', text: 'Research cancelled.' }], details: {} };
          }
          await cleanup?.();
          
          const errMsg = String(error).toLowerCase();
          
          // Handle rate limits gracefully by explicitly instructing the agent to surface it to the user
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
        } finally {
          // Stop health monitor if still running
          if (healthMonitorInstance) {
            (healthMonitorInstance as ReturnType<typeof createHealthMonitor>).stop();
          }
          
          // Restore previous logger
          setLogger(previousLogger);
        }
      });
    },
  };
}

/**
 * Append error summary to result
 */
function appendErrorSummary(result: string, errorReport: { totalErrors: number; uniquePatterns: number; patterns: Array<{ signature: string; count: number; lastSeen: string }> }): string {
  const errorLines: string[] = [];
  errorLines.push('');
  errorLines.push('---');
  errorLines.push('## ⚠️ Error Summary');
  errorLines.push('');
  errorLines.push(`This research encountered **${errorReport.totalErrors} error(s)** across **${errorReport.uniquePatterns} unique pattern(s)**.`);
  errorLines.push('');
  
  if (errorReport.patterns.length > 0) {
    errorLines.push('**Most frequent error(s):**');
    for (const pattern of errorReport.patterns.slice(0, 3)) {
      const timeSince = Math.floor((Date.now() - new Date(pattern.lastSeen).getTime()) / 1000);
      const timeAgo = timeSince < 60 ? `${timeSince}s ago` :
                      timeSince < 3600 ? `${Math.floor(timeSince / 60)}m ago` :
                      `${Math.floor(timeSince / 3600)}h ago`;
      errorLines.push(`- ${pattern.signature} (${pattern.count}x, last ${timeAgo})`);
    }
  }
  
  errorLines.push('');
  errorLines.push('Use `/errors` to view detailed error reports.');
  errorLines.push('Use `/errors-clear` to clear error history.');
  
  return result + errorLines.join('\n');
}