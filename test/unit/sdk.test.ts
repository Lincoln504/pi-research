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
    register: vi.fn(),
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
      if (name === 'planning') return { getTotalResearchersPlanned: vi.fn().mockReturnValue(3) };
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
  // pi 0.80.8+: ModelRegistry is a sync facade wrapping a ModelRuntime.
  // buildModelRegistry does `await ModelRuntime.create(...)` then `new ModelRegistry(runtime)`.
  ModelRuntime: {
    create: vi.fn().mockResolvedValue({
      setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
    }),
  },
  ModelRegistry: class MockModelRegistry {
    constructor() {
      // Returning an object from a constructor overrides `new`'s default instance.
      return mockModelRegistryInstance;
    }
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
  // _doShutdown clears the module-level config cache so re-init reads fresh config.
  resetConfig: vi.fn(),
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
  getLastResearcherOutcome,
  getLastErrorReport,
} from '../../src/sdk.ts';
import { metrics } from '../../src/utils/metrics.ts';
import {
  registerCoreServices,
  initializeCoreServices,
  disposeCoreServices,
} from '../../src/core/service-initialization.ts';
import { 
  registerInfrastructureServices, 
} from '../../src/infrastructure/service-initialization.ts';
import { 
  registerOrchestrationServices, 
} from '../../src/orchestration/service-initialization.ts';
import { logger } from '../../src/logger.ts';
import { getConfig } from '../../src/config.ts';
import { resetServiceContainer, disposeAllServices, getService } from '../../src/core/service-registry.ts';

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

    it('shutdown clears the module-level config cache so a re-init reads fresh config', async () => {
      // The cache outlives every SDK global; without this a shutdown →
      // env/config-file change → re-init cycle silently reuses stale config.
      const { resetConfig } = await import('../../src/config.ts');
      vi.mocked(resetConfig).mockClear();
      await initSDK();
      await shutdownResearchSDK();
      expect(resetConfig).toHaveBeenCalled();
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

    it('waits out an in-flight shutdown instead of silently no-oping on the stale isInitialized=true window', async () => {
      // Regression: isInitialized only flips to false near the END of
      // _doShutdown (after container disposal), so a call landing while a
      // shutdown was still mid-teardown hit the "already initialized" branch,
      // warned, and returned — believing the SDK was ready while its container
      // was being disposed out from under it.
      await initSDK();
      vi.mocked(registerCoreServices).mockClear();
      vi.mocked(logger.warn).mockClear();

      let releaseDispose!: () => void;
      vi.mocked(disposeCoreServices).mockImplementationOnce(() => new Promise<void>((res) => { releaseDispose = res; }));
      const shutdownPromise = shutdownResearchSDK();
      await new Promise((r) => setImmediate(r)); // shutdown wedged inside disposeCoreServices; isInitialized still true here

      const initPromise = initResearchSDK({ model: STUB_MODEL as any });
      await new Promise((r) => setImmediate(r)); // give the racing init a chance to take the stale branch if unfixed
      releaseDispose();
      await shutdownPromise;
      await initPromise;

      // A genuine re-init happened — services were registered again, not
      // skipped via the "already initialized" no-op.
      expect(registerCoreServices).toHaveBeenCalledOnce();
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalledWith(expect.stringContaining('already initialized'));
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

    it('captures a researcher-outcome summary (planned/launched/succeeded/failed) readable after the run', async () => {
      await initSDK();
      await runDeepResearch('q');
      const outcome = getLastResearcherOutcome();
      expect(outcome).not.toBeNull();
      // planningService.getTotalResearchersPlanned is mocked to 3; this mock run
      // never emits researchers_launched_total or records a failure, so launched/
      // failed are both 0 — the point of this test is that the accessor is
      // populated and internally consistent (succeeded === launched - failed),
      // not that it be a live plan/launch count in a fully stubbed orchestrator.
      expect(outcome!.planned).toBe(3);
      expect(outcome!.succeeded).toBe(outcome!.launched - outcome!.failed);
      expect(outcome!.failureReasons).toEqual({});
    });

    it('captures the planned count from observer events DURING the run (deep runs: planning state is cleared before the SDK regains control)', async () => {
      // Regression: captureResearcherOutcome read getTotalResearchersPlanned(researchId)
      // AFTER runResearch() resolved, but the deep orchestrator's own finally clears that
      // per-run entry first — planned was ALWAYS 0 for deep runs. The SDK now sums the
      // orchestrator's planning events; the mocked service read (3) must NOT be consulted
      // when the observer captured a count, so 5 here discriminates the two sources.
      await initSDK();
      mockDeepRun.mockImplementation(async (opts: any) => {
        // Round 1 plan + a round-2 delegation, mirroring the deep orchestrator's emissions.
        opts.observer.onPlanningSuccess({ action: 'delegate', researchers: [{}, {}] });
        opts.observer.onEvaluationDecision('delegate', { action: 'delegate', researchers: [{}, {}, {}] }, 2);
        // A synthesize decision carries no planned researchers and must not count.
        opts.observer.onEvaluationDecision('synthesize', { researchers: [{}] }, 3);
        return 'deep result';
      });
      await runDeepResearch('q');
      expect(getLastResearcherOutcome()!.planned).toBe(5);
    });

    it('still forwards observer events to the caller\'s ResearchObserver through the capture wrapper', async () => {
      await initSDK();
      const onPlanningSuccess = vi.fn();
      const onResearcherStart = vi.fn();
      mockDeepRun.mockImplementation(async (opts: any) => {
        opts.observer.onPlanningSuccess({ action: 'delegate', researchers: [{}] });
        opts.observer.onResearcherStart('1.researcher-0', 'R', 'goal', 1);
        return 'deep result';
      });
      await runDeepResearch('q', { observer: { onPlanningSuccess, onResearcherStart } } as any);
      expect(onPlanningSuccess).toHaveBeenCalledWith({ action: 'delegate', researchers: [{}] });
      expect(onResearcherStart).toHaveBeenCalledWith('1.researcher-0', 'R', 'goal', 1);
    });

    it('normalizes an { onProgress } options bag itself so planning events still reach both the bag and the capture', async () => {
      // If the ORCHESTRATOR wrapped the bag, its HeadlessObserver instance would receive
      // the planning events and the SDK capture layer would never see them.
      await initSDK();
      const onProgress = vi.fn();
      mockDeepRun.mockImplementation(async (opts: any) => {
        opts.observer.onPlanningSuccess({ action: 'delegate', researchers: [{}, {}] });
        return 'deep result';
      });
      await runDeepResearch('q', { observer: { onProgress } } as any);
      expect(onProgress).toHaveBeenCalledWith('planning_success', { plan: { action: 'delegate', researchers: [{}, {}] } });
      expect(getLastResearcherOutcome()!.planned).toBe(2);
    });
  });

  describe('shutdown mid-run (telemetry generation guard)', () => {
    it('a run settling after shutdownResearchSDK() cannot resurrect telemetry into the next lifetime', async () => {
      // Regression: a run in flight during shutdown settled AFTER _doShutdown wiped the
      // _last* accessors and cleared session metrics; its catch/finally repopulated them,
      // so after a re-init the SDK reported a phantom run from the previous lifetime.
      await initSDK();
      let rejectRun!: (e: Error) => void;
      mockDeepRun.mockImplementation(() => new Promise<string>((_res, rej) => { rejectRun = rej; }));
      const recordSpy = vi.spyOn(metrics, 'recordRunSummary');
      const runPromise = runDeepResearch('q');
      await new Promise((r) => setImmediate(r)); // let the run reach the orchestrator await
      await shutdownResearchSDK();               // wipes telemetry while the run is in flight
      recordSpy.mockClear();
      rejectRun(new Error('late failure'));
      await expect(runPromise).rejects.toThrow('late failure');
      // The stale run's catch path must not have repopulated any telemetry...
      expect(getLastRunSummary()).toBeNull();
      expect(getLastRunMetrics()).toBeNull();
      expect(getLastErrorReport()).toBeNull();
      expect(getLastResearcherOutcome()).toBeNull();
      // ...nor recorded a session run summary into the fresh lifetime.
      expect(recordSpy).not.toHaveBeenCalled();
      recordSpy.mockRestore();
    });

    it('a run settling while shutdown is IN PROGRESS cannot record telemetry into the mid-wipe session metrics', async () => {
      // Regression: the generation used to be bumped at the END of _doShutdown,
      // AFTER metrics.clearSession() and the long service-disposal awaits — a run
      // settling in that window passed the gate and wrote a phantom run-summary
      // into the just-cleared session metrics. The bump now happens at the TOP:
      // anything settling after shutdown BEGINS fails the gate.
      await initSDK();
      let rejectRun!: (e: Error) => void;
      mockDeepRun.mockImplementation(() => new Promise<string>((_res, rej) => { rejectRun = rej; }));
      const runPromise = runDeepResearch('q');
      await new Promise((r) => setImmediate(r)); // run reaches the orchestrator await

      // Stall shutdown INSIDE disposeCoreServices — after clearSession(), before
      // the old end-of-function generation bump.
      let releaseDispose!: () => void;
      vi.mocked(disposeCoreServices).mockImplementationOnce(() => new Promise<void>((res) => { releaseDispose = res; }));
      const recordSpy = vi.spyOn(metrics, 'recordRunSummary');
      const shutdownPromise = shutdownResearchSDK();
      await new Promise((r) => setImmediate(r)); // shutdown is wedged in the stalled dispose
      recordSpy.mockClear();

      rejectRun(new Error('late failure'));
      try {
        await expect(runPromise).rejects.toThrow('late failure');
        expect(recordSpy).not.toHaveBeenCalled(); // pre-fix: phantom summary recorded mid-wipe
      } finally {
        // Always release the stalled dispose — a failed assertion must not leave
        // the coalesced shutdown pending and wedge afterEach's shutdown await.
        releaseDispose();
        await shutdownPromise;
        recordSpy.mockRestore();
      }
    });

    it('a shutdown completing during the researcher-outcome capture cannot resurrect the outcome', async () => {
      // Regression: the generation gate was checked BEFORE the awaited
      // captureResearcherOutcome(), but `_lastResearcherOutcome = await …` lands
      // the assignment AFTER it — a shutdown completing inside that await window
      // wiped the accessor and was then overwritten by the stale run.
      await initSDK();
      const prevImpl = vi.mocked(getService).getMockImplementation();
      let releasePlanning!: () => void;
      vi.mocked(getService).mockImplementation(async (name: any) => {
        if (name === 'research-orchestration') return { runResearch: mockDeepRun } as any;
        if (name === 'research-synthesis-service') return { getAllReports: vi.fn().mockResolvedValue(new Map()), appendMetadata: vi.fn((r: string) => r) } as any;
        if (name === 'planning') {
          // Stall the outcome capture until the test has completed a full shutdown.
          await new Promise<void>((res) => { releasePlanning = res; });
          return { getTotalResearchersPlanned: vi.fn().mockReturnValue(3) } as any;
        }
        return {} as any;
      });
      try {
        const runPromise = runDeepResearch('q'); // orchestrator resolves 'deep result'
        // Let the run reach the stalled planning lookup inside captureResearcherOutcome.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        await shutdownResearchSDK(); // completes fully; wipes _lastResearcherOutcome

        releasePlanning(); // the stale capture settles AFTER the wipe
        await expect(runPromise).resolves.toBe('deep result');
        expect(getLastResearcherOutcome()).toBeNull(); // pre-fix: phantom outcome resurrected
      } finally {
        vi.mocked(getService).mockImplementation(prevImpl!);
      }
    });

    it('a run in the SAME lifetime still records telemetry after an unrelated earlier shutdown', async () => {
      // The guard keys on the generation captured at run START — a shutdown BEFORE the
      // run began (previous lifetime) must not suppress the new lifetime's telemetry.
      await initSDK();
      await shutdownResearchSDK();
      await initSDK();
      await runDeepResearch('q');
      expect(getLastRunSummary()).not.toBeNull();
      expect(getLastRunSummary()!.status).toBe('success');
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
