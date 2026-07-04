/**
 * SDK Lifecycle Unit Tests
 *
 * Covers the programmatic SDK surface: initResearchSDK, runDeepResearch,
 * runQuickResearch, and shutdownResearchSDK.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted stubs ───────────────────────

// Both runDeepResearch and runQuickResearch route through the single
// 'research-orchestration' service's runResearch() (quick = depth 0), so one
// orchestrator stub covers both entry points.
const { mockDeepRun, mockSetLogger, mockCreateLogger } = vi.hoisted(() => ({
  mockDeepRun: vi.fn().mockResolvedValue('deep result'),
  mockSetLogger: vi.fn(),
  mockCreateLogger: vi.fn().mockReturnValue({ verbose: true }),
}));

const { mockModelRegistryInstance, STUB_MODEL } = vi.hoisted(() => {
  const stubModel = { id: 'test-model', provider: 'test-provider' };
  const instance = {
    getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'mock-key' }),
    hasConfiguredAuth: vi.fn().mockReturnValue(true),
    getAll: vi.fn().mockReturnValue([stubModel]),
    getAvailable: vi.fn().mockReturnValue([stubModel]),
    find: vi.fn().mockReturnValue(stubModel),
    refresh: vi.fn(),
  };
  return { mockModelRegistryInstance: instance, STUB_MODEL: stubModel };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../src/orchestration/service-initialization.ts', () => ({
  registerOrchestrationServices: vi.fn(),
  initializeOrchestrationServices: vi.fn().mockResolvedValue({ success: true, initialized: [], failed: [] }),
}));

vi.mock('../../src/core/service-initialization.ts', () => ({
  registerCoreServices: vi.fn(),
  initializeCoreServices: vi.fn().mockResolvedValue({ success: true, initialized: [], failed: [] }),
  disposeCoreServices: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/infrastructure/service-initialization.ts', () => ({
  registerInfrastructureServices: vi.fn(),
  initializeInfrastructureServices: vi.fn().mockResolvedValue({ success: true, initialized: [], failed: [] }),
  shutdownInfrastructureServices: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/utils/shutdown-manager.ts', () => ({
  shutdownManager: {
    runCleanup: vi.fn().mockResolvedValue(undefined),
    registerEventListener: vi.fn(),
  },
}));

vi.mock('../../src/core/service-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/service-registry.ts')>();
  return {
    ...actual,
    resetServiceContainer: vi.fn().mockResolvedValue(undefined),
    getServiceContainer: vi.fn().mockReturnValue({ isReady: false }),
    createServiceContainer: vi.fn().mockReturnValue({ isReady: false, register: vi.fn() }),
    getService: vi.fn().mockImplementation((name, _ctx, _container) => {
      if (name === 'research-orchestration') return { runResearch: mockDeepRun };
      if (name === 'session-service') return { registerSession: vi.fn(), cleanup: vi.fn() };
      if (name === 'research-synthesis-service') return { getAllReports: vi.fn().mockResolvedValue(new Map()), appendMetadata: vi.fn((result: string) => result) };
      return {};
    }),
    tryGetService: vi.fn().mockImplementation((name) => {
      if (name === 'research-orchestration') return { runResearch: mockDeepRun };
      return {};
    }),
    tryGetServiceContainerFromCtx: vi.fn((ctx: any) => ctx?.container || { isReady: true }),
    disposeAllServices: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRegistry: {
    create: vi.fn().mockReturnValue(mockModelRegistryInstance),
    inMemory: vi.fn().mockReturnValue(mockModelRegistryInstance),
  },
  AuthStorage: {
    create: vi.fn().mockReturnValue({}),
    inMemory: vi.fn().mockReturnValue({}),
  },
  getAgentDir: vi.fn().mockReturnValue('/home/user/.pi/agent'),
  CONFIG_DIR_NAME: '.pi',
}));

vi.mock('../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createResearchRunId: () => 'test-run-id',
  createLogger: mockCreateLogger,
  setLogger: mockSetLogger,
  resetLogger: vi.fn(),
}));

vi.mock('../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({
    DEFAULT_RESEARCH_DEPTH: 1,
    KNOWLEDGE_STORE_MODE: 'none',
    MAX_CONCURRENT_RESEARCHERS: 3,
    RESEARCHER_TIMEOUT_MS: 120000,
  })),
  // createConfig is used by the SDK only on the ignoreGlobalConfig path; return a
  // distinct sentinel so a test can prove the global file was NOT read.
  createConfig: vi.fn(() => ({
    DEFAULT_RESEARCH_DEPTH: 1,
    KNOWLEDGE_STORE_MODE: 'none',
    MAX_CONCURRENT_RESEARCHERS: 3,
    RESEARCHER_TIMEOUT_MS: 120000,
    __hermetic: true,
  })),
  setConfig: vi.fn(),
  validateConfig: vi.fn(),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import {
  initResearchSDK,
  runDeepResearch,
  runQuickResearch,
  shutdownResearchSDK,
  getLastRunMetrics,
  getLastRunSummary,
  getLastRunStats,
  getSessionMetrics,
} from '../../src/sdk.ts';
import { 
  registerCoreServices, 
  initializeCoreServices, 
} from '../../src/core/service-initialization.ts';
import { 
  registerInfrastructureServices, 
} from '../../src/infrastructure/service-initialization.ts';
import { 
  registerOrchestrationServices, 
} from '../../src/orchestration/service-initialization.ts';
import { logger } from '../../src/logger.ts';
import { getConfig } from '../../src/config.ts';
import { resetServiceContainer, disposeAllServices } from '../../src/core/service-registry.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function initSDK(opts: Record<string, any> = {}) {
  await initResearchSDK({ model: STUB_MODEL as any, ...opts });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SDK Lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeepRun.mockClear().mockResolvedValue('deep result');
    mockSetLogger.mockClear();
    mockCreateLogger.mockClear().mockReturnValue({ verbose: true });
    
    vi.mocked(registerCoreServices).mockClear();
    vi.mocked(registerInfrastructureServices).mockClear();
    vi.mocked(registerOrchestrationServices).mockClear();
    vi.mocked(initializeCoreServices).mockClear().mockResolvedValue({ success: true, initialized: [], failed: [] } as any);
    vi.mocked(disposeAllServices).mockClear().mockResolvedValue(undefined);
    vi.mocked(resetServiceContainer).mockClear().mockResolvedValue(undefined);
    vi.mocked(getConfig).mockClear().mockReturnValue({
        DEFAULT_RESEARCH_DEPTH: 1,
        KNOWLEDGE_STORE_MODE: 'none',
        MAX_CONCURRENT_RESEARCHERS: 3,
        RESEARCHER_TIMEOUT_MS: 120000,
    } as any);
  });

  afterEach(async () => {
    await shutdownResearchSDK();
  });

  describe('initResearchSDK', () => {
    it('consults the configured RESEARCH_MODEL when no model option is given', async () => {
      // Regression: the resolver used to see only options.model, so a configured
      // RESEARCH_MODEL governed the researchers/synthesis while the session model
      // (ctx.model → coordinator/planning) silently fell back to the registry's
      // first authed entry — a split-brain run on two models. Seeding must make
      // the session-model resolution look up the CONFIGURED spec in the registry.
      await initResearchSDK({ config: { RESEARCH_MODEL: 'cfg-provider/cfg-model' } as any });
      expect(mockModelRegistryInstance.find).toHaveBeenCalledWith('cfg-provider', 'cfg-model');
    });

    it('registers core, infrastructure, and orchestration services', async () => {
      await initSDK();
      expect(registerCoreServices).toHaveBeenCalledOnce();
      expect(registerInfrastructureServices).toHaveBeenCalledOnce();
      expect(registerOrchestrationServices).toHaveBeenCalledOnce();
    });

    it('calls initializeCoreServices with a context object', async () => {
      await initSDK();
      expect(initializeCoreServices).toHaveBeenCalledOnce();
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      expect(ctx).toHaveProperty('modelRegistry');
      expect(ctx).toHaveProperty('cwd');
    });

    it('loads the BASE config for the directory (no per-interface overlay — the SDK is code-configured)', async () => {
      await initSDK({ cwd: '/custom/path' });
      // The SDK reads base config only; it must NOT pass an interface tag (no sdk.env).
      expect(getConfig).toHaveBeenCalledWith('/custom/path');
    });

    it('ignoreGlobalConfig skips the global file entirely (hermetic, code-only config)', async () => {
      const { createConfig } = await import('../../src/config.ts');
      vi.mocked(getConfig).mockClear();
      await initSDK({ ignoreGlobalConfig: true });
      // getConfig (the global-file reader) must NOT be called; createConfig builds
      // a config from defaults + process.env only.
      expect(getConfig).not.toHaveBeenCalled();
      expect(createConfig).toHaveBeenCalled();
    });

    it('warns and returns early when called a second time without disposing', async () => {
      await initSDK();
      vi.mocked(registerCoreServices).mockClear();
      vi.mocked(registerOrchestrationServices).mockClear();
      await initSDK();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledOnce();
      expect(registerCoreServices).not.toHaveBeenCalled();
      expect(registerOrchestrationServices).not.toHaveBeenCalled();
    });

    it('uses process.cwd() when no cwd option is provided', async () => {
      await initSDK();
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      expect(ctx.cwd).toBe(process.cwd());
    });

    it('uses the provided cwd option', async () => {
      await initSDK({ cwd: '/custom/path' });
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      expect(ctx.cwd).toBe('/custom/path');
    });
  });

  describe('runDeepResearch', () => {
    it('returns the string result from the orchestrator', async () => {
      await initSDK();
      const result = await runDeepResearch('q');
      expect(result).toBe('deep result');
    });

    it('uses a Model OBJECT passed to initResearchSDK as-is for the session model', async () => {
      // Regression: the resolve call narrowed options.model with
      // `typeof === 'string' ? … : undefined`, so a Model object was silently
      // DROPPED and the session ran on whatever the registry fallback picked.
      // With the default single-entry mock registry the fallback coincidentally
      // resolves back to STUB_MODEL, so point every registry lookup at a DIFFERENT
      // model for this test — the assertion below then discriminates: the old code
      // would pass `decoy`, only pass-through-as-is yields the STUB_MODEL reference.
      const decoy = { id: 'decoy-model', provider: 'test-provider' };
      mockModelRegistryInstance.getAll.mockReturnValue([decoy]);
      mockModelRegistryInstance.getAvailable.mockReturnValue([decoy]);
      mockModelRegistryInstance.find.mockReturnValue(decoy);
      try {
        await initSDK(); // initSDK passes STUB_MODEL (an object)
        await runDeepResearch('q');
        const passed = mockDeepRun.mock.calls[0]![0] as any;
        expect(passed.model).toBe(STUB_MODEL);
      } finally {
        mockModelRegistryInstance.getAll.mockReturnValue([STUB_MODEL]);
        mockModelRegistryInstance.getAvailable.mockReturnValue([STUB_MODEL]);
        mockModelRegistryInstance.find.mockReturnValue(STUB_MODEL);
      }
    });

    it('an explicit model option pins RESEARCH_MODEL for the whole run (researchers included)', async () => {
      // Regression: researchers/synthesis resolve through config.RESEARCH_MODEL,
      // which used to outrank the explicit option — `--model X` with a configured
      // model Y ran the coordinator on X and the researchers on Y.
      await initSDK({ config: { RESEARCH_MODEL: 'cfg-provider/cfg-model' } });
      await runDeepResearch('q');
      const passed = mockDeepRun.mock.calls[0]![0] as any;
      expect(passed.config.RESEARCH_MODEL).toBe('test-provider/test-model'); // from STUB_MODEL, not the config
    });

    it('forwards the SDK-global config (from initResearchSDK) into runResearch', async () => {
      await initSDK({ config: { KNOWLEDGE_STORE_MODE: 'none', MAX_SCRAPE_BATCHES: 7 } });
      await runDeepResearch('q');
      const passed = mockDeepRun.mock.calls[0]![0] as any;
      expect(passed.config.MAX_SCRAPE_BATCHES).toBe(7);
      expect(passed.config.KNOWLEDGE_STORE_MODE).toBe('none');
    });

    it('lets a per-call options.config override the SDK-global config', async () => {
      await initSDK({ config: { MAX_SCRAPE_BATCHES: 7 } });
      await runDeepResearch('q', { config: { MAX_SCRAPE_BATCHES: 1 } as any });
      const passed = mockDeepRun.mock.calls[0]![0] as any;
      expect(passed.config.MAX_SCRAPE_BATCHES).toBe(1);
    });

    it('captures a per-run metrics summary readable by audit consumers', async () => {
      await initSDK();
      await runDeepResearch('q');
      const summary = getLastRunSummary();
      expect(summary).not.toBeNull();
      expect(summary!.status).toBe('success');
      expect(summary!.runId).toMatch(/^sdk-/);
      const snap = getLastRunMetrics();
      expect(snap).not.toBeNull();
      expect(snap).toHaveProperty('counters');
      // getLastRunStats() and getSessionMetrics() must be callable without throwing.
      expect(() => getLastRunStats()).not.toThrow();
      expect(getSessionMetrics()).toHaveProperty('counters');
    });
  });

  describe('runQuickResearch', () => {
    it('throws "not initialized" before init', async () => {
      await expect(runQuickResearch('q')).rejects.toThrow('SDK not initialized');
    });

    it('delegates to the orchestrator with depth 0 and returns its result', async () => {
      await initSDK();
      const result = await runQuickResearch('quick q');
      expect(result).toBe('deep result');
      expect(mockDeepRun).toHaveBeenCalledOnce();
      const passed = mockDeepRun.mock.calls[0]![0] as any;
      expect(passed.query).toBe('quick q');
      expect(passed.depth).toBe(0);
    });
  });
});
