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
import { createResearchRunId, logger } from './logger.ts';
import type { Model } from '@earendil-works/pi-ai';
import { getConfig, setConfig, validateConfig, type Config } from './config.ts';
import { shutdownManager } from './utils/shutdown-manager.ts';
import type { ResearchDepth } from './types/index.ts';

/**
 * SDK Initialization Options
 */
export interface SDKOptions {
  /** The model to use for research coordination and synthesis */
  model: Model<any>;
  /** Optional API key for the model (if not provided via environment) */
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

/**
 * Initialize the Research SDK
 */
export async function initResearchSDK(options: SDKOptions): Promise<void> {
  if (isInitialized) {
    logger.warn('[SDK] SDK is already initialized');
    return;
  }

  globalModel = options.model;
  globalApiKey = options.apiKey;
  globalCwd = options.cwd || process.cwd();

  // Apply config overrides
  if (options.config) {
    const currentConfig = getConfig();
    setConfig({ ...currentConfig, ...options.config });
  }

  // Validate config
  validateConfig();

  // Register and initialize services
  registerCoreServices();
  registerInfrastructureServices();

  const mockCtx = createMockContext();
  await initializeCoreServices(mockCtx);

  isInitialized = true;
  logger.log('[SDK] Research SDK initialized successfully');
}

/**
 * Run Deep Research (Multi-agent, Level 1-3)
 */
export async function runDeepResearch(query: string, options: RunOptions = {}): Promise<string> {
  ensureInitialized();

  const depth = options.depth ?? 1;
  const complexity = options.complexity ?? ((depth as any) || 1);
  const researchId = createResearchRunId();
  const sessionId = `sdk-${Date.now()}`;
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
  const sessionId = `sdk-${Date.now()}`;
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
 * Dispose the Research SDK and clean up resources
 */
export async function disposeResearchSDK(): Promise<void> {
  if (!isInitialized) return;

  await shutdownManager.runCleanup('sdk_dispose');
  await disposeCoreServices();
  
  isInitialized = false;
  globalModel = null;
  globalApiKey = undefined;
  logger.log('[SDK] Research SDK disposed');
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
 * Create a mock ExtensionContext for internal services
 */
function createMockContext() {
  return {
    cwd: globalCwd,
    model: globalModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ 
        ok: true, 
        apiKey: globalApiKey || process.env['PI_AI_API_KEY'] || '', 
        headers: {} 
      }),
      hasConfiguredAuth: () => true,
      getAll: () => [globalModel],
    },
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
