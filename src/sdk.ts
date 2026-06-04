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
import { registerInfrastructureServices } from './infrastructure/service-initialization.ts';
import { DeepResearchOrchestrator } from './orchestration/deep-research-orchestrator.ts';
import { QuickResearchOrchestrator } from './orchestration/quick-research-orchestrator.ts';
import { HeadlessObserver, type HeadlessObserverOptions } from './orchestration/headless-observer.ts';
import { createResearchRunId, logger, createLogger, setLogger } from './logger.ts';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Model } from '@earendil-works/pi-ai';
import { ModelRegistry, AuthStorage } from '@earendil-works/pi-coding-agent';
import { getConfig, setConfig, validateConfig, type Config } from './config.ts';
import { shutdownManager } from './utils/shutdown-manager.ts';
import { resetServiceContainer, getService } from './core/service-registry.ts';
import type { ResearchDepth } from './types/index.ts';
import { ServiceNames } from './core/service-interfaces.ts';
import type { IKnowledgeStoreService } from './core/service-interfaces.ts';
import type { SchedulerService } from './core/scheduler-service.ts';
import { repairJsonWithLlm } from './utils/agentic-repair.ts';
import { completeSimple } from '@earendil-works/pi-ai';

export { repairJsonWithLlm };
export { getService, resetServiceContainer } from './core/service-registry.ts';
export { ServiceNames } from './core/service-interfaces.ts';

/**
 * SDK Initialization Options
 */
export interface SDKOptions {
  /**
   * The model to use for research coordination and synthesis.
   * Accepts either a Model object (from getModel or ModelRegistry.find) or a
   * "provider/id" string (e.g. "openrouter/deepseek/deepseek-v4-flash") which
   * is resolved from pi's configured model registry (~/.pi/agent/models.json).
   */
  model: Model<any> | string;
  /** Optional API key. When provided, takes precedence over pi's configured auth storage. */
  apiKey?: string;
  /** Current working directory for report exports (default: process.cwd()) */
  cwd?: string;
  /** Optional configuration overrides */
  config?: Partial<Config>;
  /** Whether to enable verbose logging to the console */
  verbose?: boolean;
}

/**
 * Research Execution Options
 */
export interface RunOptions {
  /** Research depth (1-3 for deep research, 0 for quick research) */
  depth?: ResearchDepth;
  /** Optional complexity override for deep research (1-3) */
  complexity?: 1 | 2 | 3;
  /** Optional observer for progress tracking */
  observer?: HeadlessObserverOptions;
  /** Abort signal to cancel research */
  signal?: AbortSignal;
}

let isInitialized = false;
let globalModel: Model<any> | null = null;
let globalApiKey: string | undefined;
let globalCwd: string = process.cwd();
// Cached ModelRegistry — built once at init, shared across all orchestrator calls.
let globalRegistry: ModelRegistry | null = null;

/**
 * Initialize the Research SDK
 */
export async function initResearchSDK(options: SDKOptions): Promise<void> {
  if (isInitialized) {
    logger.warn('[SDK] SDK is already initialized');
    return;
  }

  // Apply verbose before anything else so all subsequent log calls see it.
  if (options.verbose) {
    setLogger(createLogger({ verbose: true }));
  }

  // Apply config overrides and validate BEFORE touching any global state.
  // Save the original config so we can roll it back if validation fails.
  const originalConfig = options.config ? getConfig() : null;
  if (options.config) {
    setConfig({ ...originalConfig!, ...options.config });
  }
  try {
    validateConfig();
  } catch (err) {
    // Roll back config mutation so a corrected re-call can succeed.
    if (originalConfig) setConfig(originalConfig);
    throw err;
  }

  // Set globals only after validation has passed.
  globalApiKey = options.apiKey;
  globalCwd = options.cwd || process.cwd();

  // Parse the provider from model (string or object) before building the registry,
  // so buildModelRegistry can correctly key the explicit apiKey by provider.
  let parsedProvider: string | undefined;
  if (typeof options.model === 'string') {
    parsedProvider = options.model.split('/')[0];
  } else {
    globalModel = options.model;
    parsedProvider = options.model.provider;
  }

  // Build and cache the registry (one instance for the lifetime of this init cycle).
  globalRegistry = buildModelRegistry(parsedProvider);

  try {
    // Resolve a string "provider/id" model from the registry.
    if (typeof options.model === 'string') {
      const [provider, ...rest] = options.model.split('/');
      const modelId = rest.join('/');
      if (!provider || !modelId) {
        throw new Error(`Invalid model string "${options.model}". Expected "provider/id" e.g. "openrouter/deepseek/deepseek-v4-flash".`);
      }
      const found = globalRegistry.find(provider, modelId);
      if (!found) {
        throw new Error(`Model "${options.model}" not found in pi's configured model registry. Check ~/.pi/agent/models.json.`);
      }
      globalModel = found;
    }

    // Register and initialize services
    registerCoreServices();
    registerInfrastructureServices();

    const mockCtx = createMockContext();
    await initializeCoreServices(mockCtx);

    isInitialized = true;
    logger.log('[SDK] Research SDK initialized successfully');
  } catch (err) {
    // Roll back global state and fully reset the service container so that
    // re-calling initResearchSDK() can re-register services successfully.
    globalModel = null;
    globalApiKey = undefined;
    globalCwd = process.cwd();
    globalRegistry = null;
    try {
      await resetServiceContainer();
    } catch {
      // Best-effort cleanup; ignore secondary errors
    }
    logger.error('[SDK] Initialization failed, rolling back state:', err);
    throw err;
  }
}

/**
 * Run Deep Research (Multi-agent, Level 1-3)
 */
export async function runDeepResearch(query: string, options: RunOptions = {}): Promise<string> {
  ensureInitialized();

  const depth = options.depth ?? 1;
  // depth is ResearchDepth (0|1|2|3); depth 0 is quick-only so clamp to 1 if not explicit
  const complexity = options.complexity ?? (depth >= 1 ? (depth as 1 | 2 | 3) : 1);
  const researchId = createResearchRunId();
  const sessionId = `sdk-${randomUUID()}`;
  const observer = new HeadlessObserver(options.observer);

  const orchestrator = new DeepResearchOrchestrator({
    ctx: createMockContext() as any,
    model: globalModel!,
    query,
    complexity: Math.max(1, Math.min(3, complexity)) as 1 | 2 | 3,
    sessionId,
    researchId,
    observer,
    config: getConfig(),
  });

  return await orchestrator.run(options.signal);
}

/**
 * Run Quick Research (Single-agent, Level 0)
 * Note: Level 0 is reserved for SDK use.
 */
export async function runQuickResearch(query: string, options: RunOptions = {}): Promise<string> {
  ensureInitialized();

  const researchId = createResearchRunId();
  const sessionId = `sdk-${randomUUID()}`;
  const observer = new HeadlessObserver(options.observer);

  const orchestrator = new QuickResearchOrchestrator({
    ctx: createMockContext() as any,
    model: globalModel!,
    query,
    sessionId,
    researchId,
    observer,
    config: getConfig(),
  });

  return await orchestrator.run(options.signal);
}

/**
 * Verify if a URL exists using the browser pool (high fidelity stealth check).
 */
export async function verifyUrl(url: string): Promise<boolean> {
  ensureInitialized();
  try {
    const scheduler = await getService<SchedulerService>(ServiceNames.SCHEDULER);
    const result = await scheduler.runScrape(url);
    // If it didn't throw and returned something, it exists.
    return !!result;
  } catch {
    return false;
  }
}

/**
 * Repair malformed JSON using the SDK's global model.
 */
export async function repairJson(text: string, schema?: any): Promise<any | null> {
  ensureInitialized();
  return await repairJsonWithLlm(text, completeSimple, { apiKey: globalApiKey || '' }, {
    model: globalModel,
    schema,
    serviceName: 'SDK-Repair',
  });
}

/**
 * Dispose the Research SDK and clean up resources
 */
export async function disposeResearchSDK(): Promise<void> {
  if (!isInitialized) return;

  // Reset flags in finally so they clear even if cleanup throws.
  // Keeping isInitialized=true until finally ensures the SDK is not considered
  // "uninitialized" while mid-dispose (prevents re-init races).
  try {
    await shutdownManager.runCleanup('sdk_dispose');
    await disposeCoreServices();
    // Full container reset clears service registrations so that a subsequent
    // initResearchSDK() call can re-register without "already registered" errors.
    await resetServiceContainer();
  } finally {
    isInitialized = false;
    globalModel = null;
    globalApiKey = undefined;
    globalCwd = process.cwd();
    globalRegistry = null;
  }
  logger.log('[SDK] Research SDK disposed');
}

/**
 * Export the Knowledge Store for web use.
 * This exports high-quality summaries and their vectors to a JSON file
 * that can be consumed by a frontend application for semantic search.
 * @param outputPath - Path to save the exported JSON file
 */
export async function exportKnowledge(outputPath: string): Promise<void> {
  ensureInitialized();
  const ks = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
  await ks.exportForWeb(outputPath);
}

/**
 * Internal helper to ensure SDK is initialized
 */
function ensureInitialized() {
  if (!isInitialized) {
    throw new Error('Research SDK not initialized. Call initResearchSDK() first.');
  }
}

/**
 * Build the ModelRegistry. Called once during initResearchSDK and cached in globalRegistry.
 *
 * Priority:
 *   1. Explicit apiKey → InMemoryAuthStorage seeded with that key; caller doesn't need pi
 *   2. No explicit key → reads ~/.pi/agent/models.json so all user-configured providers work
 *
 * @param provider - The model's provider string, used to key the explicit apiKey correctly.
 */
function buildModelRegistry(provider?: string): ModelRegistry {
  const agentDir = path.join(os.homedir(), '.pi', 'agent');
  const modelsJsonPath = path.join(agentDir, 'models.json');

  if (globalApiKey) {
    // Explicit key: seed InMemory storage under the correct provider name.
    const authStorage = AuthStorage.inMemory({
      [provider ?? 'unknown']: { type: 'api_key', key: globalApiKey },
    });
    return ModelRegistry.create(authStorage, modelsJsonPath);
  }

  // No explicit key: use the user's pi auth storage and model list
  const authStorage = AuthStorage.create(path.join(agentDir, 'auth.json'));
  return ModelRegistry.create(authStorage, modelsJsonPath);
}

/**
 * Create an ExtensionContext for internal services.
 * Uses the cached globalRegistry (built once at init time).
 */
function createMockContext() {
  return {
    cwd: globalCwd,
    model: globalModel,
    modelRegistry: globalRegistry!,
    ui: {
      notify: () => {},
      setWidget: () => {},
      custom: async () => ({ type: 'cancel' }),
      confirm: async () => false,
      onTerminalInput: () => () => {},
    },
    sessionManager: {
      getSessionId: () => 'sdk-session',
      getBranch: () => [],
    },
  };
}
