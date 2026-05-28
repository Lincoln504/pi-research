/**
 * SDK Lifecycle Unit Tests
 *
 * Covers the programmatic SDK surface: initResearchSDK, runDeepResearch,
 * runQuickResearch, and disposeResearchSDK.  All external I/O (service
 * registration, orchestrator execution) is mocked so these tests remain
 * fast, deterministic, and free of network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted stubs (available inside vi.mock factories) ───────────────────────

const { mockDeepRun, mockQuickRun } = vi.hoisted(() => ({
  mockDeepRun: vi.fn().mockResolvedValue('deep result'),
  mockQuickRun: vi.fn().mockResolvedValue('quick result'),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../src/core/service-initialization.ts', () => ({
  registerCoreServices: vi.fn(),
  initializeCoreServices: vi.fn().mockResolvedValue(undefined),
  disposeCoreServices: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/infrastructure/service-initialization.ts', () => ({
  registerInfrastructureServices: vi.fn(),
}));

vi.mock('../../src/utils/shutdown-manager.ts', () => ({
  shutdownManager: {
    runCleanup: vi.fn().mockResolvedValue(undefined),
  },
}));

// Prototype-based constructor mocks: vi.fn() called with `new` produces an
// instance whose prototype carries `run`.  This is the safest pattern for
// ESM + forks pool in Vitest 4 — it avoids arrow-function `new` issues and
// survives beforeEach mock-clear without stripping the prototype binding.
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
}));

vi.mock('../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({
    DEFAULT_RESEARCH_DEPTH: 1,
    KNOWLEDGE_STORE_ENABLED: false,
    MAX_CONCURRENT_RESEARCHERS: 3,
    RESEARCHER_TIMEOUT_MS: 120000,
  })),
  setConfig: vi.fn(),
  validateConfig: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  initResearchSDK,
  runDeepResearch,
  runQuickResearch,
  disposeResearchSDK,
} from '../../src/sdk.ts';
import {
  registerCoreServices,
  initializeCoreServices,
  disposeCoreServices,
} from '../../src/core/service-initialization.ts';
import { registerInfrastructureServices } from '../../src/infrastructure/service-initialization.ts';
import { DeepResearchOrchestrator } from '../../src/orchestration/deep-research-orchestrator.ts';
import { QuickResearchOrchestrator } from '../../src/orchestration/quick-research-orchestrator.ts';
import { logger } from '../../src/logger.ts';
import { setConfig, validateConfig } from '../../src/config.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STUB_MODEL = { id: 'test-model' } as any;

async function initSDK(opts: object = {}) {
  await initResearchSDK({ model: STUB_MODEL, ...opts });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SDK Lifecycle', () => {
  beforeEach(() => {
    // Clear call history on all mocks and re-arm resolved values.
    // Constructor mocks use prototype-based `run` so mockClear() is safe —
    // it only resets call tracking, leaving the prototype binding intact.
    mockDeepRun.mockClear().mockResolvedValue('deep result');
    mockQuickRun.mockClear().mockResolvedValue('quick result');
    vi.mocked(registerCoreServices).mockClear();
    vi.mocked(registerInfrastructureServices).mockClear();
    vi.mocked(initializeCoreServices).mockClear().mockResolvedValue({ initialized: [], failed: [] });
    vi.mocked(disposeCoreServices).mockClear().mockResolvedValue(undefined);
    vi.mocked(setConfig).mockClear();
    vi.mocked(validateConfig).mockClear();
    vi.mocked(DeepResearchOrchestrator).mockClear();
    vi.mocked(QuickResearchOrchestrator).mockClear();
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(async () => {
    // Always dispose so module-level isInitialized resets between tests.
    await disposeResearchSDK();
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
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0];
      expect(ctx).toBeDefined();
      expect(typeof (ctx as any).cwd).toBe('string');
    });

    it('applies config overrides before registering services', async () => {
      await initSDK({ config: { KNOWLEDGE_STORE_ENABLED: true } });
      expect(setConfig).toHaveBeenCalled();
      expect(validateConfig).toHaveBeenCalled();
      const setOrder = vi.mocked(setConfig).mock.invocationCallOrder[0]!;
      const regOrder = vi.mocked(registerCoreServices).mock.invocationCallOrder[0]!;
      expect(setOrder).toBeLessThan(regOrder);
    });

    it('warns and returns early when called a second time without disposing', async () => {
      await initSDK();
      vi.mocked(logger.warn).mockClear();
      vi.mocked(registerCoreServices).mockClear();
      await initSDK();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledOnce();
      expect(registerCoreServices).not.toHaveBeenCalled();
    });

    it('rolls back global state and rethrows when initializeCoreServices fails', async () => {
      vi.mocked(initializeCoreServices).mockRejectedValueOnce(new Error('service init failed'));
      await expect(initSDK()).rejects.toThrow('service init failed');
      await expect(runDeepResearch('q')).rejects.toThrow('Research SDK not initialized');
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

  // ── disposeResearchSDK ──────────────────────────────────────────────────────

  describe('disposeResearchSDK', () => {
    it('is a no-op when the SDK was never initialized', async () => {
      await expect(disposeResearchSDK()).resolves.toBeUndefined();
      expect(disposeCoreServices).not.toHaveBeenCalled();
    });

    it('calls disposeCoreServices after a successful init', async () => {
      await initSDK();
      await disposeResearchSDK();
      expect(disposeCoreServices).toHaveBeenCalledOnce();
    });

    it('resets initialized state so a subsequent init succeeds', async () => {
      await initSDK();
      await disposeResearchSDK();
      vi.mocked(registerCoreServices).mockClear();
      await initSDK();
      expect(registerCoreServices).toHaveBeenCalledOnce();
    });

    it('is idempotent: second dispose is a no-op', async () => {
      await initSDK();
      await disposeResearchSDK();
      vi.mocked(disposeCoreServices).mockClear();
      await disposeResearchSDK();
      expect(disposeCoreServices).not.toHaveBeenCalled();
    });
  });

  // ── guard: use before init ──────────────────────────────────────────────────

  describe('guard: use before init', () => {
    it('runDeepResearch throws "not initialized" before initResearchSDK', async () => {
      await expect(runDeepResearch('test query')).rejects.toThrow(
        'Research SDK not initialized. Call initResearchSDK() first.'
      );
    });

    it('runQuickResearch throws "not initialized" before initResearchSDK', async () => {
      await expect(runQuickResearch('test query')).rejects.toThrow(
        'Research SDK not initialized. Call initResearchSDK() first.'
      );
    });

    it('runDeepResearch throws after dispose', async () => {
      await initSDK();
      await disposeResearchSDK();
      await expect(runDeepResearch('test query')).rejects.toThrow(
        'Research SDK not initialized'
      );
    });
  });

  // ── runDeepResearch ─────────────────────────────────────────────────────────

  describe('runDeepResearch', () => {
    beforeEach(async () => {
      await initSDK();
    });

    it('returns the string result from the orchestrator', async () => {
      const result = await runDeepResearch('What is TypeScript?');
      expect(result).toBe('deep result');
    });

    it('instantiates DeepResearchOrchestrator with the provided query', async () => {
      await runDeepResearch('my query');
      expect(DeepResearchOrchestrator).toHaveBeenCalledOnce();
      const opts = vi.mocked(DeepResearchOrchestrator).mock.calls[0]![0] as any;
      expect(opts.query).toBe('my query');
    });

    it('defaults to complexity 1 when no options given', async () => {
      await runDeepResearch('q');
      const opts = vi.mocked(DeepResearchOrchestrator).mock.calls[0]![0] as any;
      expect(opts.complexity).toBe(1);
    });

    it('passes the explicit complexity option to the orchestrator', async () => {
      await runDeepResearch('q', { complexity: 3 });
      const opts = vi.mocked(DeepResearchOrchestrator).mock.calls[0]![0] as any;
      expect(opts.complexity).toBe(3);
    });

    it('clamps complexity above 3 to 3', async () => {
      // @ts-expect-error intentional out-of-range value
      await runDeepResearch('q', { complexity: 5 });
      const opts = vi.mocked(DeepResearchOrchestrator).mock.calls[0]![0] as any;
      expect(opts.complexity).toBe(3);
    });

    it('clamps complexity below 1 to 1', async () => {
      // @ts-expect-error intentional out-of-range value
      await runDeepResearch('q', { complexity: 0 });
      const opts = vi.mocked(DeepResearchOrchestrator).mock.calls[0]![0] as any;
      expect(opts.complexity).toBe(1);
    });

    it('passes an abort signal through to orchestrator.run()', async () => {
      const controller = new AbortController();
      await runDeepResearch('q', { signal: controller.signal });
      expect(mockDeepRun).toHaveBeenCalledWith(controller.signal);
    });

    it('propagates rejection from the orchestrator', async () => {
      mockDeepRun.mockRejectedValueOnce(new Error('network error'));
      await expect(runDeepResearch('q')).rejects.toThrow('network error');
    });

    it('passes the model from initResearchSDK to the orchestrator', async () => {
      await runDeepResearch('q');
      const opts = vi.mocked(DeepResearchOrchestrator).mock.calls[0]![0] as any;
      expect(opts.model).toBe(STUB_MODEL);
    });

    it('each call receives a non-empty researchId', async () => {
      await runDeepResearch('q1');
      await runDeepResearch('q2');
      const id1 = (vi.mocked(DeepResearchOrchestrator).mock.calls[0]![0] as any).researchId;
      const id2 = (vi.mocked(DeepResearchOrchestrator).mock.calls[1]![0] as any).researchId;
      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
    });
  });

  // ── runQuickResearch ────────────────────────────────────────────────────────

  describe('runQuickResearch', () => {
    beforeEach(async () => {
      await initSDK();
    });

    it('returns the string result from the orchestrator', async () => {
      const result = await runQuickResearch('Quick question');
      expect(result).toBe('quick result');
    });

    it('instantiates QuickResearchOrchestrator (not Deep)', async () => {
      await runQuickResearch('q');
      expect(QuickResearchOrchestrator).toHaveBeenCalledOnce();
      expect(DeepResearchOrchestrator).not.toHaveBeenCalled();
    });

    it('passes the query to the orchestrator', async () => {
      await runQuickResearch('quick query');
      const opts = vi.mocked(QuickResearchOrchestrator).mock.calls[0]![0] as any;
      expect(opts.query).toBe('quick query');
    });

    it('passes an abort signal through to orchestrator.run()', async () => {
      const controller = new AbortController();
      await runQuickResearch('q', { signal: controller.signal });
      expect(mockQuickRun).toHaveBeenCalledWith(controller.signal);
    });

    it('passes a pre-aborted signal through unmodified', async () => {
      const controller = new AbortController();
      controller.abort();
      await runQuickResearch('q', { signal: controller.signal });
      expect(mockQuickRun).toHaveBeenCalledWith(controller.signal);
      expect((mockQuickRun.mock.calls[0]![0] as AbortSignal).aborted).toBe(true);
    });

    it('propagates rejection from the orchestrator', async () => {
      mockQuickRun.mockRejectedValueOnce(new Error('timeout'));
      await expect(runQuickResearch('q')).rejects.toThrow('timeout');
    });

    it('passes the model from initResearchSDK to the orchestrator', async () => {
      await runQuickResearch('q');
      const opts = vi.mocked(QuickResearchOrchestrator).mock.calls[0]![0] as any;
      expect(opts.model).toBe(STUB_MODEL);
    });
  });

  // ── mock context shape ──────────────────────────────────────────────────────

  describe('mock context passed to initializeCoreServices', () => {
    it('modelRegistry.getApiKeyAndHeaders returns ok:true', async () => {
      await initSDK();
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      const result = await ctx.modelRegistry.getApiKeyAndHeaders();
      expect(result.ok).toBe(true);
      expect(typeof result.apiKey).toBe('string');
    });

    it('modelRegistry.hasConfiguredAuth returns true', async () => {
      await initSDK();
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      expect(ctx.modelRegistry.hasConfiguredAuth()).toBe(true);
    });

    it('modelRegistry.getAll includes the configured model', async () => {
      await initSDK();
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      expect(ctx.modelRegistry.getAll()).toContain(STUB_MODEL);
    });

    it('ui.notify does not throw', async () => {
      await initSDK();
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      expect(() => ctx.ui.notify('test')).not.toThrow();
    });

    it('uses the provided apiKey in the modelRegistry', async () => {
      await initSDK({ apiKey: 'my-secret-key' });
      const ctx = vi.mocked(initializeCoreServices).mock.calls[0]![0] as any;
      const result = await ctx.modelRegistry.getApiKeyAndHeaders();
      expect(result.apiKey).toBe('my-secret-key');
    });
  });
});
