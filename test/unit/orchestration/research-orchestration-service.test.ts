import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResearchOrchestrationService } from '../../../src/orchestration/research-orchestration-service.ts';
import { ServiceLifecycle } from '../../../src/core/service-registry.ts';

// Mock logger
vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  resetLogger: vi.fn(),
}));

// Session-teardown helper invoked at the tail of cleanupResearchServices.
vi.mock('../../../src/infrastructure/browser/browser-error-utils.ts', () => ({
  clearSessionCircuitBreaker: vi.fn(),
}));

// Mock constants
vi.mock('../../../src/constants.ts', () => ({
  RESEARCHER_LAUNCH_DELAY_MS: 0,
}));

// Mock search
vi.mock('../../../src/web-research/search.ts', () => ({
  search: vi.fn(),
}));

// Mock healthRegistry
vi.mock('../../../src/healthcheck/index.ts', () => ({
  healthRegistry: { runAll: vi.fn(), isCritical: vi.fn(() => true) },
}));

// Mock other imports that are not under test. Partial mock (keep real exports
// such as normalizeWorkspacePath, which getConfig() needs during cleanup).
vi.mock('../../../src/utils/text-utils.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/text-utils.ts')>()),
  parseCitations: vi.fn(() => []),
}));

vi.mock('../../../src/utils/shared-links.ts', () => ({
  getCachedScrapedContent: vi.fn(() => null),
  normalizeUrl: vi.fn((url: string) => url),
  cleanupSharedLinks: vi.fn(),
}));

vi.mock('../../../src/core/service-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/service-registry.ts')>();
  return {
    ...actual,
    getService: vi.fn(),
    tryGetServiceContainerFromCtx: vi.fn((ctx: any) => ctx?.container || { isReady: true }),
  };
});

vi.mock('../../../src/orchestration/researcher-executor.ts', () => ({
  runResearcher: vi.fn(),
}));

vi.mock('../../../src/orchestration/session-state.ts', () => ({
  recordResearcherFailure: vi.fn(),
  shouldStopResearch: vi.fn(() => false),
  getResearchStopMessage: vi.fn(() => 'Research stopped: 0 researcher(s) failed: '),
  createResearchStopError: vi.fn(),
}));

// ---------------------------------------------------------------------------

import { search } from '../../../src/web-research/search.ts';
import { healthRegistry } from '../../../src/healthcheck/index.ts';
import { getService } from '../../../src/core/service-registry.ts';
import { parseCitations } from '../../../src/utils/text-utils.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';
import { runResearcher } from '../../../src/orchestration/researcher-executor.ts';
import { recordResearcherFailure, shouldStopResearch, createResearchStopError } from '../../../src/orchestration/session-state.ts';

const mockSearch = search as ReturnType<typeof vi.fn>;
const mockRunAll = healthRegistry.runAll as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------

describe('ResearchOrchestrationService', () => {
  let service: ResearchOrchestrationService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new ResearchOrchestrationService();
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  describe('lifecycle', () => {
    it('starts UNINITIALIZED', () => {
      expect(service.lifecycle).toBe(ServiceLifecycle.UNINITIALIZED);
    });

    it('is INITIALIZED after initialize()', async () => {
      await service.initialize();
      expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
    });

    it('is DISPOSED after dispose()', async () => {
      await service.initialize();
      await service.dispose();
      expect(service.lifecycle).toBe(ServiceLifecycle.DISPOSED);
    });
  });

  // =========================================================================
  // distributeSearchResults
  // =========================================================================

  describe('distributeSearchResults', () => {
    it('single researcher with 2 queries, each returning 2 results — gets 4 unique URLs', async () => {
      const plan = {
        researchers: [
          { id: 'r1', queries: ['q1', 'q2'] },
        ],
      };
      const results = [
        { query: 'q1', results: [{ url: 'https://a.com' }, { url: 'https://b.com' }] },
        { query: 'q2', results: [{ url: 'https://c.com' }, { url: 'https://d.com' }] },
      ];

      const map = await service.distributeSearchResults(plan as any, results as any);

      expect(map.get('r1')).toHaveLength(4);
      expect(map.get('r1')).toEqual(
        expect.arrayContaining(['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com'])
      );
    });
  });

  // =========================================================================
  // runSearchBurst
  // =========================================================================

  describe('runSearchBurst', () => {
    it('returns results from mocked search and logs total count', async () => {
      const fakeResults = [
        { query: 'foo', results: [{ url: 'https://x.com' }, { url: 'https://y.com' }] },
        { query: 'bar', results: [{ url: 'https://z.com' }] },
      ];
      mockSearch.mockResolvedValue(fakeResults);

      const out = await service.runSearchBurst(['foo', 'bar'], {} as any);

      expect(out).toBe(fakeResults);
      expect(mockSearch).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // checkHealth
  // =========================================================================

  describe('checkHealth', () => {
    beforeEach(() => {
        vi.mocked(getService).mockImplementation(async (name) => {
            if (name === ServiceNames.HEALTH_REGISTRY) return healthRegistry as any;
            return null;
        });
    });

    // checkHealth is ADVISORY: it returns void and never aborts the run. These
    // tests assert it logs status and tolerates every outcome without throwing.

    it('round 1: skips the health check entirely (no runAll)', async () => {
      await expect(service.checkHealth(1)).resolves.toBeUndefined();
      expect(mockRunAll).not.toHaveBeenCalled();
    });

    it('round 2 with healthy status: runs the check and resolves', async () => {
      mockRunAll.mockResolvedValue({ status: 'healthy', components: [] });

      await expect(service.checkHealth(2, 'res-123')).resolves.toBeUndefined();
      expect(mockRunAll).toHaveBeenCalledOnce();
    });

    it('round 2 with degraded status: resolves (research continues)', async () => {
      mockRunAll.mockResolvedValue({
        status: 'degraded',
        components: [{ component: 'search', healthy: false }],
      });

      await expect(service.checkHealth(2, 'res-123')).resolves.toBeUndefined();
    });

    it('never aborts on repeated unhealthy results — no hard-fail after N strikes', async () => {
      mockRunAll.mockResolvedValue({
        status: 'unhealthy',
        components: [{ component: 'db', healthy: false }],
      });

      // Any number of consecutive unhealthy rounds must all resolve (advisory).
      for (const round of [2, 3, 4, 5]) {
        await expect(service.checkHealth(round, 'res-1')).resolves.toBeUndefined();
      }
    });

    it('healthRegistry.runAll() throws: swallowed (non-fatal)', async () => {
      mockRunAll.mockRejectedValue(new Error('registry exploded'));

      await expect(service.checkHealth(3)).resolves.toBeUndefined();
    });

    it('already-aborted signal: never starts the probe', async () => {
      const c = new AbortController();
      c.abort();
      await expect(service.checkHealth(2, 'res-1', undefined, c.signal)).resolves.toBeUndefined();
      expect(mockRunAll).not.toHaveBeenCalled();
    });

    it('signal firing mid-probe: resolves immediately, probe abandoned in background', async () => {
      let release!: (v: unknown) => void;
      mockRunAll.mockReturnValue(new Promise((resolve) => { release = resolve; }));
      const c = new AbortController();

      const pending = service.checkHealth(2, 'res-1', undefined, c.signal);
      c.abort();
      await expect(pending).resolves.toBeUndefined();

      // The probe itself keeps draining and must not reject unhandled.
      release({ status: 'healthy', components: [] });
      await Promise.resolve();
    });
  });

  // =========================================================================
  // storeLinkDescriptions
  // =========================================================================

  describe('storeLinkDescriptions', () => {
    const mockSynthesisService = {
      getAllReports: vi.fn(),
    };

    const mockWriter = {
      enqueue: vi.fn(),
      drain: vi.fn().mockResolvedValue(undefined),
    };

    const mockKnowledgeStoreService = {
        isReady: vi.fn().mockReturnValue(true),
        getStore: vi.fn().mockResolvedValue({
            rebuildFtsIndex: vi.fn().mockResolvedValue(undefined),
        }),
        getWriterQueue: vi.fn().mockResolvedValue(mockWriter),
    };

    beforeEach(() => {
      vi.mocked(getService).mockImplementation(async (name) => {
        if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) return mockSynthesisService as any;
        if (name === ServiceNames.KNOWLEDGE_STORE) return mockKnowledgeStoreService as any;
        return null;
      });
    });

    it('returns early if knowledge store is not ready', async () => {
      const mockNotReadyKS = { ...mockKnowledgeStoreService, isReady: vi.fn().mockReturnValue(false) };
      vi.mocked(getService).mockImplementation(async (name) => {
        if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) return mockSynthesisService as any;
        if (name === ServiceNames.KNOWLEDGE_STORE) return mockNotReadyKS as any;
        return null;
      });

      await service.storeLinkDescriptions('s1', 1, 'r1', {} as any);
      expect(mockSynthesisService.getAllReports).not.toHaveBeenCalled();
    });

    it('returns early WITHOUT resolving the knowledge store when mode is none', async () => {
      // With KNOWLEDGE_STORE_MODE='none' the deep orchestrator must never resolve
      // the knowledge-store service — doing so loads the native @lancedb binding,
      // which throws on platforms that ship no prebuilt (e.g. Intel macOS) and
      // contradicts the user's explicit opt-out.
      const ksSpy = vi.fn();
      vi.mocked(getService).mockImplementation(async (name) => {
        if (name === ServiceNames.KNOWLEDGE_STORE) { ksSpy(); return mockKnowledgeStoreService as any; }
        if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) return mockSynthesisService as any;
        return null;
      });

      await service.storeLinkDescriptions('s1', 1, 'r1', { KNOWLEDGE_STORE_MODE: 'none' } as any);

      expect(ksSpy).not.toHaveBeenCalled();
      expect(mockSynthesisService.getAllReports).not.toHaveBeenCalled();
    });

    it('enqueues citations from reports matching the round prefix', async () => {
      const localMockWriter = {
        enqueue: vi.fn(),
        drain: vi.fn().mockResolvedValue(undefined),
      };
      const localMockKS = {
        isReady: () => true,
        getStore: vi.fn().mockResolvedValue({
          rebuildFtsIndex: vi.fn().mockResolvedValue(undefined),
        }),
        getWriterQueue: vi.fn().mockResolvedValue(localMockWriter),
      };

      vi.mocked(getService).mockImplementation(async (name: any) => {
        if (name === ServiceNames.KNOWLEDGE_STORE) return localMockKS as any;
        if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) return mockSynthesisService as any;
        return null;
      });

      const config = { KNOWLEDGE_STORE_MODE: 'project' };
      const reportContent = 'CITED LINKS\n[1] https://foo.com\nSource: X\nDescription: D';
      const reports = new Map([
        ['1.res1', reportContent],
        ['2.res2', 'other round'],
      ]);
      
      mockSynthesisService.getAllReports.mockReturnValue(reports);
      vi.mocked(parseCitations).mockReturnValue([{ url: 'https://foo.com', description: 'D', source: 'X' }]);

      await service.storeLinkDescriptions('s1', 1, 'r1', config as any);

      expect(localMockWriter.enqueue).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // cleanupResearchServices — FTS rebuild + optimize gating
  // =========================================================================

  describe('cleanupResearchServices knowledge maintenance', () => {
    function mockStore(rebuilt: boolean) {
      const store = {
        rebuildFtsIndex: vi.fn().mockResolvedValue(rebuilt),
        optimize: vi.fn().mockResolvedValue(true),
      };
      const ksService = { isReady: () => true, getStore: vi.fn().mockResolvedValue(store) };
      vi.mocked(getService).mockImplementation(async (name: any) => {
        if (name === ServiceNames.KNOWLEDGE_STORE) return ksService as any;
        return null;
      });
      return store;
    }

    // Use the repo cwd, which resolves to the default KNOWLEDGE_STORE_MODE ('global')
    // so the cleanup path resolves the store instead of skipping it. The
    // container.tryGet stub lets the later synthesis/planning cleanup steps no-op.
    const ctx = { cwd: process.cwd(), container: { tryGet: () => undefined } };

    it('runs optimize() after a rebuild that actually ran (data changed)', async () => {
      const store = mockStore(true);
      await service.cleanupResearchServices('s1', 'r1', ctx);
      expect(store.rebuildFtsIndex).toHaveBeenCalledTimes(1);
      expect(store.optimize).toHaveBeenCalledTimes(1);
    });

    it('skips optimize() when the FTS rebuild was a no-op (count unchanged)', async () => {
      const store = mockStore(false);
      await service.cleanupResearchServices('s1', 'r1', ctx);
      expect(store.rebuildFtsIndex).toHaveBeenCalledTimes(1);
      expect(store.optimize).not.toHaveBeenCalled();
    });

    it('skips BOTH rebuild and optimize when skipStoreMaintenance is set (aborted run)', async () => {
      // Esc mid-run must not pay for a full FTS rebuild + optimize before returning.
      // Rows already committed to LanceDB stay durable; the next run's cleanup rebuilds.
      const store = mockStore(true);
      await service.cleanupResearchServices('s1', 'r1', ctx, undefined, { skipStoreMaintenance: true });
      expect(store.rebuildFtsIndex).not.toHaveBeenCalled();
      expect(store.optimize).not.toHaveBeenCalled();
    });

    it('still performs maintenance when skipStoreMaintenance is explicitly false', async () => {
      const store = mockStore(true);
      await service.cleanupResearchServices('s1', 'r1', ctx, undefined, { skipStoreMaintenance: false });
      expect(store.rebuildFtsIndex).toHaveBeenCalledTimes(1);
      expect(store.optimize).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // runResearchers — cancellation classification & bounded fast-stop abort
  // =========================================================================

  describe('runResearchers', () => {
    const RESEARCHER = { id: '1', name: 'R1', goal: 'g', queries: [] };

    function makeRunOptions(observer?: any, abortAllSessions: () => Promise<void> = vi.fn(async () => {})) {
      vi.mocked(getService).mockImplementation(async (name: any) => {
        if (name === ServiceNames.PLANNING) return { getCurrentPlan: vi.fn(() => null) } as any;
        if (name === ServiceNames.RESEARCH_SESSION_SERVICE) return { abortAllSessions } as any;
        return null;
      });
      return {
        plan: { researchers: [RESEARCHER] },
        options: {
          sessionId: 's1',
          researchId: 'r1',
          query: 'q',
          complexity: 1,
          ctx: { cwd: process.cwd(), container: { tryGet: () => undefined } },
          model: { id: 'm' },
          config: { MAX_CONCURRENT_RESEARCHERS: 3, MAX_FAILED_RESEARCHERS: 2 },
          observer,
        },
        currentRound: 1,
        signal: undefined,
      } as any;
    }

    it('classifies the id-prefixed Aborted sentinel as a clean cancel — no failure record, no red slice', async () => {
      // The executor rethrows the '<id>: Aborted' sentinel after a fast-stop
      // abortAllSessions() aborted the session externally. The exact-equality
      // check here used to record it as a researcher failure (counting toward
      // the very threshold that triggered the stop) and paint the slice red.
      vi.mocked(shouldStopResearch).mockReturnValue(false);
      vi.mocked(runResearcher).mockRejectedValue(new Error('1: Aborted'));
      const onResearcherFailure = vi.fn();

      await service.runResearchers(makeRunOptions({ onResearcherFailure }));

      expect(recordResearcherFailure).not.toHaveBeenCalled();
      expect(onResearcherFailure).not.toHaveBeenCalled();
    });

    it('still records a genuine researcher failure with its root cause', async () => {
      vi.mocked(shouldStopResearch).mockReturnValue(false);
      vi.mocked(runResearcher).mockRejectedValue(new Error('provider exploded'));
      const onResearcherFailure = vi.fn();

      await service.runResearchers(makeRunOptions({ onResearcherFailure }));

      expect(recordResearcherFailure).toHaveBeenCalledWith('s1', 'r1', '1', 'provider exploded');
      expect(onResearcherFailure).toHaveBeenCalledWith('1', 'provider exploded');
    });

    it('classifies a container-disposal error as clean teardown — no failure record, no red slice', async () => {
      // SIGTERM mid-run disposes the container; the executor rethrows
      // "Cannot get service … during container disposal". Recording that as a
      // researcher failure painted red slices with bogus root causes and could
      // trip shouldStopResearch during shutdown.
      vi.mocked(shouldStopResearch).mockReturnValue(false);
      vi.mocked(runResearcher).mockRejectedValue(new Error("Cannot get service 'research-synthesis-service' during container disposal"));
      const onResearcherFailure = vi.fn();

      await service.runResearchers(makeRunOptions({ onResearcherFailure }));

      expect(recordResearcherFailure).not.toHaveBeenCalled();
      expect(onResearcherFailure).not.toHaveBeenCalled();
    });

    it('classifies any researcher error as clean teardown while the container is disposing', async () => {
      vi.mocked(shouldStopResearch).mockReturnValue(false);
      vi.mocked(runResearcher).mockRejectedValue(new Error('worker pool destroyed mid-teardown'));
      const onResearcherFailure = vi.fn();
      const opts = makeRunOptions({ onResearcherFailure });
      opts.options.ctx.container = { tryGet: () => undefined, isDisposing: true };

      await service.runResearchers(opts);

      expect(recordResearcherFailure).not.toHaveBeenCalled();
      expect(onResearcherFailure).not.toHaveBeenCalled();
    });

    it('fast-stop bound-awaits in-flight researchers before throwing the stop error', async () => {
      // Regression (zombie researchers): the stop error used to propagate — and
      // release the run-cap slot — while unregistered researchers were still in
      // flight; they then ran full LLM sessions after the run had returned. The
      // stop must first give the active set a bounded chance to self-stop.
      let resolveResearcher!: () => void;
      vi.mocked(runResearcher).mockImplementation(() => new Promise<void>((res) => { resolveResearcher = res; }));
      vi.mocked(shouldStopResearch)
        .mockReturnValueOnce(false) // pre-launch check: let the researcher start
        .mockReturnValue(true);     // post-stagger check: threshold crossed while in flight
      vi.mocked(createResearchStopError).mockImplementation(
        () => Object.assign(new Error('Research stopped'), { code: 'RESEARCH_STOPPED' }),
      );

      let settled = false;
      const run = service.runResearchers(makeRunOptions()).catch((e) => { settled = true; return e; });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(settled).toBe(false); // pre-fix: threw without awaiting the in-flight researcher

      resolveResearcher();
      const err = await run;
      expect(settled).toBe(true);
      expect((err as Error).message).toBe('Research stopped');
    });

    it('fast-stop still throws within the bound when an in-flight researcher never settles', async () => {
      // The active-set await is bounded like boundSessionAbort: one wedged
      // researcher must not hang the already-decided stop.
      vi.useFakeTimers();
      try {
        vi.mocked(runResearcher).mockImplementation(() => new Promise<void>(() => { /* never settles */ }));
        vi.mocked(shouldStopResearch).mockReturnValueOnce(false).mockReturnValue(true);
        vi.mocked(createResearchStopError).mockImplementation(
          () => Object.assign(new Error('Research stopped'), { code: 'RESEARCH_STOPPED' }),
        );

        const run = service.runResearchers(makeRunOptions());
        const expectation = expect(run).rejects.toThrow('Research stopped');
        await vi.advanceTimersByTimeAsync(10_001);
        await expectation;
      } finally {
        vi.useRealTimers();
      }
    });

    it('suppresses failure recording for a researcher that settles AFTER the fast-stop terminal error', async () => {
      // Regression (runTerminated guard): a researcher wedged past the bounded
      // fast-stop waits is ABANDONED by the stop — its promise settles after the
      // run's single terminal error has propagated (and, on the tool path, after
      // endResearchSession freed the session state). Pre-guard, its late
      // rejection still hit recordResearcherFailure (re-creating the just-freed
      // session entry via create-on-read — a process-lifetime leak on random
      // per-run sessionIds) and fired onResearcherFailure after the terminal
      // event, violating the no-events-after-terminal contract.
      vi.useFakeTimers();
      let rejectResearcher!: (err: Error) => void;
      const onResearcherFailure = vi.fn();
      try {
        vi.mocked(runResearcher).mockImplementation(
          () => new Promise<void>((_res, rej) => { rejectResearcher = rej; }),
        );
        vi.mocked(shouldStopResearch)
          .mockReturnValueOnce(false) // pre-launch check: let the researcher start
          .mockReturnValue(true);     // post-launch check: threshold crossed while in flight
        vi.mocked(createResearchStopError).mockImplementation(
          () => Object.assign(new Error('Research stopped'), { code: 'RESEARCH_STOPPED' }),
        );

        const run = service.runResearchers(makeRunOptions({ onResearcherFailure }));
        const expectation = expect(run).rejects.toThrow('Research stopped');
        // Fire the bounded active-set wait; the stop error propagates with the
        // researcher still pending.
        await vi.advanceTimersByTimeAsync(10_001);
        await expectation;
      } finally {
        vi.useRealTimers();
      }

      // The abandoned researcher now fails, post-terminal. Nothing may be
      // recorded or observed for it.
      rejectResearcher(new Error('provider exploded late'));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(recordResearcherFailure).not.toHaveBeenCalled();
      expect(onResearcherFailure).not.toHaveBeenCalled();
    });

    it('fast-stop throws the STOP error — not the raw service error — when getService rejects during disposal', async () => {
      // shouldStopResearch tripping DURING teardown: the unguarded getService at
      // the fast-stop site threw "Cannot get service … during container disposal",
      // replacing the already-decided stop error.
      vi.mocked(shouldStopResearch).mockReturnValue(true);
      vi.mocked(createResearchStopError).mockImplementation(
        () => Object.assign(new Error('Research stopped'), { code: 'RESEARCH_STOPPED' }),
      );
      const opts = makeRunOptions();
      vi.mocked(getService).mockImplementation(async (name: any) => {
        if (name === ServiceNames.PLANNING) return { getCurrentPlan: vi.fn(() => null) } as any;
        if (name === ServiceNames.RESEARCH_SESSION_SERVICE) throw new Error("Cannot get service 'session-service' during container disposal");
        return null;
      });

      await expect(service.runResearchers(opts)).rejects.toThrow('Research stopped');
    });

    it('fast-stop throws within the bound even when abortAllSessions never settles', async () => {
      // The fast-stop throw used to gate on an UNBOUNDED await of
      // abortAllSessions(); one wedged session.abort() hung the run forever
      // with the stop error already decided.
      vi.useFakeTimers();
      try {
        vi.mocked(shouldStopResearch).mockReturnValue(true);
        vi.mocked(createResearchStopError).mockImplementation(
          () => Object.assign(new Error('Research stopped'), { code: 'RESEARCH_STOPPED' }),
        );
        const wedgedAbortAll = vi.fn(() => new Promise<void>(() => { /* never settles */ }));

        const run = service.runResearchers(makeRunOptions(undefined, wedgedAbortAll));
        const expectation = expect(run).rejects.toThrow('Research stopped');

        // Fire the 10s abort-settle bound; the throw must proceed past the wedge.
        await vi.advanceTimersByTimeAsync(10_001);

        await expectation;
        expect(wedgedAbortAll).toHaveBeenCalledWith('r1');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
