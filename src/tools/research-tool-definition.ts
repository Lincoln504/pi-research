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
  AgentToolUpdateCallback,
} from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import type { ModelWithId } from '../types/extension-context.ts';
import type { ResearchDepth } from '../types/index.ts';
import { Type, type Static } from 'typebox';
import { validateConfig, getConfig } from '../config.ts';
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IResearchOrchestration } from '../core/service-interfaces.ts';
import { metrics, MetricsRegistry, runWithRunRegistry } from '../utils/metrics.ts';
import { createResearchRunId, logger, createLogger, isVerboseFromEnv, runWithLogger } from '../logger.ts';
import { exportResearchReport, appendExportMessage } from '../utils/research-export.ts';
import { validateAndSanitizeQuery } from '../utils/input-validation.ts';
import { startResearchSession, registerSessionAbort, clearSteeringMessages } from '../utils/session-state.ts';
import { createResearchTuiManager, hideWorkingIndicator } from '../tui/research-tui-manager.ts';
import { createCleanupFunction } from '../cleanup/research-cleanup.ts';
import { createResearchObserver, createObserverState, stopObserverWaveAnimation } from '../observers/research-observer-impl.ts';

import { getServiceContainer } from '../core/service-registry.ts';
import { ensureFunctionalHealth, createHealthMonitor } from '../tui/research-health.ts';
import { ErrorTracker, runWithTracker, type ErrorReport } from '../utils/error-tracker.ts';

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
  
  let summary = `\n\n## Error Summary\n\n`;
  summary += `This research encountered **${totalErrors} error(s)** across **${uniquePatterns} unique pattern(s)**.\n\n`;
  
  // Most frequent errors (top 3)
  summary += `**Most frequent error(s):**\n`;
  const topPatterns = patterns.slice(0, 3);
  for (const pattern of topPatterns) {
    const timeAgo = formatTimeAgo(pattern.lastSeen);
    summary += `- **${pattern.count}x**: ${pattern.message} (last: ${timeAgo})\n`;
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
 * Append scrape summary to research result
 */
function appendScrapeSummary(result: string, metricsSnapshot: any): string {
  const counters = metricsSnapshot.counters || {};
  const fetchSuccess = counters['scrape_results_total{outcome="fetch_success"}'] || 0;
  const browserSuccess = counters['scrape_results_total{outcome="browser_success"}'] || 0;
  const totalFailure = counters['scrape_results_total{outcome="total_failure"}'] || 0;
  const totalAttempts = fetchSuccess + browserSuccess + totalFailure;

  if (totalAttempts === 0) {
    return result;
  }

  const fetchPct = Math.round((fetchSuccess / totalAttempts) * 100);
  const browserPct = Math.round((browserSuccess / totalAttempts) * 100);
  const failPct = Math.round((totalFailure / totalAttempts) * 100);

  let summary = `\n\n## Scrape Performance Summary\n\n`;
  summary += `Total URLs attempted: **${totalAttempts}**\n\n`;
  summary += `| Layer | Success Count | Percentage |\n`;
  summary += `| :--- | :--- | :--- |\n`;
  summary += `| **Fetch (Lightweight)** | ${fetchSuccess} | ${fetchPct}% |\n`;
  summary += `| **Browser (Stealth)** | ${browserSuccess} | ${browserPct}% |\n`;
  summary += `| **Failed (Both)** | ${totalFailure} | ${failPct}% |\n\n`;
  
  if (totalFailure > 0) {
    summary += `*Note: ${totalFailure} URL(s) could not be scraped even with browser fallback.*\n`;
  }
  
  summary += `---`;
  
  return result + summary;
}

/**
 * Create the research tool definition
 */
export function createResearchTool(): ToolDefinition {
  const parameters = Type.Object({
    query: Type.String({
      description: 'Research query or topic to investigate',
    }),
    depth: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: 3,
      description: [
        'Research complexity 1-3.',
        '1: Normal (coordinated, thorough)',
        '2: Deep (multi-round, exhaustive)',
        '3: Ultra (maximum depth, extreme rigor)',
      ].join('\n'),
      default: 1,
    })),
    model: Type.Optional(Type.String({
      description: 'Model ID to use for coordination (optional)',
    })),
    excludeTools: Type.Optional(Type.Array(Type.String(), {
      description: 'List of internal research tools to disable (e.g., search, scrape, grep, security, stackexchange)',
    })),
  });

  type ResearchParams = Static<typeof parameters>;

  return {
    name: 'research',
    label: 'Research',
    description:
      'Perform web/internet research using an internal multi-source system. Synthesizes findings from web search, scraping, security databases, and Stack Exchange.',
    promptSnippet: 'Conduct comprehensive web/internet research',
    parameters,
    renderShell: 'self',
    executionMode: 'parallel',
    prepareArguments: (args: unknown) => {
      const rawArgs = args as Record<string, unknown>;
      const normalized: Record<string, unknown> = {
        query: rawArgs['query'] ?? '',
        model: rawArgs['model'],
        excludeTools: rawArgs['excludeTools'],
      };

      const rawDepth = rawArgs['depth'];
      if (rawDepth !== undefined && rawDepth !== null) {
        if (typeof rawDepth === 'string') {
          const parsed = parseInt(rawDepth, 10);
          normalized['depth'] = isNaN(parsed) ? 1 : Math.max(1, Math.min(3, parsed));
        } else if (typeof rawDepth === 'number') {
          normalized['depth'] = Math.max(1, Math.min(3, rawDepth));
        } else {
          normalized['depth'] = 1;
        }
      } else {
        // No depth argument provided — fall back to the configured default depth
        // rather than always hardcoding 1, so user config is honoured.
        normalized['depth'] = Math.max(1, getConfig().DEFAULT_RESEARCH_DEPTH);
      }

      return normalized;
    },
    async execute(
      _toolCallId: string,
      params: unknown,
      aborted: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<any>,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      // 1. System Readiness Check
      const container = getServiceContainer();
      if (!container.isReady && process.env['PI_RESEARCH_FORCE_READY'] !== 'true') {
        return {
          content: [{
            type: 'text',
            text: '❌ **Research system is not ready.**\n\nOne or more critical services failed to initialize during startup. Please check the logs for error details or try restarting the extension.\n\nYou can also run `/research-config health` to diagnose the issue.'
          }],
          details: { error: 'system_not_ready' }
        };
      }

      const { query, depth, model: modelId, excludeTools: paramExcludeTools } = params as ResearchParams;

      // Inherit exclusions from parent context if possible (new in v0.77.0)
      const parentExcludeTools = (ctx as any).excludeTools || [];
      const excludeTools = [...new Set([...(paramExcludeTools || []), ...parentExcludeTools])];

      const researchId = createResearchRunId();
      const eCtx = ctx as any;
      const piSessionId = eCtx.sessionId || eCtx.sessionManager?.getSessionId() || 'default';
      logger.debug(`[research] Initializing session IDs: piSessionId=${piSessionId}, researchId=${researchId}`);
      
      const internalAbort = new AbortController();
      let tuiManager: ReturnType<typeof createResearchTuiManager> | null = null;
      let healthMonitorInstance: ReturnType<typeof createHealthMonitor> | null = null;

      if (!query) {
        return { content: [{ type: 'text', text: 'Error: Research query is required' }], details: {} };
      }

      // Each run gets its own isolated registry; session-level counter is incremented
      // here, outside the run context, so it lands in the session registry.
      const runRegistry = new MetricsRegistry();
      const runStartedAt = Date.now();
      metrics.increment('session_runs_started_total');

      try {
        const researchRunResult = await runWithRunRegistry<{ result: string; tokens: number; researchId: string }>(runRegistry, () =>
          (logger as any).runCapturingStderr(async () => {
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
          
          // Clear any stale steering messages from previous runs in this session
          clearSteeringMessages(piSessionId);

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
          const sessionResearchId = startResearchSession(piSessionId, researchId);
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
          }, { ctx });
          
          // Update cleanup with actual unsubscribe functions from TUI manager
          const { updateUnsubOrder } = await import('../cleanup/research-cleanup.ts');
          updateUnsubOrder(cleanup as any, tuiManager.unsubOrder);
          // Note: wave timer will be set by the observer when searching starts

          // Handle abort signal — use { once: true } so the listener is auto-removed after the first fire
          if (aborted) {
            aborted.addEventListener('abort', () => internalAbort.abort(), { once: true });
          }

          // Setup scoped logging — use AsyncLocalStorage so concurrent runs don't bleed
          const researchLogger = createLogger({ researchRunId: researchId, verbose: isVerboseFromEnv() });

          // Hide working indicator
          hideWorkingIndicator(ctx);

          // Use runWithTracker to ensure all errors tracked within this async branch
          // are isolated to this research run's tracker.
          const sessionTracker = new ErrorTracker();
          const researchRunResult = await runWithTracker(sessionTracker, () => runWithLogger(researchLogger, async () => {
            try {
              // Run research via orchestration service
              const orch = await getService<IResearchOrchestration>(ServiceNames.RESEARCH_ORCHESTRATION);
              const result = await orch.runResearch({
                ctx,
                query: sanitizedQuery,
                depth: (depth ?? 0) as ResearchDepth,
                model: selectedModel as Model<any>,
                observer,
                onUpdate,
                sessionId: piSessionId,
                researchId,
                excludeTools,
              }, internalAbort.signal);

              // Stop wave animation
              stopObserverWaveAnimation(observerState, panelState);

              // Append error summary if errors occurred during research
              const errorReport = sessionTracker.getReport();
              let resultWithSummaries = result;
              if (errorReport.totalErrors > 0) {
                resultWithSummaries = appendErrorSummary(result, errorReport);
              }

              // Append scrape summary
              resultWithSummaries = appendScrapeSummary(resultWithSummaries, runRegistry.getSnapshot());

              const exportPath = await exportResearchReport(sanitizedQuery, resultWithSummaries, (depth ?? 0) === 0 ? 'quick' : 'deep', ctx.cwd);
              const finalResult = exportPath ? appendExportMessage(resultWithSummaries, exportPath, panelState.totalCost) : resultWithSummaries;

              return { result: finalResult, tokens: panelState.totalTokens, researchId };
            } catch (error) {
              if (aborted?.aborted || internalAbort.signal.aborted) {
                return { result: 'Research cancelled.', tokens: 0, researchId };
              }
              throw error;
            } finally {
              if (healthMonitorInstance) {
                healthMonitorInstance.stop();
              }

              // Stop wave animation unconditionally
              stopObserverWaveAnimation(observerState, panelState);

              // Always clear steering messages when the research run ends
              // to prevent them from leaking into follow-up agent turns.
              clearSteeringMessages(piSessionId);

              // Run cleanup (wrap in try-catch to allow other cleanup to run)
              try {
                await cleanup();
              } catch (cleanupError) {
                logger.error('[research] Cleanup failed:', cleanupError);
              }

              // Dispose TUI manager (wrap in try-catch)
              try {
                if (tuiManager) {
                  tuiManager.dispose();
                }
              } catch (disposeError) {
                logger.error('[research] TUI dispose failed:', disposeError);
              }
            }
          }));
          return researchRunResult;
        }));  // end runCapturingStderr / runWithRunRegistry

        // Snapshot the run registry now that the run context has exited.
        // recordRunSummary() is called outside the run context so it lands
        // in the session-level history, not back into the run registry.
        metrics.recordRunSummary({
          runId: researchId,
          startedAt: runStartedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - runStartedAt,
          status: 'success',
          snapshot: runRegistry.getSnapshot(),
        });

        return { content: [{ type: 'text', text: researchRunResult.result }], details: { totalTokens: researchRunResult.tokens } };
      } catch (error) {
        if (aborted?.aborted || internalAbort.signal.aborted) {
          metrics.recordRunSummary({
            runId: researchId,
            startedAt: runStartedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - runStartedAt,
            status: 'cancelled',
            snapshot: runRegistry.getSnapshot(),
          });
          return { content: [{ type: 'text', text: 'Research cancelled.' }], details: {} };
        }

        // Record error summary before returning any error response.
        metrics.recordRunSummary({
          runId: researchId,
          startedAt: runStartedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - runStartedAt,
          status: 'error',
          snapshot: runRegistry.getSnapshot(),
        });

        const errMsg = String(error).toLowerCase();

        // Handle rate limits gracefully
        if (errMsg.includes('429') || errMsg.includes('rate limit') || errMsg.includes('too many requests') || errMsg.includes('quota')) {
            logger.warn('[research] Run halted gracefully due to rate limit:', error);
            if (ctx.hasUI) {
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
