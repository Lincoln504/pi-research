/**
 * Pi Research Programmatic SDK
 *
 * Provides a clean API for running research without the Pi CLI / TUI.
 * Ideal for scripts, CI/CD, and integration into other tools.
 */

import { 
  registerCoreServices, 
  initializeCoreServices, 
  disposeCoreServices 
} from './core/service-initialization.ts';
import {
  registerInfrastructureServices,
  initializeInfrastructureServices
} from './infrastructure/service-initialization.ts';
import { 
  registerOrchestrationServices, 
  initializeOrchestrationServices 
} from './orchestration/service-initialization.ts';
import { getService, resetServiceContainer, getServiceContainer } from './core/service-registry.ts';
import type { ServiceContainer } from './core/service-registry.ts';
import { ServiceNames } from './core/service-interfaces.ts';
import type { IKnowledgeStoreService } from './core/interfaces/knowledge-interfaces.ts';
import type { 
  IResearchOrchestration, 
  IResearchSynthesisService,
  ResearchOptions 
} from './core/interfaces/orchestration-interfaces.ts';
import type { Model } from '@earendil-works/pi-ai';
import { type ExtensionContext, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { logger, createLogger, setLogger } from './logger.ts';
import { getConfig, createConfig, validateConfig, type Config } from './config.ts';
import { metrics, MetricsRegistry, runWithRunRegistry } from './utils/metrics.ts';
import type { IMetricsSnapshot, RunSummary } from './utils/metrics.ts';
import { extractRunStats, type ResearchStats } from './utils/metrics-summary.ts';
import { ErrorTracker, runWithTracker, type ErrorReport } from './utils/error-tracker.ts';
import { runHealthCheck } from './healthcheck/index.ts';
import { buildModelRegistry as sharedBuildModelRegistry, resolveModel } from './core/llm/model-registry-factory.ts';
import { scrapeSingle } from './web-research/web-scraper.ts';
import { validateInitialLinks } from './utils/url-utils.ts';
import { validateUrlForSSRF } from './web-research/scraper-utils.ts';
import type { ScrapeResult } from './core/interfaces/scheduler-interfaces.ts';
import { randomUUID } from 'node:crypto';
import type { ResearchDepth } from './types/index.ts';

// ---------------------------------------------------------------------------
// Global SDK State
// ---------------------------------------------------------------------------

let isInitialized = false;
let _initPromise: Promise<void> | null = null;
let globalRegistry: ModelRegistry | null = null;
let globalModel: Model<any> | null = null;
let globalCwd: string = process.cwd();
let globalApiKey: string | undefined = undefined;
let globalContainer: ServiceContainer | null = null;
let globalConfig: Config | null = null;
let _lastSessionId: string | null = null;
// Guards against overlapping runDeepResearch calls on the one SDK instance. The
// `_last*` accessors below are module singletons with last-writer-wins semantics, so a
// second concurrent run would silently corrupt the first run's reported sessionId /
// metrics / reports. Concurrent runs are documented-unsupported; this converts that
// silent mis-attribution into an explicit, contract-matching error.
let _isRunning = false;
// The researchId of the most recent runDeepResearch call. Per-researcher reports are
// stored keyed by researchId (not sessionId), so getResearchReports() must look them up
// by this value — sessionId is a distinct random UUID that was never a report key.
let _lastResearchId: string | null = null;
// Per-run metrics summary captured by the most recent runDeepResearch call, so
// consumers (e.g. audit harnesses) can read pi-research's internal telemetry —
// latency, scrape/search counts, tokens, cost, tool usage — after each run.
let _lastRunSummary: RunSummary | null = null;
// Per-run error report captured by the most recent runDeepResearch call. Without
// this, the SDK path never bound an ErrorTracker, so every tracked error (healthcheck
// timeouts, provider failures, scrape errors) was written to the global tracker and
// discarded unread. Now each run gets its own tracker, a concise summary is logged at
// run end when errors occurred, and consumers can read the full report after the run.
let _lastErrorReport: ErrorReport | null = null;

// Signal handler state — registered once, removed on clean shutdown.
let _onSignal: ((signal: string) => void) | null = null;
let _sigintHandler: (() => void) | null = null;
let _sigtermHandler: (() => void) | null = null;
let _sighupHandler: (() => void) | null = null;
let _sigbreakHandler: (() => void) | null = null;
let _shuttingDown = false;
// In-flight shutdown guard. A cooperative shutdownResearchSDK() can race a
// signal-triggered one (or two callers in a finally + signal): both pass the
// early-return while isInitialized is still true and then double-dispose the
// container and double-wipe globals. Coalesce them onto one promise.
let _shutdownPromise: Promise<void> | null = null;

function _registerSignalHandlers(): void {
  if (_onSignal) return; // already registered

  _onSignal = (signal: string) => {
    if (_shuttingDown) return;
    _shuttingDown = true;

    // Mark that the process is going down so native addons know to skip risky teardowns
    process.env['PI_PROCESS_EXITING'] = '1';

    logger.warn(`[SDK] Received ${signal} — shutting down gracefully...`);
    // Fire-and-forget shutdown; force-exit after a hard deadline. The timer is
    // cleared once shutdown settles so an embedded host that keeps its event
    // loop alive past our teardown isn't hard-killed 15s later.
    const forceExitTimer = setTimeout(() => {
      logger.error(`[SDK] Forced exit after ${signal} (shutdown timed out)`);
      process.exit(1);
    }, 15000);
    forceExitTimer.unref();
    shutdownResearchSDK()
      .catch(err => logger.error('[SDK] Signal shutdown error:', err))
      .finally(() => clearTimeout(forceExitTimer));
  };

  // Store named refs so we can remove only our handlers without nuking the host's.
  _sigintHandler  = () => _onSignal?.('SIGINT');
  _sigtermHandler = () => _onSignal?.('SIGTERM');
  _sighupHandler  = () => _onSignal?.('SIGHUP');
  process.on('SIGINT',  _sigintHandler);
  process.on('SIGTERM', _sigtermHandler);
  process.on('SIGHUP',  _sighupHandler);
  if (process.platform === 'win32') {
    _sigbreakHandler = () => _onSignal?.('SIGBREAK');
    process.on('SIGBREAK', _sigbreakHandler);
  }
}

function _removeSignalHandlers(): void {
  if (_sigintHandler)   { process.removeListener('SIGINT',   _sigintHandler);   _sigintHandler   = null; }
  if (_sigtermHandler)  { process.removeListener('SIGTERM',  _sigtermHandler);  _sigtermHandler  = null; }
  if (_sighupHandler)   { process.removeListener('SIGHUP',   _sighupHandler);   _sighupHandler   = null; }
  if (_sigbreakHandler) { process.removeListener('SIGBREAK', _sigbreakHandler); _sigbreakHandler = null; }
  _onSignal = null;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Options for initializing the Research SDK
 */
export interface ResearchSDKOptions {
  /** 
   * The LLM model to use for coordination, planning, and evaluation.
   * If a string, it must match "provider/id" (e.g. "openai/gpt-4o").
   * If omitted, the first available model in pi's configuration will be used.
   */
  model?: string | Model<any>;
  
  /** 
   * Optional explicit API key for the model. 
   * If provided, `provider` must also be set.
   * If omitted, pi's global auth storage (~/.pi/agent/auth.json) is used.
   */
  apiKey?: string;

  /**
   * The provider name for the explicit API key (e.g. "openai", "anthropic").
   * Required if `apiKey` is provided.
   */
  provider?: string;

  /**
   * Override configuration values directly in code. These win over any values
   * read from the global config file, so the SDK can be driven entirely from
   * code (see `ignoreGlobalConfig` for fully hermetic usage).
   */
  config?: Partial<Config>;

  /**
   * When true, the SDK does NOT read the global `~/.pi/research/config.env` file
   * at all — configuration comes only from built-in defaults, `process.env`, and
   * `options.config`. Use this to run the SDK as a self-contained library with no
   * dependency on a machine's global pi-research configuration.
   */
  ignoreGlobalConfig?: boolean;

  /**
   * Working directory for research logs and database. 
   * Defaults to current process directory.
   */
  cwd?: string;

  /**
   * Whether to enable verbose logging to the console.
   */
  verbose?: boolean;
}

/**
 * Get the internal service container used by the SDK.
 * @internal For testing only.
 */
export function getSDKContainer(): ServiceContainer | null {
  return globalContainer;
}

/**
 * Internal initializer — registers services and makes the SDK ready. Only ever reached when the
 * SDK is NOT already initialized (initResearchSDK guards and no-ops on repeat calls). To
 * re-initialize with a new cwd/config/model, call shutdownResearchSDK() first — as the public
 * initResearchSDK warning instructs. (A previous in-function re-init branch here was dead code:
 * unreachable through the public API, and it contradicted that idempotent contract.)
 */
async function _doInit(options: ResearchSDKOptions = {}): Promise<void> {
  const newCwd = options.cwd ? options.cwd : process.cwd();
  globalCwd = newCwd;

  // Verbose logging setup
  if (options.verbose) {
    setLogger(createLogger({ verbose: true }));
  }

  // Seed configuration. The SDK is a library: it reads the base global config
  // file for convenience, but NEVER a per-interface overlay (those belong to the
  // pi/cli front-ends). `ignoreGlobalConfig` drops the file entirely so
  // the SDK runs purely from defaults + process.env + options.config — fully
  // self-contained and reproducible from code.
  const baseConfig = options.ignoreGlobalConfig
    ? createConfig({}, process.env)
    : getConfig(globalCwd);
  globalConfig = { ...baseConfig };
  if (options.config) {
    globalConfig = { ...globalConfig, ...options.config };
    validateConfig(globalConfig);
  }

  globalApiKey = options.apiKey || process.env['PI_RESEARCH_API_KEY'];
  let parsedProvider = options.provider || process.env['PI_RESEARCH_PROVIDER'];

  // Infer provider from model if not explicitly provided
  if (!parsedProvider && options.model) {
    if (typeof options.model === 'string') {
      const slashIdx = options.model.indexOf('/');
      if (slashIdx > 0) {
        parsedProvider = options.model.slice(0, slashIdx);
      }
    } else if ((options.model as any).provider) {
      parsedProvider = (options.model as any).provider;
    }
  }

  if (globalApiKey && !parsedProvider) {
    throw new Error('Provider must be specified when using an explicit API key (set provider option or PI_RESEARCH_PROVIDER).');
  }

  // Build and cache the registry (one instance for the lifetime of this init cycle).
  globalRegistry = sharedBuildModelRegistry(globalApiKey, parsedProvider);

  try {
    // Resolve model using unified logic.
    globalModel = resolveModel(globalRegistry, typeof options.model === 'string' ? options.model : undefined, parsedProvider, globalApiKey);

    // Use the global container to ensure internal services can resolve dependencies
    globalContainer = getServiceContainer();

    // Register and initialize services
    registerCoreServices(globalContainer);
    registerInfrastructureServices(globalContainer);
    registerOrchestrationServices(globalContainer);

    const mockCtx = createMockContext('init-session');
    const initResult = await Promise.all([
      initializeCoreServices(mockCtx, globalContainer),
      initializeInfrastructureServices(mockCtx, globalContainer),
      initializeOrchestrationServices(mockCtx, globalContainer)
    ]);

    const allSucceeded = initResult.every(r => r && r.success);
    if (!allSucceeded) {
      const failed = initResult.flatMap(r => r?.failed || []);
      throw new Error(`Failed to initialize SDK services: ${failed.join(', ')}`);
    }

    isInitialized = true;
    logger.log('[SDK] Research SDK initialized successfully');

    // Register graceful-shutdown signal handlers (SIGINT/SIGTERM).
    // These are a safety net for scripts and long-running embedders —
    // the cooperative shutdownResearchSDK() API is still the primary path.
    _registerSignalHandlers();
  } catch (err) {
    logger.error('[SDK] Initialization failed:', err);
    // Cleanup on failure. If the cleanup ITSELF throws (AggregateError from
    // dispose), don't let it mask the root-cause init error the caller needs —
    // log it and re-throw the original.
    try {
      // Call the raw teardown directly, NOT the public shutdownResearchSDK(): we are
      // inside _doInit and _initPromise still points at this very (rejecting) promise, so
      // the public path's await-init guard would deadlock awaiting itself.
      await _doShutdown();
    } catch (cleanupErr) {
      logger.error('[SDK] Cleanup after failed init also errored:', cleanupErr);
    }
    throw err;
  } finally {
    _initPromise = null;
  }
}

/**
 * Public initialization. Guarantees the SDK is ready for use.
 */
export async function initResearchSDK(options: ResearchSDKOptions = {}): Promise<void> {
  if (isInitialized) {
    logger.warn('[SDK] Research SDK already initialized. Call shutdownResearchSDK() first if you want to re-initialize with new options.');
    return;
  }
  if (_initPromise) return _initPromise;
  _initPromise = _doInit(options);
  return _initPromise;
}

// ---------------------------------------------------------------------------
// Research API
// ---------------------------------------------------------------------------

import { runBrowserTask } from './infrastructure/browser/task-execution-service.ts';
import { repairJson as piAiRepairJson } from '@earendil-works/pi-ai';

/**
 * Repairs malformed JSON string literals by escaping control characters 
 * and fixing common LLM formatting errors.
 */
export function repairJson(json: string): string {
  return piAiRepairJson(json);
}

/**
 * Export the current knowledge store contents for use in a web frontend or backup.
 * 
 * @param outputPath - Path where the JSON export should be saved.
 */
export async function exportKnowledge(outputPath: string): Promise<void> {
  if (!isInitialized || !globalContainer) throw new Error('SDK not initialized. Call initResearchSDK() first.');
  
  const ks = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, undefined, globalContainer);
  if (!ks) throw new Error('Knowledge store service not available');
  
  await ks.exportForWeb(outputPath);
}

/**
 * Verify if a URL exists and is reachable using the stealth browser.
 */
export async function verifyUrl(url: string, signal?: AbortSignal): Promise<boolean> {
  if (!isInitialized || !globalContainer) throw new Error('SDK not initialized. Call initResearchSDK() first.');

  try {
    // SSRF gate: runBrowserTask navigates the initial URL directly (the worker
    // only re-validates redirect hops), so unlike scrapeSingle this path has no
    // entry-point validation of its own. Block private/loopback/metadata targets
    // before any browser navigation.
    await validateUrlForSSRF(url);

    const result = await runBrowserTask<{ content: string; success: boolean }>(
      url,
      'scrape',
      globalConfig!,
      signal,
      1,
      globalContainer
    );
    return !!(result && result.success);
  } catch (err) {
    logger.debug(`[SDK] URL verification failed for ${url}:`, err);
    return false;
  }
}

/**
 * Scrape a single URL with the SAME two-layer scraper the research pipeline uses:
 * a fast HTTP fetch first, then a stealth-browser (playwright/camoufox) fallback for
 * JS-heavy or bot-protected pages, with SSRF validation up front. Requires
 * initResearchSDK() to have been called. Never throws on a failed scrape — inspect
 * `result.success`; the page content is returned as `result.markdown`.
 */
export async function scrapeUrl(url: string, signal?: AbortSignal): Promise<ScrapeResult> {
  if (!isInitialized || !globalContainer) throw new Error('SDK not initialized. Call initResearchSDK() first.');
  return scrapeSingle(url, signal, globalConfig ?? undefined, undefined, globalContainer);
}

/**
 * Run a "Deep" research task (multi-round, multi-agent).
 *
 * @param query - The research objective
 * @param options - Research configuration (depth, complexity, observer)
 * @param signal - Optional abort signal
 * @returns The final synthesized research report (Markdown). The session used is
 *          tracked internally; call getResearchReports() (no args) afterwards to
 *          retrieve the per-researcher reports from this run.
 *
 * Note: `_lastSessionId` and `_lastRunSummary` are module-level singletons. Because
 * overlapping concurrent calls would corrupt each other's session/metrics/report state,
 * a concurrent call on the same SDK instance throws immediately (run sequentially, or use
 * a separate process/instance). Within a run, `runResearchDetailed()` captures the
 * session/metrics atomically.
 */
export async function runDeepResearch(
  query: string,
  options: Omit<ResearchOptions, 'ctx' | 'query' | 'model' | 'sessionId' | 'researchId'> = {},
  signal?: AbortSignal
): Promise<string> {
  if (!isInitialized || !globalContainer) throw new Error('SDK not initialized. Call initResearchSDK() first.');

  if (options.initialLinks?.length) {
    const linkError = validateInitialLinks(options.initialLinks);
    if (linkError) throw new Error(`Invalid initialLinks: ${linkError}`);
  }

  if (_isRunning) {
    throw new Error('A research run is already in progress on this SDK instance; concurrent runs are not supported. Await the current run, or use a separate process/instance.');
  }
  _isRunning = true;

  const researchId = `sdk-${Date.now()}`;
  const sessionId = randomUUID();
  _lastSessionId = sessionId;
  _lastResearchId = researchId;

  const researchStart = Date.now();
  const depth = options.depth ?? 1;
  const depthLabel = depth === 0 ? 'quick' : `deep-${depth}`;
  const complexity = Math.max(1, Math.min(3, options.complexity ?? 1));

  // Wrap the run in its own metrics registry so all counters/timings emitted
  // during this call are isolated to a per-run snapshot (the SDK path does not
  // go through the research tool's run-registry, so without this every run's
  // metrics would only accumulate into the cumulative session registry).
  const runRegistry = new MetricsRegistry();
  // Per-run error tracker bound to this call's async context, so every errorTracker
  // .trackError() emitted by the browser pool / orchestrator during the run is captured
  // here instead of vanishing into the never-read global tracker.
  const runTracker = new ErrorTracker();

  try {
    // Resolve the orchestrator INSIDE the try: getService() can throw (container
    // disposal race with shutdown, or an unregistered service), and if that throw
    // escaped before the finally below, _isRunning would latch true forever — every
    // later run would then wrongly report "already in progress" even across a full
    // shutdown+init cycle. Keeping it in the try guarantees the finally always clears it.
    const orchestrator = await getService<IResearchOrchestration>(ServiceNames.RESEARCH_ORCHESTRATION, undefined, globalContainer);
    let result = await runWithRunRegistry(runRegistry, () => runWithTracker(runTracker, () => orchestrator.runResearch({
      ...options,
      ctx: createMockContext(sessionId),
      query,
      model: globalModel!,
      sessionId,
      researchId,
      depth: depth as ResearchDepth,
      complexity: complexity as 1 | 2 | 3,
      initialLinks: options.initialLinks,
      // Forward the SDK's resolved config so initResearchSDK({ config }) overrides
      // actually reach the orchestrator and every downstream service. A per-call
      // options.config (if provided) takes precedence over the SDK-global config.
      config: options.config ?? globalConfig ?? undefined,
    }, signal ?? options.signal)));

    // Append research metadata (model used) at the very end
    const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, undefined, globalContainer);
    result = synthesisService.appendMetadata(result, globalModel!.id);

    const completedAt = Date.now();
    // Emit into the per-run registry directly: this runs AFTER runWithRunRegistry's ALS scope
    // has closed, so metrics.observe() would fall back to session scope and accumulate
    // unbounded across calls (a long-lived SDK/benchmark process). runRegistry.observe() lands
    // it in this run's snapshot, matching the tool path's run-scoped emission.
    runRegistry.observe('research_manager_latency_ms', completedAt - researchStart, { depth: depthLabel, status: 'success', source: 'sdk' });
    _lastRunSummary = {
      runId: researchId, startedAt: researchStart, completedAt,
      durationMs: completedAt - researchStart, status: 'success', snapshot: runRegistry.getSnapshot(),
    };
    metrics.recordRunSummary(_lastRunSummary);
    _lastErrorReport = runTracker.getReport();
    logRunErrorSummary(_lastErrorReport, depthLabel, 'success');
    return result;
  } catch (err) {
    const completedAt = Date.now();
    // Per-run scope (see the success path above) — avoids unbounded session-scope accumulation.
    runRegistry.observe('research_manager_latency_ms', completedAt - researchStart, { depth: depthLabel, status: 'error', source: 'sdk' });
    _lastRunSummary = {
      runId: researchId, startedAt: researchStart, completedAt,
      durationMs: completedAt - researchStart, status: 'error', snapshot: runRegistry.getSnapshot(),
    };
    metrics.recordRunSummary(_lastRunSummary);
    _lastErrorReport = runTracker.getReport();
    logRunErrorSummary(_lastErrorReport, depthLabel, 'error');
    throw err;
  } finally {
    // Free the per-run PiSessionState that shouldStopResearch()/getFailedResearchers()
    // lazily created (keyed by this run's random sessionId). A long-lived SDK/benchmark
    // process doing thousands of runs would otherwise accumulate one never-freed entry
    // (failures/aborts/panels) per run — only full shutdown reclaimed them before.
    try { endResearchSession(sessionId, researchId); } catch { /* best-effort */ }
    _isRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Audit / telemetry accessors
// ---------------------------------------------------------------------------

/**
 * Raw metrics snapshot (counters/gauges/histograms) captured during the most
 * recent runDeepResearch/runQuickResearch call. Null if no run has completed.
 * Read this BEFORE calling shutdownResearchSDK() (shutdown clears all metrics).
 */
export function getLastRunMetrics(): IMetricsSnapshot | null {
  return _lastRunSummary?.snapshot ?? null;
}

/**
 * Full RunSummary (runId, status, durationMs, snapshot) for the most recent run.
 */
export function getLastRunSummary(): RunSummary | null {
  return _lastRunSummary;
}

/**
 * Aggregated error report (counts, patterns, by-domain, by-type) for the most recent
 * run. Lets an unattended operator read exactly which errors occurred without scraping
 * logs. Null until the first run completes; cleared on shutdown.
 */
export function getLastErrorReport(): ErrorReport | null {
  return _lastErrorReport;
}

/**
 * Emit a single compact line summarizing a run's tracked errors, so they are visible in
 * the operator's log instead of silently accumulating. No-op when the run was clean.
 */
function logRunErrorSummary(report: ErrorReport | null, depthLabel: string, status: 'success' | 'error'): void {
  if (!report || report.totalErrors === 0) return;
  const top = report.patterns.slice(0, 3)
    .map(p => `"${String(p.message ?? p.signature ?? 'error').slice(0, 48)}" ×${p.count}`)
    .join(', ');
  logger.warn(`[SDK] run ${status} with ${report.totalErrors} tracked error(s) across ${report.uniquePatterns} pattern(s) [${depthLabel}]${top ? ` — top: ${top}` : ''}`);
}

/**
 * Distilled, human-relevant stats from the most recent run (researchers launched,
 * searches, URLs analyzed/failed, tokens, cost, per-tool usage). Null if no run
 * has completed or the snapshot has no recognizable research counters.
 */
export function getLastRunStats(): ResearchStats | null {
  return _lastRunSummary ? extractRunStats(_lastRunSummary.snapshot) : null;
}

/**
 * Cumulative session-level metrics snapshot across every run since init (or the
 * last shutdown). Use getLastRunMetrics() for per-run deltas instead.
 */
export function getSessionMetrics(): IMetricsSnapshot {
  return metrics.getSessionSnapshot();
}

/**
 * Run the full system health check (browser pool, knowledge store, state manager,
 * GPU lock). Useful for an audit harness reporting tool health before/after a run.
 */
export async function getResearchHealth(opts?: { force?: boolean }) {
  if (!isInitialized || !globalContainer) throw new Error('SDK not initialized. Call initResearchSDK() first.');
  return runHealthCheck({ force: opts?.force, ctx: { container: globalContainer } });
}

/**
 * Run a "Quick" research task (single-pass, single-agent).
 * Equivalent to calling runDeepResearch with depth: 0.
 */
export async function runQuickResearch(
  query: string,
  options: Omit<ResearchOptions, 'ctx' | 'query' | 'model' | 'sessionId' | 'researchId' | 'depth'> = {},
  signal?: AbortSignal
): Promise<string> {
  return runDeepResearch(query, { ...options, depth: 0 } as any, signal);
}

/**
 * Retrieve all researcher reports gathered during the most recent runDeepResearch() call.
 * Reports are keyed by researcher ID (e.g. "1.researcher-0"). Pass the runId returned from
 * runResearchDetailed() to target a specific run; omit to use the last run.
 *
 * Reports are looked up by researchId — the same key they were stored under — not by the
 * sessionId (a distinct random UUID). Read them before the next runDeepResearch() call:
 * retention is bounded by the synthesis service's LRU, so a much later read may find a run
 * evicted.
 */
export async function getResearchReports(researchId?: string): Promise<Map<string, string>> {
  if (!globalContainer) throw new Error('SDK not initialized');
  const id = researchId ?? _lastResearchId;
  if (!id) return new Map();
  const synthesis = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, undefined, globalContainer);
  return synthesis.getAllReports(id);
}

/**
 * The full result of a research run: the report plus everything an audit harness
 * needs in one call — the session id, the per-run metrics snapshot and distilled
 * stats, and the per-researcher reports.
 */
export interface ResearchRunResult {
  report: string;
  sessionId: string;
  runId: string;
  metrics: IMetricsSnapshot | null;
  stats: ResearchStats | null;
  reports: Map<string, string>;
}

/**
 * Like runDeepResearch but returns a rich result object (report + sessionId +
 * per-run metrics/stats + per-researcher reports) instead of just the report
 * string. Ideal for programmatic/audit consumers.
 */
export async function runResearchDetailed(
  query: string,
  options: Omit<ResearchOptions, 'ctx' | 'query' | 'model' | 'sessionId' | 'researchId'> = {},
  signal?: AbortSignal
): Promise<ResearchRunResult> {
  const report = await runDeepResearch(query, options, signal);
  return {
    report,
    sessionId: _lastSessionId ?? '',
    runId: _lastRunSummary?.runId ?? '',
    metrics: _lastRunSummary?.snapshot ?? null,
    stats: getLastRunStats(),
    reports: await getResearchReports(),
  };
}

// ---------------------------------------------------------------------------
// Knowledge Search
// ---------------------------------------------------------------------------

/**
 * Result of a knowledge-store search: a human-readable synthesis/report string
 * plus a coarse status the caller can branch on (mirrors the pi tool's tri-state).
 *
 * - `found: 'yes'`   — the knowledge store had a complete, cited answer.
 * - `found: 'maybe'` — partial answer; the caller should also do live research.
 * - `found: 'no'`    — nothing useful; the caller should do live research. `text`
 *                     explains why (store empty, disabled, initializing, no match, …).
 */
export interface KnowledgeSearchResult {
  text: string;
  found: 'yes' | 'maybe' | 'no';
  documentsSearched: number;
  citations: string[];
}

/**
 * Search the research knowledge store for previously investigated information.
 *
 * This is the SDK equivalent of the `research_knowledge_search` pi tool. It runs
 * the same pipeline (vector search → document rebuild → background-LLM synthesis)
 * against the initialized knowledge store and returns a tri-state result that a
 * caller (e.g. a CLI, an MCP server, or another agent host) can use to decide
 * whether live research is still needed.
 *
 * Requires `initResearchSDK()` first, and a knowledge store mode other than
 * `none` (set `PI_RESEARCH_KNOWLEDGE_STORE_MODE=project|global`). When the store
 * is disabled/empty/unavailable this resolves to a `found: 'no'` result instead
 * of throwing, so callers can treat it uniformly.
 */
export async function searchKnowledge(
  queries: string[],
  signal?: AbortSignal,
): Promise<KnowledgeSearchResult> {
  if (!isInitialized || !globalContainer) {
    throw new Error('SDK not initialized. Call initResearchSDK() first.');
  }
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error('searchKnowledge requires a non-empty array of queries.');
  }

  // Lazily import the tool factory so the SDK bundle stays lean when unused.
  const { createResearchKnowledgeSearchTool } = await import('./tools/research-knowledge-search.ts');
  // No per-interface overlay for the SDK — base config only (options.config has
  // already been merged into globalConfig used by the run path).
  const tool = createResearchKnowledgeSearchTool();

  const result = await tool.execute(
    randomUUID(),
    { queries: queries.slice(0, 5) },
    signal,
    undefined,
    createMockContext(`knowledge-${randomUUID()}`),
  );

  const textBlock = result.content?.find((c): c is { type: 'text'; text: string } => c.type === 'text');
  const details = (result.details ?? {}) as {
    found?: boolean;
    answerStatus?: 'yes' | 'maybe' | 'no';
    citations?: string[];
    documentsSearched?: number;
    reason?: string;
  };

  const status: 'yes' | 'maybe' | 'no' = details.answerStatus ?? (details.found ? 'yes' : 'no');
  return {
    text: textBlock?.text ?? 'No results found.',
    found: status,
    documentsSearched: details.documentsSearched ?? 0,
    citations: details.citations ?? [],
  };
}

import { clearAllSessionState, endResearchSession } from './orchestration/session-state.ts';
import { shutdownManager } from './utils/shutdown-manager.ts';

/**
 * Shutdown the SDK and cleanup all background processes and resources.
 */
export async function shutdownResearchSDK(): Promise<void> {
  if (!isInitialized && !_initPromise && !globalContainer) {
    return;
  }
  // If an initialization is still in flight, let it settle before tearing down. The
  // early-return above only fires when nothing exists yet; once _initPromise is set,
  // isInitialized is still false, so without this a shutdown racing an un-awaited init
  // would dispose/reset the very container initializeCoreServices is still populating.
  // (_doInit's own failure cleanup calls _doShutdown() directly, so it never re-enters
  // here and cannot deadlock awaiting its own promise.)
  if (_initPromise) {
    await _initPromise.catch(() => { /* init failed; fall through to clean up partial state */ });
  }
  // Coalesce concurrent/overlapping shutdowns onto a single teardown so the
  // container is disposed and globals wiped exactly once.
  if (_shutdownPromise) return _shutdownPromise;
  _shutdownPromise = _doShutdown().finally(() => { _shutdownPromise = null; });
  return _shutdownPromise;
}

async function _doShutdown(): Promise<void> {
  logger.log('[SDK] Shutting down Research SDK...');

  const errors: Error[] = [];

  try {
    await shutdownManager.runCleanup('sdk_shutdown');
  } catch (err) {
    logger.error('[SDK] Error during shutdown cleanup:', err);
    errors.push(err instanceof Error ? err : new Error(String(err)));
  }

  try {
    clearAllSessionState();
    metrics.clearSession();
  } catch (err) {
    logger.error('[SDK] Error clearing session state:', err);
    errors.push(err instanceof Error ? err : new Error(String(err)));
  }

  if (globalContainer) {
    // Dispose all services in one DAG-ordered teardown. disposeCoreServices first
    // clears the embedding-server state while the StateManager is still alive, then
    // disposes EVERY registered service (infra → core → orchestration) in dependency
    // order. (shutdownInfrastructureServices and disposeCoreServices both delegate to
    // the same global disposeAllServices, so calling infra first would dispose the
    // StateManager prematurely and force it to be resurrected just to clear the
    // embedding server — wasteful churn that re-creates state during teardown.)
    try {
      await disposeCoreServices(globalContainer);
    } catch (err) {
      logger.error('[SDK] Error disposing services:', err);
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }

    // Reset the container (clears registrations; the internal disposeAll is a no-op
    // here because every service was already disposed above).
    try {
      await resetServiceContainer(globalContainer);
    } catch (err) {
      logger.error('[SDK] Error resetting service container:', err);
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Always reset globals so the SDK can be re-initialized
  isInitialized = false;
  _shuttingDown = false;
  _initPromise = null;
  // Belt-and-suspenders: an orphaned run whose finally() never settled (e.g. a
  // native call that outlives disposal) would otherwise leave _isRunning latched
  // true, so every runDeepResearch() after a shutdown+re-init in the same process
  // throws "already in progress". The run's own finally remains the primary clear.
  _isRunning = false;
  globalRegistry = null;
  globalModel = null;
  globalCwd = process.cwd();
  globalContainer = null;
  globalConfig = null;
  _lastSessionId = null;
  _lastResearchId = null;
  _lastRunSummary = null;
  _lastErrorReport = null;

  // Remove signal handlers — caller is shutting down cooperatively.
  _removeSignalHandlers();

  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} error(s) during SDK shutdown`);
  }
}

// ---------------------------------------------------------------------------
// Mock context (mirrors pi-coding-agent ExtensionContext)
// ---------------------------------------------------------------------------

/**
 * Create an ExtensionContext for internal services.
 * Uses the cached globalRegistry (built once at init time).
 */
function createMockContext(sessionId: string): ExtensionContext {
  return {
    cwd: globalCwd,
    config: globalConfig!,
    container: globalContainer!,
    mode: 'print' as const, // SDK defaults to print mode
    hasUI: false,           // SDK is headless
    model: globalModel!,
    modelRegistry: globalRegistry!,
    ui: {
      log: (msg: string) => logger.log(`[PI-UI] ${msg}`),
      error: (msg: string) => logger.error(`[PI-UI] ${msg}`),
      notify: (msg: string) => logger.log(`[PI-UI-NOTIFY] ${msg}`),
      showStatus: () => () => {},
      progress: () => () => {},
      // No-op widget host — kept field-compatible with the host-injected ctx so any
      // future (hasUI-gated) ctx.ui.setWidget call behaves identically on
      // headless hosts instead of throwing on the SDK path.
      setWidget: () => {},
      custom: async () => ({ type: 'cancel' }),
      confirm: async () => false,
      onTerminalInput: () => () => { return () => {}; },
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
    },
  } as any;
}

