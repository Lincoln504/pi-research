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
  initializeInfrastructureServices,
  shutdownInfrastructureServices
} from './infrastructure/service-initialization.ts';
import { getService, resetServiceContainer, createServiceContainer } from './core/service-registry.ts';
import type { ServiceContainer } from './core/service-registry.ts';
import { ServiceNames } from './core/service-interfaces.ts';
import type { 
  IResearchOrchestration, 
  IResearchSynthesisService,
  ResearchOptions 
} from './core/interfaces/orchestration-interfaces.ts';
import type { Model } from '@earendil-works/pi-ai';
import { type ExtensionContext, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { logger, createLogger, setLogger } from './logger.ts';
import { getConfig, validateConfig, type Config } from './config.ts';
import { metrics } from './utils/metrics.ts';
import { buildModelRegistry as sharedBuildModelRegistry, resolveModel } from './utils/model-registry-factory.ts';
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

// Signal handler state — registered once, removed on clean shutdown.
let _onSigint: (() => void) | null = null;
let _onSigterm: (() => void) | null = null;
let _shuttingDown = false;

function _registerSignalHandlers(): void {
  if (_onSigint) return; // already registered

  const handler = (signal: string) => {
    if (_shuttingDown) return;
    _shuttingDown = true;
    logger.warn(`[SDK] Received ${signal} — shutting down gracefully...`);
    // Fire-and-forget shutdown; force-exit after a hard deadline.
    shutdownResearchSDK().catch(err => logger.error('[SDK] Signal shutdown error:', err));
    setTimeout(() => {
      logger.error(`[SDK] Forced exit after ${signal} (shutdown timed out)`);
      process.exit(1);
    }, 15000).unref();
  };

  _onSigint = () => handler('SIGINT');
  _onSigterm = () => handler('SIGTERM');
  process.on('SIGINT', _onSigint);
  process.on('SIGTERM', _onSigterm);
}

function _removeSignalHandlers(): void {
  if (_onSigint) process.removeListener('SIGINT', _onSigint);
  if (_onSigterm) process.removeListener('SIGTERM', _onSigterm);
  _onSigint = null;
  _onSigterm = null;
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
   * Override default configuration values.
   */
  config?: Partial<Config>;

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
 * Internal initializer — ensures services are registered and ready.
 * Supports re-initialization if the working directory (cwd) changes.
 */
async function _doInit(options: ResearchSDKOptions = {}): Promise<void> {
  const newCwd = options.cwd ? options.cwd : process.cwd();

  if (isInitialized) {
    if (newCwd === globalCwd && !options.config && !options.model) {
      logger.debug('[SDK] SDK already initialized for this directory.');
      return;
    }
    logger.info('[SDK] Re-initializing SDK for new context...');
    await shutdownResearchSDK();
  }

  globalCwd = newCwd;

  // Verbose logging setup
  if (options.verbose) {
    setLogger(createLogger({ verbose: true }));
  }

  // Seed configuration
  globalConfig = { ...getConfig(globalCwd) };
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

    // Create isolated container
    globalContainer = createServiceContainer();

    // Register and initialize services
    registerCoreServices(globalContainer);
    registerInfrastructureServices(globalContainer);

    const mockCtx = createMockContext('init-session');
    const initResult = await Promise.all([
      initializeCoreServices(mockCtx, globalContainer),
      initializeInfrastructureServices(mockCtx, globalContainer)
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
    // Cleanup on failure
    await shutdownResearchSDK();
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

/**
 * Run a "Deep" research task (multi-round, multi-agent).
 *
 * @param query - The research objective
 * @param options - Research configuration (depth, complexity, observer)
 * @param signal - Optional abort signal
 * @returns The final synthesized research report (Markdown)
 */
export async function runDeepResearch(
  query: string, 
  options: Omit<ResearchOptions, 'ctx' | 'query' | 'model' | 'sessionId' | 'researchId'> = {},
  signal?: AbortSignal
): Promise<string> {
  if (!isInitialized || !globalContainer) throw new Error('SDK not initialized. Call initResearchSDK() first.');

  const researchId = `sdk-${Date.now()}`;
  const sessionId = randomUUID();
  const orchestrator = await getService<IResearchOrchestration>(ServiceNames.RESEARCH_ORCHESTRATION, undefined, globalContainer);
  
  const researchStart = Date.now();
  const depth = options.depth ?? 1;
  const depthLabel = depth === 0 ? 'quick' : `deep-${depth}`;
  const complexity = Math.max(1, Math.min(3, options.complexity ?? 1));

  try {
    let result = await orchestrator.runResearch({
      ...options,
      ctx: createMockContext(sessionId),
      query,
      model: globalModel!,
      sessionId,
      researchId,
      depth: depth as ResearchDepth,
      complexity: complexity as 1 | 2 | 3,
    }, signal ?? options.signal);

    // Append research metadata (model used) at the very end
    const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, undefined, globalContainer);
    result = synthesisService.appendMetadata(result, globalModel!.id);

    metrics.observe('research_manager_latency_ms', Date.now() - researchStart, { depth: depthLabel, status: 'success', source: 'sdk' });
    return result;
  } catch (err) {
    metrics.observe('research_manager_latency_ms', Date.now() - researchStart, { depth: depthLabel, status: 'error', source: 'sdk' });
    throw err;
  }
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
 * Retrieve all researcher reports gathered during a specific research ID.
 */
export async function getResearchReports(researchId: string): Promise<Map<string, string>> {
  if (!globalContainer) throw new Error('SDK not initialized');
  const synthesis = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, undefined, globalContainer);
  return synthesis.getAllReports(researchId);
}

import { clearAllSessionState } from './utils/session-state.ts';
import { shutdownManager } from './utils/shutdown-manager.ts';

/**
 * Shutdown the SDK and cleanup all background processes and resources.
 */
export async function shutdownResearchSDK(): Promise<void> {
  if (!isInitialized && !_initPromise && !globalContainer) {
    return;
  }

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
    metrics.clear();
  } catch (err) {
    logger.error('[SDK] Error clearing session state:', err);
    errors.push(err instanceof Error ? err : new Error(String(err)));
  }

  if (globalContainer) {
    // Shutdown infra first (browser pool, embedding server, etc.)
    try {
      await shutdownInfrastructureServices(globalContainer);
    } catch (err) {
      logger.error('[SDK] Error shutting down infrastructure services:', err);
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }

    // Dispose core services (orchestrators, planning, synthesis, etc.)
    try {
      await disposeCoreServices(globalContainer);
    } catch (err) {
      logger.error('[SDK] Error disposing core services:', err);
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }

    // Reset the container (clears registrations, resets lifecycle)
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
  globalRegistry = null;
  globalModel = null;
  globalCwd = process.cwd();
  globalContainer = null;
  globalConfig = null;

  // Remove signal handlers — caller is shutting down cooperatively.
  _removeSignalHandlers();

  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} error(s) during SDK shutdown`);
  }
}

/** @deprecated Use shutdownResearchSDK */
export const disposeResearchSDK = shutdownResearchSDK;

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

