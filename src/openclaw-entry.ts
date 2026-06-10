/**
 * OpenClaw Plugin Entry Point
 *
 * Provides pi-research as an OpenClaw-compatible tool plugin.
 * Uses the same SDK-style initialization pattern as src/sdk.ts — creates
 * a mock ExtensionContext, initializes services, and delegates to the
 * existing QuickResearchOrchestrator / DeepResearchOrchestrator.
 *
 * Depth routing (matches pi-research's internal ResearchOrchestrationService):
 *   0 → QuickResearchOrchestrator  (single researcher, fast)
 *   1 → DeepResearchOrchestrator(complexity=1)
 *   2 → DeepResearchOrchestrator(complexity=2)
 *   3 → DeepResearchOrchestrator(complexity=3)
 *
 * IMPORTANT: The internal config field DEFAULT_RESEARCH_DEPTH has minimum: 1,
 * so `defaultDepth` is NOT mapped to it. Instead, it's stored as a plugin-level
 * default used only at execution time in the research tool's execute function.
 * This allows depth 0 (quick research) as a valid default in OpenClaw.
 *
 * @see docs/OPENCLAW-INTEGRATION-PLAN.md
 */

import type { Model } from '@earendil-works/pi-ai';
import { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { buildModelRegistry, resolveModel } from './utils/model-registry-factory.ts';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';

// pi-research internals (same imports used by sdk.ts)
import { registerCoreServices, initializeCoreServices } from './core/service-initialization.ts';
import { registerInfrastructureServices } from './infrastructure/service-initialization.ts';
import { DeepResearchOrchestrator, type DeepResearchOrchestratorOptions } from './orchestration/deep-research-orchestrator.ts';
import { QuickResearchOrchestrator, type QuickResearchOrchestratorOptions } from './orchestration/quick-research-orchestrator.ts';
import { HeadlessObserver } from './orchestration/headless-observer.ts';
import { createResearchRunId, logger } from './logger.ts';
import { exportResearchReport, appendExportMessage } from './utils/research-export.ts';
import { getConfig, setConfig, validateConfig, type Config } from './config.ts';
import { resetServiceContainer, getServiceContainer } from './core/service-registry.ts';
import { disposeCoreServices } from './core/service-initialization.ts';
import { shutdownManager } from './utils/shutdown-manager.ts';
import { healthRegistry } from './healthcheck/index.ts';
import { metrics } from './utils/metrics.ts';

// ---------------------------------------------------------------------------
// Config schema — mirrors openclaw.plugin.json configSchema
// ---------------------------------------------------------------------------

const OpenClawConfigSchema = Type.Object({
  apiKey: Type.Optional(Type.String({ description: 'LLM API key' })),
  provider: Type.Optional(Type.String({ description: 'LLM provider name' })),
  model: Type.Optional(Type.String({ description: 'Model ID override for researcher sub-agents' })),
  timeoutMs: Type.Optional(Type.Number({ minimum: 180000, maximum: 1800000, default: 300000 })),
  maxResearchers: Type.Optional(Type.Number({ minimum: 1, maximum: 5, default: 3 })),
  defaultDepth: Type.Optional(Type.Number({ minimum: 0, maximum: 3, default: 1 })),
  maxScrapeBatches: Type.Optional(Type.Number({ minimum: 0, maximum: 99, default: 2 })),
  maxConcurrentScrapes: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 3 })),
  workerThreads: Type.Optional(Type.Number({ minimum: 1, maximum: 10, default: 4 })),
  workerConcurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 10, default: 2 })),
  knowledgeEnabled: Type.Optional(Type.Boolean({ default: true })),
  embeddingModel: Type.Optional(Type.String({ default: 'Xenova/all-MiniLM-L6-v2' })),
  embeddingDevice: Type.Optional(Type.Union([Type.Literal('webgpu'), Type.Literal('cpu')], { default: 'webgpu' })),
  cacheTtlDays: Type.Optional(Type.Number({ minimum: 1, maximum: 365, default: 30 })),
  scrapeTimeoutMs: Type.Optional(Type.Number({ minimum: 5000, maximum: 120000, default: 15000 })),
  searxngUrl: Type.Optional(Type.String()),
  reportExportEnabled: Type.Optional(Type.Boolean({ default: false })),
});

type OpenClawPluginConfig = {
  apiKey?: string;
  provider?: string;
  model?: string;
  timeoutMs?: number;
  maxResearchers?: number;
  defaultDepth?: number;
  maxScrapeBatches?: number;
  maxConcurrentScrapes?: number;
  workerThreads?: number;
  workerConcurrency?: number;
  knowledgeEnabled?: boolean;
  embeddingModel?: string;
  embeddingDevice?: 'webgpu' | 'cpu';
  cacheTtlDays?: number;
  scrapeTimeoutMs?: number;
  searxngUrl?: string;
  reportExportEnabled?: boolean;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let initialized = false;
let globalModel: Model<any> | null = null;
let globalRegistry: ModelRegistry | null = null;
let globalDefaultDepth: number = 1;
let globalCwd: string = process.cwd();
// FIX (#14): Track the initialization promise to prevent concurrent init
let _initPromise: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Config mapping: OpenClaw config → pi-research Config
//
// IMPORTANT: `defaultDepth` is NOT mapped to DEFAULT_RESEARCH_DEPTH because
// the internal config schema requires minimum: 1. Depth 0 (quick research)
// is an orchestration-level concept that only applies at execution time.
// Instead, defaultDepth is stored separately and used in the research tool.
// ---------------------------------------------------------------------------

function applyOpenClawConfig(pluginConfig: OpenClawPluginConfig): void {
  const overrides: Partial<Config> = {};

  if (pluginConfig.timeoutMs !== undefined) overrides.RESEARCHER_TIMEOUT_MS = pluginConfig.timeoutMs;
  if (pluginConfig.maxResearchers !== undefined) overrides.MAX_CONCURRENT_RESEARCHERS = pluginConfig.maxResearchers;
  // NOTE: defaultDepth is NOT mapped here — see comment block above
  if (pluginConfig.maxScrapeBatches !== undefined) overrides.MAX_SCRAPE_BATCHES = pluginConfig.maxScrapeBatches;
  if (pluginConfig.maxConcurrentScrapes !== undefined) overrides.MAX_CONCURRENT_SCRAPES = pluginConfig.maxConcurrentScrapes;
  if (pluginConfig.workerThreads !== undefined) overrides.WORKER_THREADS = pluginConfig.workerThreads;
  if (pluginConfig.workerConcurrency !== undefined) overrides.WORKER_CONCURRENCY = pluginConfig.workerConcurrency;
  if (pluginConfig.knowledgeEnabled !== undefined) {
    overrides.GLOBAL_KNOWLEDGE_STORE_ENABLED = pluginConfig.knowledgeEnabled;
    overrides.LOCAL_KNOWLEDGE_STORE_ENABLED = pluginConfig.knowledgeEnabled;
  }
  if (pluginConfig.embeddingModel !== undefined) overrides.EMBEDDING_MODEL = pluginConfig.embeddingModel;
  if (pluginConfig.embeddingDevice !== undefined) overrides.EMBEDDING_DEVICE = pluginConfig.embeddingDevice;
  if (pluginConfig.cacheTtlDays !== undefined) overrides.KNOWLEDGE_STORE_CACHE_TTL_DAYS = pluginConfig.cacheTtlDays;
  if (pluginConfig.scrapeTimeoutMs !== undefined) overrides.SCRAPE_TIMEOUT_MS = pluginConfig.scrapeTimeoutMs;
  if (pluginConfig.model !== undefined) overrides.RESEARCH_MODEL = pluginConfig.model;
  if (pluginConfig.reportExportEnabled !== undefined) overrides.RESEARCH_REPORT_EXPORT_ENABLED = pluginConfig.reportExportEnabled;

  // SearXNG URL → env var (pi-research reads SEARXNG_URL from process.env)
  if (pluginConfig.searxngUrl) {
    process.env['SEARXNG_URL'] = pluginConfig.searxngUrl;
  }

  // Store the plugin-level default depth (0-3 valid, NOT passed to internal config)
  if (pluginConfig.defaultDepth !== undefined) {
    globalDefaultDepth = Math.max(0, Math.min(3, Math.round(pluginConfig.defaultDepth)));
  }

  if (Object.keys(overrides).length > 0) {
    setConfig(overrides);
  }
}

// ---------------------------------------------------------------------------
// Mock context (mirrors sdk.ts createMockContext with additional stub fields)
// ---------------------------------------------------------------------------

function createMockContext(model: Model<any>, registry: ModelRegistry): any {
  return {
    cwd: globalCwd,
    mode: 'print' as const,
    hasUI: false,
    model,
    modelRegistry: registry,
    getContextUsage: () => undefined,
    getSystemPrompt: () => '',
    getSignal: () => undefined,
    compact: () => {},
    abort: () => {},
    shutdown: () => {},
    getSystemPromptOptions: () => ({ selectedTools: ['research', 'health'] }),
    ui: {
      notify: () => {},
      setWidget: () => {},
      setStatus: () => {},
      custom: async () => ({ type: 'cancel' as const }),
      confirm: async () => false,
      input: async () => '',
      select: async () => undefined,
      onTerminalInput: () => (() => {}),
      setHiddenThinkingLabel: () => {},
    },
    sessionManager: {
      getSessionId: () => 'openclaw-session',
      getSessionFile: () => undefined,
      getBranch: () => [],
    },
    signal: undefined,
    isIdle: () => true,
  };
}

// ---------------------------------------------------------------------------
// Initialization (lazy, same as SDK)
// ---------------------------------------------------------------------------

async function ensureInitialized(pluginConfig: OpenClawPluginConfig): Promise<void> {
  if (initialized) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      // Apply config overrides BEFORE validation.
      // defaultDepth is stored as a plugin-level setting, NOT passed to internal config.
      applyOpenClawConfig(pluginConfig);
      const config = getConfig();
      validateConfig(config);

      // Build model registry
      globalRegistry = buildModelRegistry(pluginConfig.apiKey, pluginConfig.provider);

      // Resolve model
      globalModel = resolveModel(globalRegistry, pluginConfig.model, pluginConfig.provider);

      // Register and initialize services (same sequence as SDK)
      registerCoreServices();
      registerInfrastructureServices();

      const mockCtx = createMockContext(globalModel, globalRegistry);
      const result = await initializeCoreServices(mockCtx);
      if (result.failed.length === 0) {
        getServiceContainer().isReady = true;
        logger.log('[OpenClaw] pi-research initialized successfully');
      } else {
        logger.error(`[OpenClaw] pi-research initialization incomplete: ${result.failed.join(', ')}`);
      }

      initialized = true;
    } catch (err) {
      // Roll back global state so re-calling works
      globalModel = null;
      globalRegistry = null;
      globalDefaultDepth = 1;
      globalCwd = process.cwd();
      try { await resetServiceContainer(); } catch { /* best-effort */ }
      logger.error('[OpenClaw] pi-research initialization failed:', err);
      throw err;
    } finally {
      _initPromise = null;
    }
  })();

  return _initPromise;
}

/**
 * FIX (#14): Shutdown function to clean up services when the plugin is unloaded.
 * Disposes all initialized services to prevent resource leaks.
 */
export async function shutdown(): Promise<void> {
  if (!initialized) return;
  try {
    await shutdownManager.runCleanup('openclaw_shutdown');
    await disposeCoreServices();
    await resetServiceContainer();
  } finally {
    initialized = false;
    globalModel = null;
    globalRegistry = null;
  }
  logger.log('[OpenClaw] pi-research shutdown complete');
}

// ---------------------------------------------------------------------------
// Health check formatting
// ---------------------------------------------------------------------------

function formatHealthResult(systemHealth: any, verbose: boolean): string {
  const lines: string[] = [];

  lines.push('## System Health Status\n');

  const statusIcon = systemHealth.status === 'healthy' ? '[OK]' :
                     systemHealth.status === 'degraded' ? '[WARN]' : '[ERROR]';
  const statusText = systemHealth.status === 'healthy' ? 'All systems operational' :
                     systemHealth.status === 'degraded' ? 'System degraded (non-critical issues)' :
                     'System unhealthy (critical failures)';

  lines.push(`**${statusIcon} ${statusText}**\n`);

  for (const component of systemHealth.components) {
    const icon = component.healthy ? '[OK]' : '[FAIL]';
    lines.push(`${icon} **${component.component}**`);
    if (component.error) lines.push(`  - Error: ${component.error}`);
    if (verbose && component.diagnostic) {
      const diagnostics = Object.entries(component.diagnostic)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      if (diagnostics) lines.push(`  - Diagnostic: ${diagnostics}`);
    }
    if (verbose) lines.push(`  - Duration: ${component.durationMs.toFixed(1)}ms`);
  }

  lines.push(`\nChecked at: ${new Date(systemHealth.timestamp).toLocaleString()}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export default {
  id: 'pi-research',
  name: 'Pi Research',
  description: 'Multi-agent web research with stealth browser, security databases, and Stack Exchange integration.',
  configSchema: OpenClawConfigSchema,

  tools: [
    {
      name: 'research',
      label: 'Research',
      description:
        'Perform web/internet research using an internal multi-source system. ' +
        'Synthesizes findings from web search, scraping, security databases, and Stack Exchange.',
      parameters: Type.Object({
        query: Type.String({ description: 'Research query or topic to investigate' }),
        depth: Type.Optional(Type.Integer({
          minimum: 0,
          maximum: 3,
          default: 1,
          description: 'Research complexity. 0=quick (single researcher, fast), 1=normal (2 researchers, 2 rounds), 2=deep (3 researchers, 3 rounds), 3=ultra (5 researchers, 5 rounds).',
        })),
        excludeTools: Type.Optional(Type.Array(Type.String(), {
          description: 'List of internal research tools to disable (e.g., search, scrape, grep, security, stackexchange). Defaults to ["grep", "read"].',
        })),
      }),

      async execute(
        params: { query: string; depth?: number; excludeTools?: string[] },
        config: OpenClawPluginConfig,
        context: { signal?: AbortSignal },
      ): Promise<string> {
        await ensureInitialized(config);

        const query = params.query?.trim();
        if (!query) {
          return 'Error: Research query is required.';
        }

        // Depth resolution: param > plugin config default > hardcoded default of 1
        const depth = params.depth ?? globalDefaultDepth;
        // Default exclusion: grep and read are pi developer tools not useful for web research in OpenClaw
        const excludeTools = params.excludeTools ?? ['grep', 'read'];
        const signal = context.signal;

        const researchId = createResearchRunId();
        const sessionId = `openclaw-${randomUUID()}`;
        const mockCtx = createMockContext(globalModel!, globalRegistry!);
        const observer = new HeadlessObserver({ enableLogging: true });

        const researchStart = Date.now();

        try {
          let result: string;

          if (depth === 0) {
            // Quick research — single researcher, one search burst
            const orchestrator = new QuickResearchOrchestrator({
              ctx: mockCtx,
              model: globalModel!,
              query,
              sessionId,
              researchId,
              observer,
              config: getConfig(),
              excludeTools,
            } satisfies QuickResearchOrchestratorOptions);
            result = await orchestrator.run(signal);
          } else {
            // Deep research — multi-round, multi-researcher
            const complexity = Math.max(1, Math.min(3, depth)) as 1 | 2 | 3;
            const orchestrator = new DeepResearchOrchestrator({
              ctx: mockCtx,
              model: globalModel!,
              query,
              complexity,
              sessionId,
              researchId,
              observer,
              config: getConfig(),
              excludeTools,
            } satisfies DeepResearchOrchestratorOptions);
            result = await orchestrator.run(signal);
          }

          if (getConfig().RESEARCH_REPORT_EXPORT_ENABLED) {
            const exportPath = await exportResearchReport(query, result, (depth ?? 0) === 0 ? 'quick' : 'deep', globalCwd);
            if (exportPath) {
              result = appendExportMessage(result, exportPath);
            }
          }

          metrics.observe('research_manager_latency_ms', Date.now() - researchStart, {
            depth: String(depth), status: 'success', source: 'openclaw',
          });
          metrics.increment('research_manager_requests_total', 1, {
            depth: String(depth), status: 'success', source: 'openclaw',
          });

          return result;
        } catch (error) {
          metrics.observe('research_manager_latency_ms', Date.now() - researchStart, {
            depth: String(depth), status: 'error', source: 'openclaw',
          });
          metrics.increment('research_manager_requests_total', 1, {
            depth: String(depth), status: 'error', source: 'openclaw',
          });

          const message = error instanceof Error ? error.message : String(error);
          logger.error(`[OpenClaw] Research failed: ${message}`);
          return `Research failed: ${message}`;
        }
      },
    },

    {
      name: 'health',
      label: 'Health Check',
      description: 'Check system health status across all research components (browser pool, knowledge store, GPU lock).',
      parameters: Type.Object({
        verbose: Type.Optional(Type.Boolean({
          description: 'Show detailed diagnostic information for each component',
          default: true,
        })),
        probe: Type.Optional(Type.Boolean({
          description: 'Force liveness checks (spawns browser, loads GPU models)',
          default: false,
        })),
      }),

      async execute(
        params: { verbose?: boolean; probe?: boolean },
        config: OpenClawPluginConfig,
        _context: { signal?: AbortSignal },
      ): Promise<string> {
        await ensureInitialized(config);

        const { verbose = true, probe = false } = params;

        try {
          const systemHealth = await healthRegistry.runAll({ force: probe });
          return formatHealthResult(systemHealth, verbose);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return `**Health check failed**\n\n${message}`;
        }
      },
    },
  ],
};
