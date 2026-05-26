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
} from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import type { ModelWithId } from '../types/extension-context.ts';
import type { ResearchDepth } from '../types/index.ts';
import { Type } from 'typebox';
import { validateConfig } from '../config.ts';
import { runResearch } from '../orchestration/research-manager.ts';
import { createResearchRunId, logger, setLogger, createLogger, isVerboseFromEnv, getLogger } from '../logger.ts';
import { exportResearchReport, appendExportMessage } from '../utils/research-export.ts';
import { validateAndSanitizeQuery } from '../utils/input-validation.ts';
import { startResearchSession, registerSessionAbort } from '../utils/session-state.ts';
import { createResearchTuiManager, hideWorkingIndicator } from '../tui/research-tui-manager.ts';
import { createCleanupFunction } from '../cleanup/research-cleanup.ts';
import { createResearchObserver, createObserverState, stopObserverWaveAnimation } from '../observers/research-observer-impl.ts';

import { ensureFunctionalHealth, createHealthMonitor } from '../tui/research-health.ts';
import { errorTracker, type ErrorReport } from '../utils/error-tracker.ts';

/**
 * Format a time ago string from an ISO timestamp
 */
function formatTimeAgo(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const diffMs = now - then;
  
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/**
 * Append error summary to research result
 */
function appendErrorSummary(result: string, errorReport: ErrorReport): string {
  const { totalErrors, uniquePatterns, patterns, byDomain, byType } = errorReport;
  
  // Return unchanged if no errors
  if (totalErrors === 0) {
    return result;
  }
  
  let summary = `\n\n## ⚠️ Error Summary\n\n`;
  summary += `This research encountered **${totalErrors} error(s)** across **${uniquePatterns} unique pattern(s)**.\n\n`;
  
  // Most frequent errors (top 3)
  summary += `**Most frequent error(s):**\n`;
  const topPatterns = patterns.slice(0, 3);
  for (const pattern of topPatterns) {
    const timeAgo = formatTimeAgo(pattern.lastSeen);
    summary += `- **${pattern.count}×**: ${pattern.message} (last: ${timeAgo})\n`;
  }
  
  // Error types
  if (byType.size > 0) {
    summary += `\n**Error types:**\n`;
    const sortedTypes = Array.from(byType.entries()).sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sortedTypes) {
      const percentage = Math.round((count / totalErrors) * 100);
      summary += `- ${type}: ${count} (${percentage}%)\n`;
    }
  }
  
  // Errors by domain (top 5)
  if (byDomain.size > 0) {
    summary += `\n**Errors by domain:**\n`;
    const sortedDomains = Array.from(byDomain.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [domain, count] of sortedDomains) {
      const percentage = Math.round((count / totalErrors) * 100);
      summary += `- ${domain}: ${count} (${percentage}%)\n`;
    }
  }
  
  summary += `---`;
  
  return result + summary;
}

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
      const piSessionId = (ctx as any).sessionManager?.getSessionId() || 'default';
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
            selectedModel = (ctx.modelRegistry as any).getAll().find((m: any) => m.id === modelId);
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
          const sessionResearchId = startResearchSession(piSessionId);
          registerSessionAbort(piSessionId, sessionResearchId, internalAbort);

          // Setup observer
          const observerState = createObserverState();
          const observer = createResearchObserver(
            { panelState, debouncedRefresh: () => tuiManager?.debouncedRefresh(), researchComplexity: depth ?? 0 },
            observerState
          );

          // Setup cleanup (will be updated with actual unsubscribe functions after TUI initialization)
          const cleanup = createCleanupFunction({
            researchId: sessionResearchId,
            piSessionId,
            masterWidgetId: tuiManager.masterWidgetId,
            panelState,
            waveTimer: null,
            unsubOrder: null,
            unsubInput: null,
          }, { ctx });
          
          // Update cleanup with actual unsubscribe functions from TUI manager
          const { updateUnsubOrder, updateUnsubInput } = await import('../cleanup/research-cleanup.ts');
          updateUnsubOrder(cleanup as any, tuiManager.unsubOrder);
          updateUnsubInput(cleanup as any, tuiManager.unsubInput);
          // Note: wave timer will be set by the observer when searching starts

          // Handle abort signal
          if (aborted) {
            aborted.addEventListener('abort', () => internalAbort.abort());
          }

          // Setup scoped logging
          const researchLogger = createLogger({ researchRunId: researchId, verbose: isVerboseFromEnv() });
          const previousLogger = getLogger(); // Save the actual Logger instance, not the proxy
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
            stopObserverWaveAnimation(observerState, panelState);

            const exportPath = await exportResearchReport(sanitizedQuery, result, (depth ?? 0) === 0 ? 'quick' : 'deep', ctx.cwd);
            const finalResult = exportPath ? appendExportMessage(result, exportPath, panelState.totalCost) : result;

            // Append error summary if errors occurred during research
            const errorReport = errorTracker.getReport();
            let resultWithErrorSummary = finalResult;
            if (errorReport.totalErrors > 0) {
              resultWithErrorSummary = appendErrorSummary(finalResult, errorReport);
            }

            // Clear error tracker for next research run
            errorTracker.clear();

            return { result: resultWithErrorSummary, tokens: panelState.totalTokens };
          } catch (error) {
            if (aborted?.aborted || internalAbort.signal.aborted) {
              return { result: 'Research cancelled.', tokens: 0 };
            }
            throw error;
          } finally {
            // Restore previous logger (wrap in try-catch to allow other cleanup to run)
            try {
              setLogger(previousLogger);
            } catch (loggerRestoreError) {
              console.error('[research] Logger restoration failed:', loggerRestoreError);
            }
            
            // Run cleanup (wrap in try-catch to allow other cleanup to run)
            try {
              await cleanup();
            } catch (cleanupError) {
              console.error('[research] Cleanup failed:', cleanupError);
            }
            
            // Dispose TUI manager (wrap in try-catch)
            try {
              if (tuiManager) {
                tuiManager.dispose();
              }
            } catch (disposeError) {
              console.error('[research] TUI dispose failed:', disposeError);
            }
          }
        });

        return { content: [{ type: 'text', text: researchRunResult.result }], details: { totalTokens: researchRunResult.tokens } };
      } catch (error) {
        if (aborted?.aborted || internalAbort.signal.aborted) {
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
