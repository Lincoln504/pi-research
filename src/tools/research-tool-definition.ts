/**
 * Research Tool Definition
 *
 * Defines the research tool that orchestrates web/internet research.
 * Depth 1-3: AI-orchestrated multi-session research (coordinator → researchers → evaluator).
 *
 * Note: Depth 0 (quick mode) is only available via the SDK / CLI (`--depth 0`,
 * which the agent skill can pass). The pi extension tool has minimum: 1.
 */

import type {
  ToolDefinition,
  AgentToolResult,
  ExtensionContext,
  AgentToolUpdateCallback,
} from '@earendil-works/pi-coding-agent';
import type { ExtendedExtensionContext } from '../types/extension-context.ts';
import type { ResearchDepth, CleanupContext } from '../types/index.ts';
import { Type, type Static } from 'typebox';
import { validateConfig, getConfig, type ConfigInterface } from '../config.ts';
import { tryGetServiceContainerFromCtx, getService } from '../core/service-registry.ts';

import { ServiceNames } from '../core/service-interfaces.ts';
import type { IResearchOrchestration, IResearchSynthesisService } from '../core/service-interfaces.ts';
import { metrics, MetricsRegistry, runWithRunRegistry } from '../utils/metrics.ts';
import { createResearchRunId, logger, createLogger, isVerboseFromEnv, runWithLogger } from '../logger.ts';
import { exportResearchReport, appendExportMessage } from '../utils/research-export.ts';
import { validateAndSanitizeQuery } from '../utils/input-validation.ts';
import { startResearchSession, registerSessionAbort, clearSteeringMessages, getPiActivePanels } from '../orchestration/session-state.ts';
import { createResearchTuiManager, hideWorkingIndicator } from '../tui/research-tui-manager.ts';
import { createCleanupFunction } from '../cleanup/research-cleanup.ts';
import { createResearchObserver, createObserverState, stopObserverWaveAnimation } from '../observers/research-observer-impl.ts';
import { HeadlessObserver } from '../orchestration/headless-observer.ts';

import { ensureFunctionalHealth, createHealthMonitor } from '../tui/research-health.ts';
import { ErrorTracker, runWithTracker, type ErrorReport } from '../utils/error-tracker.ts';
import { extractRunStats, buildResearchSummary } from '../utils/metrics-summary.ts';

/**
 * Append a unified research summary to the result.
 * Replaces the old separate error + scrape summaries.
 *
 * Design: No tables, no percentages — just counts.
 * Emphasizes volume of work done. Errors are a concise footnote when present.
 */
function appendResearchSummary(
  result: string,
  metricsSnapshot: { counters?: Record<string, number>; histograms?: Record<string, any> },
  errorReport: ErrorReport,
): string {
  const stats = extractRunStats(metricsSnapshot as any);

  if (!stats) {
    // No meaningful metrics — still show errors if any
    if (errorReport.totalErrors > 0) {
      return result + `\n\n---\n\n*${errorReport.totalErrors} error${errorReport.totalErrors > 1 ? 's' : ''} encountered during research.*`;
    }
    return result;
  }

  // Override error count from the actual error tracker (more accurate)
  stats.errors = errorReport.totalErrors;

  const summary = buildResearchSummary(stats);
  if (!summary) {
    if (errorReport.totalErrors > 0) {
      return result + `\n\n---\n\n*${errorReport.totalErrors} error${errorReport.totalErrors > 1 ? 's' : ''} encountered during research.*`;
    }
    return result;
  }

  return result + `\n\n---\n\n${summary}`;
}

/**
 * Create the research tool definition
 */
export function createResearchTool(iface?: ConfigInterface): ToolDefinition {
  const parameters = Type.Object({
    query: Type.String({
      description: 'The research topic or query to investigate.',
    }),
    depth: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: 3,
      description: [
        'Research depth (1-3).',
        '1: Normal (coordinated, thorough).',
        '2: Deep (multi-round, exhaustive).',
        '3: Ultra (maximum depth, extreme rigor).',
      ].join('\n'),
      default: 1,
    })),
    model: Type.Optional(Type.String({
      description: 'Optional model ID override for coordination.',
    })),
    excludeTools: Type.Optional(Type.Array(Type.String(), {
      description: 'List of internal tools to disable (e.g., search, scrape, security_search).',
    })),
    initialLinks: Type.Optional(Type.Array(Type.String(), {
      description: 'Optional seed URLs to investigate before (or instead of) web search.',
    })),
  });

  type ResearchParams = Static<typeof parameters>;

  return {
    name: 'research',
    label: 'Research',
    description:
      'Perform multi-source web research using search, scraping, and specialized databases.',
    promptSnippet: 'Execute comprehensive web research',
    parameters,
    renderShell: 'self',
    executionMode: 'parallel',
    prepareArguments: (args: unknown) => {
      const rawArgs = args as Record<string, unknown>;
      const normalized: Record<string, unknown> = {
        query: rawArgs['query'] ?? '',
        model: rawArgs['model'],
        excludeTools: rawArgs['excludeTools'],
        initialLinks: rawArgs['initialLinks'],
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
      const container = tryGetServiceContainerFromCtx(ctx);
      if (!container.isReady && process.env['PI_RESEARCH_FORCE_READY'] !== 'true') {
        return {
          content: [{
            type: 'text',
            text: '**Research system is not ready.**\n\nOne or more critical services failed to initialize during startup. Please check the logs for error details or try restarting the extension.\n\nYou can also run `/research-config health` to diagnose the issue.'
          }],
          details: { error: 'system_not_ready' }
        };
      }

      const { query, depth: rawDepth, model: modelId, excludeTools: paramExcludeTools, initialLinks } = params as ResearchParams;
      const depth = rawDepth ?? Math.max(1, getConfig(ctx.cwd, iface).DEFAULT_RESEARCH_DEPTH) as 1 | 2 | 3;
      const eCtx = ctx as ExtendedExtensionContext;
      const parentExcludeTools = eCtx.excludeTools || [];
      const excludeTools = [...new Set([...(paramExcludeTools || []), ...parentExcludeTools])];

      const researchId = createResearchRunId();
      const piSessionId = eCtx.sessionId || eCtx.sessionManager?.getSessionId() || 'default';
      logger.debug(`[research] Initializing session IDs: piSessionId=${piSessionId}, researchId=${researchId}`);
      
      const internalAbort = new AbortController();
      let tuiManager: ReturnType<typeof createResearchTuiManager> | null = null;
      let healthMonitorInstance: ReturnType<typeof createHealthMonitor> | null = null;
      let observer: any;
      let observerState: any;
      let panelState: any;
      // Assigned only after the TUI panel and observers are wired up. A failure
      // before that point (e.g. the pre-run health check) leaves it undefined,
      // so teardownUi() guards before calling it.
      let cleanup: (() => Promise<void>) | undefined;
      // Removes the listener attached to the parent abort signal (below), so a
      // normally-completing run does not leave a handler (closing over
      // internalAbort) attached to a parent signal that may outlive this call.
      let detachAbortListener: (() => void) | undefined;

      // Single idempotent UI teardown. Runs on every exit path — including a
      // failure that happens before the inner research loop begins (model
      // resolution, health check, observer setup) — so the on-screen research
      // panel is never orphaned empty. The inner finally and the outer finally
      // both call this; the guard makes the second call a no-op.
      let uiTornDown = false;
      const teardownUi = async (): Promise<void> => {
        if (uiTornDown) return;
        uiTornDown = true;

        if (healthMonitorInstance) {
          try { healthMonitorInstance.stop(); } catch (e) { logger.error('[research] Health monitor stop failed:', e); }
        }
        if (observerState && panelState) {
          try { stopObserverWaveAnimation(observerState, panelState); } catch (e) { logger.error('[research] Stop wave animation failed:', e); }
        }
        // Steering messages are shared per pi-session. Only reset them when THIS is
        // the last active run — otherwise a finishing run wipes a concurrent sibling
        // run's queued/active steering mid-flight. This run's panel is still
        // registered here (endResearchSession runs later in cleanup()), so a count
        // of <= 1 means no other run is active.
        try {
          if (getPiActivePanels(piSessionId).length <= 1) clearSteeringMessages(piSessionId);
        } catch (e) { logger.error('[research] Clear steering messages failed:', e); }
        if (detachAbortListener) {
          try { detachAbortListener(); } catch { /* best-effort */ } finally { detachAbortListener = undefined; }
        }
        if (cleanup) {
          try { await cleanup(); } catch (cleanupError) { logger.error('[research] Cleanup failed:', cleanupError); }
        }
        // Disposes the master TUI widget — this is what removes the panel from
        // the screen. Must always run or the empty panel leaks.
        if (tuiManager) {
          try { tuiManager.dispose(); } catch (disposeError) { logger.error('[research] TUI dispose failed:', disposeError); }
        }
      };

      if (!query && (!initialLinks || initialLinks.length === 0)) {
        return { content: [{ type: 'text', text: 'Error: Research query or initialLinks are required' }], details: {} };
      }

      // Each run gets its own isolated registry; session-level counter is incremented
      // here, outside the run context, so it lands in the session registry.
      const runRegistry = new MetricsRegistry();
      const runStartedAt = Date.now();
      metrics.increment('session_runs_started_total');

      try {
        const researchRunResult = await runWithRunRegistry<{ result: string; tokens: number; researchId: string }>(runRegistry, () =>
          logger.runCapturingStderr(async () => {
          const config = getConfig(ctx.cwd, iface);
          validateConfig(config);

          const sanitizedQuery = validateAndSanitizeQuery(query);

          // Get orchestration service
          const orch = await getService<IResearchOrchestration>(ServiceNames.RESEARCH_ORCHESTRATION, ctx, container);
          
          // Resolve model using centralized service logic
          const selectedModel = await orch.resolveResearchModel({
            ctx,
            query: sanitizedQuery,
            model: modelId ? { id: modelId } as any : undefined,
            config,
            sessionId: piSessionId,
            researchId,
          });

          logger.info(`[research] Resolved research model: ${selectedModel.provider}/${selectedModel.id}`);
          
          // Setup TUI or Headless Observer based on context
          if (ctx.mode === 'tui' && ctx.hasUI) {
            tuiManager = createResearchTuiManager({
              piSessionId,
              researchId,
              query: sanitizedQuery,
              modelId: selectedModel.id,
            }, { ctx });
            
            tuiManager.initializePanel();
            panelState = tuiManager.panelState;

            // Setup cleanup BEFORE the functional health check. The panel is
            // already registered in session state (createResearchTuiManager →
            // registerSessionPanel above), so if the health check throws — e.g.
            // "the browser could not load a page in time" on a flaky connection —
            // teardownUi() must have a cleanup function to call. Otherwise the
            // panel is never removed from session state and leaks as a permanent
            // "ghost" panel that stacks higher with every retry. (Root cause of
            // observed multi-panel ghost stacking on repeated health-check failures.)
            const cleanupCtx: CleanupContext = {
              researchId: startResearchSession(piSessionId, researchId),
              piSessionId,
              masterWidgetId: tuiManager.masterWidgetId,
              panelState,
              waveTimer: null,
              unsubOrder: null,
            };
            registerSessionAbort(piSessionId, cleanupCtx.researchId, internalAbort);

            cleanup = createCleanupFunction(cleanupCtx, { ctx });
            const { updateUnsubOrder } = await import('../cleanup/research-cleanup.ts');
            updateUnsubOrder(cleanupCtx, tuiManager.unsubOrder);

            // Perform health check — cleanup is now wired, so a failure here is
            // torn down cleanly (panel removed) instead of leaking a ghost panel.
            await ensureFunctionalHealth({
              panelState,
              onUpdate: () => tuiManager?.debouncedRefresh(),
            });

            // Start health monitor for periodic checks
            healthMonitorInstance = createHealthMonitor();
            healthMonitorInstance.start();

            // Setup TUI observer
            observerState = createObserverState();
            observer = createResearchObserver(
              { panelState, debouncedRefresh: () => tuiManager?.debouncedRefresh(), renderImmediate: () => tuiManager?.renderImmediate(), researchComplexity: depth ?? 1 },
              observerState
            );
          } else {
            // Headless mode (CLI / SDK)
            observer = new HeadlessObserver({ enableLogging: true });
            
            const sessionResearchId = startResearchSession(piSessionId, researchId);
            registerSessionAbort(piSessionId, sessionResearchId, internalAbort);

            cleanup = async () => {
              clearSteeringMessages(piSessionId);
            };
            
            // Stub for stopObserverWaveAnimation
            panelState = { totalTokens: 0, totalCost: 0 };
            observerState = {};
          }

          // Handle abort signal. Track the handler so teardownUi() can detach it
          // on normal completion (the parent signal may outlive this tool call).
          if (aborted) {
            const onParentAbort = () => internalAbort.abort();
            aborted.addEventListener('abort', onParentAbort, { once: true });
            detachAbortListener = () => aborted.removeEventListener('abort', onParentAbort);
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
              const result = await orch.runResearch({
                ctx,
                query: sanitizedQuery || (initialLinks?.[0] ?? 'Initial Links Research'),
                depth: (depth ?? 1) as ResearchDepth,
                model: selectedModel,
                observer,
                onUpdate,
                sessionId: piSessionId,
                researchId,
                excludeTools,
                initialLinks,
                // Pass the interface-resolved config (getConfig(cwd, iface) at the top
                // of this handler) so the RUN honors the same `pi.env` overlay already
                // applied to model/depth/export. Without this the orchestrator falls
                // back to getConfig(cwd) with no interface, silently ignoring a
                // pi.env DISABLED_TOOLS / TIMEOUT_MS / concurrency override for the run.
                config,
              }, internalAbort.signal);

              // Stop wave animation
              if (observerState && panelState) stopObserverWaveAnimation(observerState, panelState);

              // Append unified research summary (stats + errors)
              const errorReport = sessionTracker.getReport();
              const resultWithSummaries = appendResearchSummary(result, runRegistry.getSnapshot(), errorReport);

              let finalResult = resultWithSummaries;
              const exportCfg = getConfig(ctx.cwd, iface);
              if (exportCfg.RESEARCH_REPORT_EXPORT_ENABLED) {
                const exportPath = await exportResearchReport(sanitizedQuery, resultWithSummaries, (depth ?? 1) <= 1 ? 'quick' : 'deep', ctx.cwd, exportCfg.RESEARCH_REPORT_EXPORT_DIR);
                if (exportPath) {
                  finalResult = appendExportMessage(resultWithSummaries, exportPath, panelState?.totalCost ?? 0);
                }
              }

              // Append research metadata (model used) at the very end, after metrics/summaries
              const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
              finalResult = synthesisService.appendMetadata(finalResult, selectedModel!.id);

              return { result: finalResult, tokens: panelState?.totalTokens ?? 0, researchId };
            } catch (error) {
              if (aborted?.aborted || internalAbort.signal.aborted) {
                return { result: 'Research cancelled.', tokens: 0, researchId };
              }
              throw error;
            } finally {
              await teardownUi();
            }
          }));
          return researchRunResult;
        }));  // end runCapturingStderr / runWithRunRegistry

        // Snapshot the run registry
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
      } finally {
        // Guarantees panel teardown even when the run fails before the inner
        // research loop is reached (e.g. health-check failure), where the inner
        // finally never executes. Idempotent: a no-op if teardown already ran.
        await teardownUi();
      }
    },
  };
}
