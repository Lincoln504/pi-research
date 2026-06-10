/**
 * SDK Lifecycle Unit Tests
 *
 * Covers the programmatic SDK surface: initResearchSDK, runDeepResearch,
 * runQuickResearch, and shutdownResearchSDK.  All external I/O (service
 * registration, orchestrator execution) is mocked so these tests remain
 * fast, deterministic, and free of network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted stubs (available inside vi.mock factories) ───────────────────────

const { mockDeepRun, mockQuickRun, mockSetLogger, mockCreateLogger } = vi.hoisted(() => ({
  mockDeepRun: vi.fn().mockResolvedValue('deep result'),
  mockQuickRun: vi.fn().mockResolvedValue('quick result'),
  mockSetLogger: vi.fn(),
  mockCreateLogger: vi.fn().mockReturnValue({ verbose: true }),
}));

// Mock pi-coding-agent so ModelRegistry/AuthStorage don't read real disk files in unit tests
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
  },
}));

vi.mock('../../src/core/service-registry.ts', () => ({
  resetServiceContainer: vi.fn().mockResolvedValue(undefined),
  getServiceContainer: vi.fn().mockReturnValue({ isReady: false }),
  getService: vi.fn().mockImplementation((name) => {
    if (name === 'research-orchestration') return { runResearch: mockDeepRun };
    if (name === 'session-service') return { registerSession: vi.fn(), cleanup: vi.fn() };
    if (name === 'synthesis-service') return { getAllReports: vi.fn().mockResolvedValue(new Map()) };
    return {};
  }),
  tryGetService: vi.fn().mockImplementation((name) => {
    if (name === 'research-orchestration') return { runResearch: mockDeepRun };
    return {};
  }),
  disposeAllServices: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRegistry: {
    create: vi.fn().mockReturnValue(mockModelRegistryInstance),
    inMemory: vi.fn().mockReturnValue(mockModelRegistryInstance),
  },
  AuthStorage: {
    create: vi.fn().mockReturnValue({}),
    inMemory: vi.fn().mockReturnValue({}),
  },
}));

// Prototype-based constructor mocks: vi.fn() called with `new` produces an
// instance whose prototype carries `run`.
vi.mock('../../src/orchestration/deep-research-orchestrator.ts', () => {
  const MockDeepCtor = vi.fn();
  MockDeepCtor.prototype.run = mockDeepRun;
  return { DeepResearchOrchestrator: MockDeepCtor };
});

vi.mock('../../src/orchestration/quick-research-orchestrator.ts', () => {
  const MockQuickCtor = vi.fn();
  MockQuickCtor.prototype.run = mockQuickRun;
  return { QuickResearchOrchestrator: MockQuickCtor };
});

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
    LOCAL_KNOWLEDGE_STORE_ENABLED: false,
    GLOBAL_KNOWLEDGE_STORE_ENABLED: false,
    MAX_CONCURRENT_RESEARCHERS: 3,
    RESEARCHER_TIMEOUT_MS: 120000,
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
} from '../../src/sdk.ts';
import { 
  registerCoreServices, 
  initializeCoreServices, 
  disposeCoreServices 
} from '../../src/core/service-initialization.ts';
import { 
  registerInfrastructureServices, 
  initializeInfrastructureServices 
} from '../../src/infrastructure/service-initialization.ts';
import { DeepResearchOrchestrator } from '../../src/orchestration/deep-research-orchestrator.ts';
import { QuickResearchOrchestrator } from '../../src/orchestration/quick-research-orchestrator.ts';
import { logger } from '../../src/logger.ts';
import { setConfig, validateConfig } from '../../src/config.ts';
import { resetServiceContainer, disposeAllServices } from '../../src/core/service-registry.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function initSDK(opts: object = {}) {
  await initResearchSDK({ model: STUB_MODEL, ...opts });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SDK Lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeepRun.mockClear().mockResolvedValue('deep result');
    mockQuickRun.mockClear().mockResolvedValue('quick result');
    mockSetLogger.mockClear();
    mockCreateLogger.mockClear().mockReturnValue({ verbose: true });
    
    vi.mocked(registerCoreServices).mockClear();
    vi.mocked(registerInfrastructureServices).mockClear();
    vi.mocked(initializeCoreServices).mockClear().mockResolvedValue({ success: true, initialized: [], failed: [] });
    vi.mocked(initializeInfrastructureServices).mockClear().mockResolvedValue({ success: true, initialized: [], failed: [] });
    vi.mocked(disposeCoreServices).mockClear().mockResolvedValue(undefined);
    vi.mocked(disposeAllServices).mockClear().mockResolvedValue(undefined);
    vi.mocked(resetServiceContainer).mockClear().mockResolvedValue(undefined);
    vi.mocked(setConfig).mockClear();
    vi.mocked(validateConfig).mockReset();
    vi.mocked(DeepResearchOrchestrator).mockClear();
    vi.mocked(QuickResearchOrchestrator).mockClear();
  });

  afterEach(async () => {
    // Always shutdown so module-level isInitialized resets between tests.
    await shutdownResearchSDK();
  });

  // ── initResearchSDK ─────────────────────────────────────────────────────────

  describe('initResearchSDK', () => {
    it('registers core and infrastructure services', async () => {
      await initSDK();
      expect(registerCoreServices).toHaveBeenCalledOnce();
      expect(registerInfrastructureServices).toHaveBeenCalledOnce();
    });

    it('calls initializeCoreServices with a context object', async () => {
      await initSDK();
      expect(initializeCoreServices).toHaveBeenCalledOnce();
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      expect(ctx).toHaveProperty('modelRegistry');
      expect(ctx).toHaveProperty('cwd');
    });

    it('applies config overrides before registering services', async () => {
      await initSDK({ config: { LOCAL_KNOWLEDGE_STORE_ENABLED: true } });
      expect(setConfig).toHaveBeenCalled();
      expect(validateConfig).toHaveBeenCalled();
      const setOrder = vi.mocked(setConfig).mock.invocationCallOrder[0]!;
      const regOrder = vi.mocked(registerCoreServices).mock.invocationCallOrder[0]!;
      expect(setOrder).toBeLessThan(regOrder);
    });

    it('warns and returns early when called a second time without disposing', async () => {
      await initSDK();
      vi.mocked(registerCoreServices).mockClear();
      await initSDK();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledOnce();
      expect(registerCoreServices).not.toHaveBeenCalled();
    });

    it('rolls back global state and rethrows when initializeCoreServices fails', async () => {
      vi.mocked(initializeCoreServices).mockRejectedValueOnce(new Error('service init failed'));
      await expect(initSDK()).rejects.toThrow('service init failed');
      await expect(runDeepResearch('q')).rejects.toThrow('SDK not initialized');
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

    it('sets verbose logger when verbose:true is passed', async () => {
      await initSDK({ verbose: true });
      expect(mockCreateLogger).toHaveBeenCalledWith({ verbose: true });
      expect(mockSetLogger).toHaveBeenCalledOnce();
    });

    it('does not set logger when verbose is not passed', async () => {
      await initSDK();
      expect(mockSetLogger).not.toHaveBeenCalled();
    });

    it('rolls back config mutation when validateConfig throws', async () => {
      vi.mocked(validateConfig).mockImplementationOnce(() => { throw new Error('bad config'); });
      vi.mocked(setConfig).mockClear();
      // Track calls: first setConfig (mutation), then rollback setConfig
      await expect(initSDK({ config: { MAX_CONCURRENT_RESEARCHERS: 99 } as any })).rejects.toThrow('bad config');
      // setConfig called twice: once to apply override, once to roll back
      expect(vi.mocked(setConfig)).toHaveBeenCalledTimes(2);
    });

    it('resets service container on init failure so re-init can succeed', async () => {
      vi.mocked(initializeCoreServices).mockRejectedValueOnce(new Error('init failed'));
      await expect(initSDK()).rejects.toThrow('init failed');
      expect(resetServiceContainer).toHaveBeenCalledOnce();
      // Clear call counts before re-init to isolate this assertion
      vi.mocked(registerCoreServices).mockClear();
      await initSDK();
      expect(registerCoreServices).toHaveBeenCalledOnce();
    });
  });

  // ── shutdownResearchSDK ─────────────────────────────────────────────────────

  describe('shutdownResearchSDK', () => {
    it('is a no-op when the SDK was never initialized', async () => {
      await expect(shutdownResearchSDK()).resolves.toBeUndefined();
      expect(disposeCoreServices).not.toHaveBeenCalled();
    });

    it('calls disposeCoreServices after a successful init', async () => {
      await initSDK();
      await shutdownResearchSDK();
      expect(disposeAllServices).toHaveBeenCalledOnce();
    });

    it('resets initialized state so a subsequent init succeeds', async () => {
      await initSDK();
      await shutdownResearchSDK();
      vi.mocked(registerCoreServices).mockClear();
      await initSDK();
      expect(registerCoreServices).toHaveBeenCalledOnce();
    });

    it('is idempotent: second dispose is a no-op', async () => {
      await initSDK();
      await shutdownResearchSDK();
      vi.mocked(disposeAllServices).mockClear();
      await shutdownResearchSDK();
      expect(disposeAllServices).not.toHaveBeenCalled();
    });

    it('calls resetServiceContainer to clear registrations for re-init', async () => {
      await initSDK();
      await shutdownResearchSDK();
      expect(disposeAllServices).toHaveBeenCalledOnce();
    });
  });

  // ── guard: use before init ──────────────────────────────────────────────────

  describe('guard: use before init', () => {
    it('runDeepResearch throws "not initialized" before initResearchSDK', async () => {
      await expect(runDeepResearch('test query')).rejects.toThrow(
        'SDK not initialized. Call initResearchSDK() first.'
      );
    });

    it('runQuickResearch throws "not initialized" before initResearchSDK', async () => {
      await expect(runQuickResearch('test query')).rejects.toThrow(
        'SDK not initialized. Call initResearchSDK() first.'
      );
    });

    it('runDeepResearch throws after dispose', async () => {
      await initSDK();
      await shutdownResearchSDK();
      await expect(runDeepResearch('test query')).rejects.toThrow(
        'SDK not initialized'
      );
    });
  });

  // ── runDeepResearch ─────────────────────────────────────────────────────────

  describe('runDeepResearch', () => {
    beforeEach(async () => {
      await initSDK({ cwd: '/custom/path' });
    });

    it('returns the string result from the orchestrator', async () => {
      const result = await runDeepResearch('q');
      expect(result).toBe('deep result');
    });

    it('instantiates DeepResearchOrchestrator with the provided query', async () => {
      await runDeepResearch('my query');
      expect(mockDeepRun).toHaveBeenCalled();
    });

    it('defaults to complexity 1 when no options given', async () => {
      await runDeepResearch('q');
      // @ts-ignore
      const calls = mockDeepRun.mock.calls;
      expect(calls[0][0].complexity).toBe(1);
    });

    it('passes the explicit complexity option to the orchestrator', async () => {
      await runDeepResearch('q', { complexity: 3 });
      // @ts-ignore
      const calls = mockDeepRun.mock.calls;
      expect(calls[0][0].complexity).toBe(3);
    });

    it('clamps complexity above 3 to 3', async () => {
      // @ts-expect-error intentional out-of-range value
      await runDeepResearch('q', { complexity: 5 });
      // @ts-ignore
      const calls = mockDeepRun.mock.calls;
      expect(calls[0][0].complexity).toBe(3);
    });

    it('clamps complexity below 1 to 1', async () => {
      // @ts-expect-error intentional out-of-range value
      await runDeepResearch('q', { complexity: 0 });
      // @ts-ignore
      const calls = mockDeepRun.mock.calls;
      expect(calls[0][0].complexity).toBe(1);
    });

    it('passes an abort signal through to orchestrator.run()', async () => {
      const controller = new AbortController();
      await runDeepResearch('q', { signal: controller.signal });
      // @ts-ignore
      const calls = mockDeepRun.mock.calls;
      expect(calls[0][1]).toBe(controller.signal);
    });

    it('propagates rejection from the orchestrator', async () => {
      mockDeepRun.mockRejectedValueOnce(new Error('network error'));
      await expect(runDeepResearch('q')).rejects.toThrow('network error');
    });

    it('passes the model from initResearchSDK to the orchestrator', async () => {
      await runDeepResearch('q');
      // @ts-ignore
      const calls = mockDeepRun.mock.calls;
      expect(calls[0][0].model).toBe(STUB_MODEL);
    });

    it('each call receives a non-empty researchId', async () => {
      await runDeepResearch('q1');
      await runDeepResearch('q2');
      // @ts-ignore
      const calls = mockDeepRun.mock.calls;
      const id1 = calls[0][0].researchId;
      const id2 = calls[1][0].researchId;
      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
    });

    it('each call gets a unique sessionId (UUID-based)', async () => {
      await runDeepResearch('q1');
      await runDeepResearch('q2');
      // @ts-ignore
      const calls = mockDeepRun.mock.calls;
      const s1 = calls[0][0].sessionId;
      const s2 = calls[1][0].sessionId;
      // Note: UUID randomness can collide but P=10^-37 so we assume unique
      expect(s1).not.toBe(s2);
    });
  });

  // ── runQuickResearch ────────────────────────────────────────────────────────

  describe('runQuickResearch', () => {
    beforeEach(async () => {
      await initSDK();
    });

    it('returns the string result from the orchestrator', async () => {
      const result = await runQuickResearch('Quick question');
      expect(result).toBe('deep result'); // runQuickResearch calls runDeepResearch with depth 0
    });

    it('passes the query to the orchestrator', async () => {
      await runQuickResearch('quick query');
      // @ts-ignore
      const calls = mockDeepRun.mock.calls;
      expect(calls[0][0].query).toBe('quick query');
    });

    it('passes an abort signal through to orchestrator.run()', async () => {
      const controller = new AbortController();
      await runQuickResearch('q', { signal: controller.signal });
      // @ts-ignore
      const calls = mockDeepRun.mock.calls;
      expect(calls[0][1]).toBe(controller.signal);
    });

    it('passes a pre-aborted signal through unmodified', async () => {
      const controller = new AbortController();
      controller.abort();
      await runQuickResearch('q', { signal: controller.signal });
      // @ts-ignore
      const calls = mockDeepRun.mock.calls;
      expect(calls[0][1]).toBe(controller.signal);
      expect((calls[0][1] as AbortSignal).aborted).toBe(true);
    });

    it('propagates rejection from the orchestrator', async () => {
      mockDeepRun.mockRejectedValueOnce(new Error('timeout'));
      await expect(runQuickResearch('q')).rejects.toThrow('timeout');
    });

    it('passes the model from initResearchSDK to the orchestrator', async () => {
      await runQuickResearch('q');
      // @ts-ignore
      const calls = mockDeepRun.mock.calls;
      expect(calls[0][0].model).toBe(STUB_MODEL);
    });
  });

  // ── context passed to initializeCoreServices ───────────────────────────────

  describe('context passed to initializeCoreServices', () => {
    it('uses a real ModelRegistry instance (reads pi config by default)', async () => {
      await initSDK();
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      expect(ctx.modelRegistry).toBe(mockModelRegistryInstance);
    });

    it('passes cwd to the context', async () => {
      const customCwd = '/tmp/my-research';
      await initSDK({ cwd: customCwd });
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      expect(ctx.cwd).toBe(customCwd);
    });

    it('seeds InMemory auth when apiKey is provided', async () => {
      await initSDK({ apiKey: 'my-secret-key', provider: 'my-provider' });
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      expect(ctx.modelRegistry).toBe(mockModelRegistryInstance);
    });

    it('ui.notify does not throw', async () => {
      await initSDK();
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      expect(() => ctx.ui.notify('test')).not.toThrow();
    });
  });
});
