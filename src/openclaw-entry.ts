/**
 * OpenClaw Plugin Entry Point
 *
 * Provides pi-research as an OpenClaw-compatible tool plugin.
 * Uses the same SDK-style initialization pattern as src/sdk.ts — creates
 * a mock ExtensionContext, initializes services, and delegates to the
 * existing QuickResearchOrchestrator / DeepResearchOrchestrator.
 */

import type { Model } from '@earendil-works/pi-ai';
import { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { buildModelRegistry, resolveModel } from './core/llm/model-registry-factory.ts';
import { Type } from 'typebox';
import type { Static } from 'typebox';
import { randomUUID } from 'node:crypto';

// pi-research internals
import { registerCoreServices, initializeCoreServices, disposeCoreServices } from './core/service-initialization.ts';
import { registerInfrastructureServices, shutdownInfrastructureServices } from './infrastructure/service-initialization.ts';
import { registerOrchestrationServices } from './orchestration/service-initialization.ts';
import { resetServiceContainer, getService, getServiceContainer } from './core/service-registry.ts';
import type { ServiceContainer } from './core/service-registry.ts';
import { ServiceNames } from './core/service-interfaces.ts';
import { DeepResearchOrchestrator, type DeepResearchOrchestratorOptions } from './orchestration/deep-research-orchestrator.ts';
import { QuickResearchOrchestrator, type QuickResearchOrchestratorOptions } from './orchestration/quick-research-orchestrator.ts';
import { exportResearchReport } from './utils/research-export.ts';
import { HeadlessObserver } from './orchestration/headless-observer.ts';
import { createResearchKnowledgeSearchTool } from './tools/research-knowledge-search.ts';
import { createResearchRunId, logger } from './logger.ts';
import { getConfig, type Config } from './config.ts';
import { shutdownManager } from './utils/shutdown-manager.ts';
import { healthRegistry } from './healthcheck/index.ts';
import { metrics } from './utils/metrics.ts';
import { clearAllSessionState } from './orchestration/session/session-state.ts';

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

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
  embeddingModel: Type.Optional(Type.String({ description: 'Embedding model (defaults to user config)' })),
  embeddingDevice: Type.Optional(Type.Union([Type.Literal('webgpu'), Type.Literal('cpu')], { default: 'webgpu' })),
  migrationStrategy: Type.Optional(Type.Union([Type.Literal('drop'), Type.Literal('re-embed'), Type.Literal('backup')], { default: 'backup' })),
  thinkingLevel: Type.Optional(Type.Union([Type.Literal('off'), Type.Literal('minimal'), Type.Literal('high')], { default: 'minimal' })),
  cacheTtlDays: Type.Optional(Type.Number({ minimum: 1, maximum: 365, default: 30 })),
  scrapeTimeoutMs: Type.Optional(Type.Number({ minimum: 5000, maximum: 120000, default: 15000 })),
  stackexchangeApiKey: Type.Optional(Type.String({ description: 'Stack Exchange API key for higher rate limits' })),
  reportExportEnabled: Type.Optional(Type.Boolean({ default: false })),
});

type OpenClawPluginConfig = Static<typeof OpenClawConfigSchema>;

// ---------------------------------------------------------------------------
// Lazy initialization state
// ---------------------------------------------------------------------------

let isInitialized = false;
let globalContainer: ServiceContainer | null = null;
let globalRegistry: ModelRegistry | null = null;
let globalModel: Model<any> | null = null;
let globalConfig: Config | null = null;
let globalDefaultDepth = 1;
let _headlessObserver: HeadlessObserver | null = null;

async function ensureInitialized(pluginConfig: OpenClawPluginConfig) {
  if (isInitialized) return;

  const cwd = process.cwd();
  globalConfig = getConfig(cwd);

  // Map OpenClaw config to pi-research Config
  if (pluginConfig.timeoutMs !== undefined) globalConfig.RESEARCHER_TIMEOUT_MS = pluginConfig.timeoutMs;
  if (pluginConfig.maxResearchers !== undefined) globalConfig.MAX_CONCURRENT_RESEARCHERS = pluginConfig.maxResearchers;
  if (pluginConfig.maxScrapeBatches !== undefined) globalConfig.MAX_SCRAPE_BATCHES = pluginConfig.maxScrapeBatches;
  if (pluginConfig.maxConcurrentScrapes !== undefined) globalConfig.MAX_CONCURRENT_SCRAPES = pluginConfig.maxConcurrentScrapes;
  if (pluginConfig.workerThreads !== undefined) globalConfig.WORKER_THREADS = pluginConfig.workerThreads;
  if (pluginConfig.workerConcurrency !== undefined) globalConfig.WORKER_CONCURRENCY = pluginConfig.workerConcurrency;
  if (pluginConfig.embeddingModel !== undefined) globalConfig.EMBEDDING_MODEL = pluginConfig.embeddingModel;
  if (pluginConfig.embeddingDevice !== undefined) globalConfig.EMBEDDING_DEVICE = pluginConfig.embeddingDevice;
  if (pluginConfig.migrationStrategy !== undefined) globalConfig.MIGRATION_STRATEGY = pluginConfig.migrationStrategy;
  if (pluginConfig.thinkingLevel !== undefined) globalConfig.THINKING_LEVEL = pluginConfig.thinkingLevel;
  if (pluginConfig.cacheTtlDays !== undefined) globalConfig.KNOWLEDGE_STORE_CACHE_TTL_DAYS = pluginConfig.cacheTtlDays;
  if (pluginConfig.scrapeTimeoutMs !== undefined) globalConfig.SCRAPE_TIMEOUT_MS = pluginConfig.scrapeTimeoutMs;
  if (pluginConfig.model !== undefined) globalConfig.RESEARCH_MODEL = pluginConfig.model;
  if (pluginConfig.reportExportEnabled !== undefined) globalConfig.RESEARCH_REPORT_EXPORT_ENABLED = pluginConfig.reportExportEnabled;

  if (pluginConfig.knowledgeEnabled !== undefined) {
    globalConfig.KNOWLEDGE_STORE_MODE = pluginConfig.knowledgeEnabled ? 'global' : 'none';
  }
  
  if (pluginConfig.defaultDepth !== undefined) {
    globalDefaultDepth = pluginConfig.defaultDepth;
  }

  // Resolve model registry & model
  globalRegistry = await buildModelRegistry(pluginConfig.apiKey, pluginConfig.provider);
  globalModel = resolveModel(
    globalRegistry,
    pluginConfig.model,
    pluginConfig.provider,
    pluginConfig.apiKey
  );

  // Create and initialize services
  globalContainer = getServiceContainer();
  registerInfrastructureServices(globalContainer);
  registerCoreServices(globalContainer);
  registerOrchestrationServices(globalContainer);

  const mockCtx = createMockContext(globalModel!, globalRegistry!);
  await initializeCoreServices(mockCtx, globalContainer);

  isInitialized = true;
}

async function shutdown() {
  if (!isInitialized) return;
  
  try {
    await shutdownManager.runCleanup('OpenClaw shutdown');
    await shutdownInfrastructureServices(globalContainer!);
    await disposeCoreServices(globalContainer!);
    await resetServiceContainer(globalContainer!);
    clearAllSessionState();
  } catch (err) {
    logger.error('[OpenClaw] Shutdown error:', err);
  } finally {
    isInitialized = false;
    globalContainer = null;
    globalRegistry = null;
    globalModel = null;
    globalConfig = null;
  }
}

function createMockContext(model: Model<any>, registry: ModelRegistry) {
  const sessionId = `openclaw-${randomUUID()}`;
  return {
    cwd: process.cwd(),
    mode: 'print',
    hasUI: false,
    model,
    modelRegistry: registry,
    sessionId,
    container: globalContainer,
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

// ── Plugin Registration ───────────────────────────────────────────────────

export default definePluginEntry({
  id: 'pi-research',
  name: 'Pi Research',
  description: 'Multi-agent web research with stealth browser, security databases, and Stack Exchange integration.',
  configSchema: OpenClawConfigSchema as any,

  async register(api) {
    // 1. Lifecycle
    api.registerRuntimeLifecycle({
      id: 'pi-research-lifecycle',
      description: 'Cleans up research sub-agents, browser processes, and knowledge store connections.',
      cleanup: async () => {
        logger.info('[OpenClaw] Shutdown signal received via lifecycle hook.');
        await shutdown();
      },
    });

    // 2. Tools
    api.registerTool({
      name: 'research',
      label: 'Research',
      description: 'Perform multi-source web research using search, scraping, and specialized databases.',
      parameters: Type.Object({
        query: Type.Optional(Type.String({
          description: 'The research topic or query to investigate.',
        })),
        depth: Type.Optional(Type.Integer({
          minimum: 0,
          maximum: 3,
          description: 'Research complexity. 0=quick, 1=normal, 2=deep, 3=ultra.',
        })),
        excludeTools: Type.Optional(Type.Array(Type.String(), {
          description: 'List of internal research tools to disable. Defaults to ["grep", "read"].',
        })),
        initialLinks: Type.Optional(Type.Array(Type.String(), {
          description: 'Optional seed URLs to investigate before (or instead of) web search.',
        })),
      }),

      async execute(_toolCallId, params: any, signal) {
        const config = (api as any).pluginConfig ?? {};
        await ensureInitialized(config);

        const query = params.query?.trim();
        if (!query && (!params.initialLinks || params.initialLinks.length === 0)) {
           throw new Error('Research query or initialLinks are required.');
        }

        const depth = params.depth ?? globalDefaultDepth;
        const excludeTools = params.excludeTools ?? ['grep', 'read'];
        const initialLinks = params.initialLinks;
        const researchId = createResearchRunId();
        const piSessionId = `openclaw-${randomUUID()}`;
        const mockCtx = createMockContext(globalModel!, globalRegistry!);
        const observer = _headlessObserver ??= new HeadlessObserver({ enableLogging: true });

        const researchStart = Date.now();

        try {
          let result: string;
          if (depth === 0) {
            const orchestrator = new QuickResearchOrchestrator({
              ctx: mockCtx,
              model: globalModel!,
              query: query || (initialLinks?.[0] ?? 'Initial Links Research'),
              sessionId: piSessionId,
              researchId,
              observer,
              config: globalConfig!,
              excludeTools,
              initialLinks,
            } satisfies QuickResearchOrchestratorOptions);
            result = await orchestrator.run(signal);
          } else {
            const complexity = Math.max(1, Math.min(3, depth)) as 1 | 2 | 3;
            const orchService = await getService<any>(ServiceNames.RESEARCH_ORCHESTRATION, mockCtx, globalContainer!);
            const orchestrator = new DeepResearchOrchestrator({
              ctx: mockCtx,
              model: globalModel!,
              query: query || (initialLinks?.[0] ?? 'Initial Links Research'),
              complexity,
              sessionId: piSessionId,
              researchId,
              observer,
              config: globalConfig!,
              excludeTools,
              orchestrationService: orchService,
              initialLinks,
            } satisfies DeepResearchOrchestratorOptions);
            result = await orchestrator.run(signal);
          }

          metrics.observe('research_manager_latency_ms', Date.now() - researchStart, {
            depth: String(depth), status: 'success', source: 'openclaw',
          });
          
          if (config.reportExportEnabled) {
            const exportPath = config.reportExportPath || process.cwd();
            const filename = await exportResearchReport(result, query || (initialLinks?.[0] ?? 'Research'), exportPath);
            result += `\n\nResearch report saved to ${filename}`;
          }

          return { content: [{ type: 'text', text: result }], details: {} };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`[OpenClaw] Research failed: ${message}`);
          throw error;
        }
      },
    });

    api.registerTool({
      name: 'health',
      label: 'Health Check',
      description: 'Check system health status across all research components.',
      parameters: Type.Object({
        verbose: Type.Optional(Type.Boolean({ default: true })),
        probe: Type.Optional(Type.Boolean({ default: false })),
      }),
      async execute(_toolCallId, params: any) {
        const config = (api as any).pluginConfig ?? {};
        await ensureInitialized(config);
        const { probe = false } = params;
        const systemHealth = await healthRegistry.runAll({ force: probe });
        return { content: [{ type: 'text', text: JSON.stringify(systemHealth, null, 2) }], details: {} };
      }
    });

    api.registerTool({
      name: 'research_knowledge_search',
      label: 'Research Knowledge Search',
      description: 'Search the research knowledge database for previously researched information.',
      parameters: Type.Object({
        queries: Type.Array(Type.String(), { minItems: 1, maxItems: 5 }),
      }),
      async execute(toolCallId, params, signal) {
        const config = (api as any).pluginConfig ?? {};
        await ensureInitialized(config);
        const mockCtx = createMockContext(globalModel!, globalRegistry!);
        const tool = createResearchKnowledgeSearchTool();
        const result = await tool.execute(toolCallId, params, signal, undefined, mockCtx);
        return { ...result, details: {} };
      }
    });
  },
});
