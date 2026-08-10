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
import { redactSecrets } from '../utils/log-utils.ts';
import { exportResearchReport, appendExportMessage } from '../utils/research-export.ts';
import { validateAndSanitizeQuery } from '../utils/input-validation.ts';
import { validateInitialLinks, MAX_INITIAL_LINKS, MAX_INITIAL_LINK_CHARS } from '../utils/url-utils.ts';
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
    // The run produced no meaningful metrics (hard failure before any research ran).
    // The error tracker is the only remaining signal, so surface its count here. This
    // path involves no scrape fallback chains, so it is not subject to the per-URL
    // over-counting that made the tracker unsuitable as the normal error count.
    if (errorReport.totalErrors > 0) {
      return result + `\n\n---\n\n*${errorReport.totalErrors} error${errorReport.totalErrors > 1 ? 's' : ''} encountered during research.*`;
    }
    return result;
  }

  // NOTE: stats.errors is intentionally left as extractRunStats computed it (genuine
  // engine faults only). It is NOT overridden with errorReport.totalErrors: the
  // tracker records ~5-6 entries per failed URL along the fetch→browser fallback
  // chain, so using it here reported blocked/unavailable sources (already shown as
  // "not scraped") as a large, inflated error count. Keeping the metric-derived count
  // also makes the report footnote consistent with the SDK (getLastRunStats) and the
  // session-metrics TUI, which both read extractRunStats().errors.

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
    // Bounded exactly like the CLI's --initial-links flag (validated again in
    // execute via the shared validateInitialLinks — the schema alone is not
    // enforced on every caller path).
    initialLinks: Type.Optional(Type.Array(Type.String({ maxLength: MAX_INITIAL_LINK_CHARS }), {
      maxItems: MAX_INITIAL_LINKS,
      description: `Optional seed URLs to investigate before (or instead of) web search. http(s) only; at most ${MAX_INITIAL_LINKS} URLs of up to ${MAX_INITIAL_LINK_CHARS} characters each.`,
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

      // Enforce the same bounds the CLI applies to --initial-links: these links are
      // templated verbatim into the researcher prompt as trusted seed evidence, so
      // they must be http(s)-only, length-bounded, and count-capped on this path too
      // (the TypeBox schema declares the bounds, but is not enforced by every caller).
      if (initialLinks && initialLinks.length > 0) {
        const linkError = validateInitialLinks(initialLinks);
        if (linkError) {
          return {
            content: [{ type: 'text', text: `Error: invalid initialLinks — ${linkError}.` }],
            details: { error: 'invalid_initial_links' },
          };
        }
      }

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

      // A query is always required — initialLinks seed URLs for a query but cannot
      // replace it (validateAndSanitizeQuery below rejects an empty query anyway;
      // failing here keeps the message clear and matches the CLI's up-front check).
      if (!query) {
        return { content: [{ type: 'text', text: 'Error: research requires a query; initialLinks seed URLs for a query but cannot replace it.' }], details: {} };
      }

      // Each run gets its own isolated registry; session-level counter is incremented
      // here, outside the run context, so it lands in the session registry.
      const runRegistry = new MetricsRegistry();
      const runStartedAt = Date.now();
      metrics.increment('session_runs_started_total');

      try {
        const researchRunResult = await runWithRunRegistry<{ result: string; tokens: number; researchId: string; cancelled: boolean }>(runRegistry, () =>
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
            
            // Minimal stub — only stopObserverWaveAnimation touches panelState in the
            // headless path (it clears wave fields). Run totals come from the metrics
            // registry, so no token/cost state is needed here.
            panelState = {};
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

              // DeepResearchOrchestrator.run() does not throw on cancellation once at
              // least one researcher has produced a report — it returns a fallback
              // synthesis through its normal return path (see
              // deep-research-orchestrator.ts's synthesisService.hasReports branch).
              // Left unchecked, a cancel mid-run that still yields a partial report
              // would fall straight through as if the run had completed normally,
              // with no indication in the returned text — the only channel the
              // calling agent sees — that it is reading a partial result. Mirrors the
              // CLI's cancellation-latch check on its own success path (cmdResearch).
              const wasCancelled = aborted?.aborted === true || internalAbort.signal.aborted;

              // Stop wave animation
              if (observerState && panelState) stopObserverWaveAnimation(observerState, panelState);

              // Append unified research summary (stats + errors). Tokens/cost are read
              // from the run-scoped metrics registry — the single source of truth that
              // is populated identically in TUI and headless mode (the old panelState
              // tally was TUI-only and stayed 0 for every headless/SDK/print-mode run,
              // and even in TUI omitted coordinator+evaluator spend). extractRunStats
              // returns null only when nothing meaningful ran → 0.
              const runSnapshot = runRegistry.getSnapshot();
              const runStats = extractRunStats(runSnapshot);
              const runTokens = runStats?.tokens ?? 0;
              const runCost = runStats?.cost ?? 0;
              const errorReport = sessionTracker.getReport();
              const resultWithSummaries = appendResearchSummary(result, runSnapshot, errorReport);

              let finalResult = resultWithSummaries;
              const exportCfg = getConfig(ctx.cwd, iface);
              if (exportCfg.RESEARCH_REPORT_EXPORT_ENABLED) {
                const exportPath = await exportResearchReport(sanitizedQuery, resultWithSummaries, (depth ?? 1) <= 1 ? 'quick' : 'deep', ctx.cwd, exportCfg.RESEARCH_REPORT_EXPORT_DIR);
                if (exportPath) {
                  finalResult = appendExportMessage(resultWithSummaries, exportPath, runCost);
                }
              }

              // Append research metadata (model used) at the very end, after metrics/summaries
              const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
              finalResult = synthesisService.appendMetadata(finalResult, selectedModel!.id);

              // The calling agent only ever sees `content[].text` — `details` is
              // logs/UI-only (AgentToolResult's own doc comment) — so a cancellation
              // note has to live IN the report text itself, not just in metadata.
              if (wasCancelled) {
                finalResult = `*Research cancelled — the report below is a partial synthesis from what had been collected before the run was stopped.*\n\n${finalResult}`;
              }

              return { result: finalResult, tokens: runTokens, researchId, cancelled: wasCancelled };
            } catch (error) {
              if (aborted?.aborted || internalAbort.signal.aborted) {
                return { result: 'Research cancelled.', tokens: 0, researchId, cancelled: true };
              }
              throw error;
            } finally {
              await teardownUi();
            }
          }));
          return researchRunResult;
        }));  // end runCapturingStderr / runWithRunRegistry

        // Snapshot the run registry. Both branches that produce researchRunResult
        // (the success path above and its inner catch) can represent a cancelled
        // run — status must reflect that, not assume every non-throwing outcome
        // was an ordinary success.
        metrics.recordRunSummary({
          runId: researchId,
          startedAt: runStartedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - runStartedAt,
          status: researchRunResult.cancelled ? 'cancelled' : 'success',
          snapshot: runRegistry.getSnapshot(),
        });

        return {
          content: [{ type: 'text', text: researchRunResult.result }],
          details: {
            totalTokens: researchRunResult.tokens,
            researchId: researchRunResult.researchId,
            ...(researchRunResult.cancelled ? { cancelled: true } : {}),
          },
        };
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

        // Handle rate limits gracefully. "429" is matched on a word boundary
        // (mirroring messageIsTransient in web-research/retry-utils.ts): a substring
        // test also matched digits embedded in a larger number — e.g. a context-
        // overflow error quoting "you requested 142935 tokens" — misreporting the
        // run as rate-limited. 'quota' stays unanchored, same trade-off as
        // retry-utils: provider quota errors ("insufficient_quota") carry no
        // rate/limit wording to anchor on.
        if (/\b429\b/.test(errMsg) || errMsg.includes('rate limit') || errMsg.includes('too many requests') || errMsg.includes('quota')) {
            logger.warn('[research] Run halted gracefully due to rate limit:', error);
            if (ctx.hasUI) {
                ctx.ui.notify('Research halted: API rate limit reached', 'warning');
            }
            return {
                content: [{
                    type: 'text',
                    text: `[SYSTEM MESSAGE]: The research operation was halted gracefully because an API rate limit (HTTP 429) was reached. Please inform the user that the operation was stopped due to provider rate limits and they should wait a moment before trying again.\n\nDetails: ${redactSecrets(String(error))}`
                }],
                details: {}
            };
        }

        logger.error('[research] run failed', error);
        return { content: [{ type: 'text', text: `Research failed: ${redactSecrets(String(error))}` }], details: {} };
      } finally {
        // Guarantees panel teardown even when the run fails before the inner
        // research loop is reached (e.g. health-check failure), where the inner
        // finally never executes. Idempotent: a no-op if teardown already ran.
        await teardownUi();
      }
    },
  };
}
