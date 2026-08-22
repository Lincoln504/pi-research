/**
 * Deep Research Orchestrator – Wait Action Handling Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeepResearchOrchestrator } from '../../../src/orchestration/deep-research-orchestrator.ts';
import { resetServiceContainer, registerService, getService } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';

// Mock the service registry
vi.mock('../../../src/core/service-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/service-registry.ts')>();
  return {
    ...actual,
    getService: vi.fn(),
  };
});

// Spy wrapper (behavior preserved): lets tests assert the wait sleep's timer is
// never unref'd — during a 'wait' that timer is the run's SOLE pending handle,
// so an unref'd one lets the process drain its event loop and exit 0 mid-run.
vi.mock('../../../src/utils/safe-unref.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/safe-unref.ts')>();
  return { ...actual, safeUnref: vi.fn(actual.safeUnref) };
});

// Mock dependencies
vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createResearchRunId: () => 'test-run-id',
  runWithLogContext: (_ctx: any, fn: any) => fn(),
}));

describe('Deep Research Orchestrator - Wait Handling', () => {
  const mockCtx = {
    cwd: '/tmp',
    model: { id: 'test-model' },
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'test-key', headers: {} })),
    },
    ui: { setWidget: vi.fn() },
  };

  const baseOptions = {
    ctx: mockCtx as any,
    model: { id: 'test-model' } as any,
    query: 'wait test',
    complexity: 1 as const, // maxRounds = 2
    sessionId: 'test-session',
    researchId: 'test-research',
  };

  let mockPlanningService: any;
  let mockOrchestrationService: any;
  let mockSynthesisService: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPlanningService = {
      name: 'planning',
      lifecycle: 'initialized',
      async initialize() {},
      async dispose() {},
      generatePlan: vi.fn(),
      updatePlanForRound: vi.fn(),
      getCurrentPlan: vi.fn(() => null),
      getTotalResearchersPlanned: vi.fn(() => 0),
      incrementTotalResearchersPlanned: vi.fn(),
      addToQueryHistory: vi.fn(),
      clearPlanningState: vi.fn(),
    };

    mockOrchestrationService = {
      name: 'research-orchestration',
      lifecycle: 'initialized',
      async initialize() {},
      async dispose() {},
      checkHealth: vi.fn().mockResolvedValue(true),
      distributeSearchResults: vi.fn().mockResolvedValue(undefined),
      runResearchers: vi.fn().mockResolvedValue(undefined),
      runSearchBurst: vi.fn().mockResolvedValue([]),
      storeLinkDescriptions: vi.fn().mockResolvedValue(undefined),
      cleanupResearchServices: vi.fn().mockResolvedValue(undefined),
    };

    mockSynthesisService = {
      name: 'research-synthesis',
      lifecycle: 'initialized',
      async initialize() {},
      async dispose() {},
      synthesize: vi.fn(),
      storeReport: vi.fn(),
      getReports: vi.fn(() => []),
      hasReports: vi.fn(() => false),
      buildFallbackSynthesis: vi.fn(() => '# Fallback'),
      clearReports: vi.fn(),
      getAllReports: vi.fn(() => new Map()),
      getAllDigests: vi.fn(() => new Map()),
      ensureCitedLinks: vi.fn((_id: string, text: string) => text),
      appendSteeringGuidance: vi.fn((text: string) => text),
      appendMetadata: vi.fn((text: string) => text),
    };

    vi.mocked(getService).mockImplementation(async (name) => {
      if (name === ServiceNames.PLANNING) return mockPlanningService;
      if (name === ServiceNames.RESEARCH_ORCHESTRATION) return mockOrchestrationService;
      if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) return mockSynthesisService;
      return null;
    });

    registerService(ServiceNames.PLANNING, () => mockPlanningService, { allowOverwrite: true });
    registerService(ServiceNames.RESEARCH_ORCHESTRATION, () => mockOrchestrationService, { allowOverwrite: true });
    registerService(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, () => mockSynthesisService, { allowOverwrite: true });
  });

  afterEach(() => {
    resetServiceContainer();
    vi.useRealTimers();
  });

  describe('Wait Retry Counter', () => {
    it('synthesizes from collected work after exceeding the wait limit (no longer throws)', async () => {
      vi.useFakeTimers();

      mockPlanningService.generatePlan.mockResolvedValue({ action: 'wait' });
      // After max wait retries the orchestrator breaks to final synthesis rather than
      // discarding the whole run; the final block calls updatePlanForRound(mustSynthesize).
      mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Synthesized after waits' });

      const orchestrator = new DeepResearchOrchestrator(baseOptions);
      const runPromise = orchestrator.run();

      // We need 6 calls to 'wait' to exceed MAX_WAIT_RETRIES (5)
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(5000);
      }
      await vi.runAllTimersAsync();

      const result = await runPromise;
      expect(result).toBe('Synthesized after waits');
    });

    it('resets wait retry counter after a successful action', async () => {
      vi.useFakeTimers();

      let call = 0;
      mockPlanningService.generatePlan.mockImplementation(async () => {
        call++;
        if (call === 1) return { action: 'wait' };
        return { action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }], allQueries: ['q1'] };
      });
      mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Success' });

      const orchestrator = new DeepResearchOrchestrator(baseOptions);
      const runPromise = orchestrator.run();

      await vi.advanceTimersByTimeAsync(5000); // Resolves first wait
      await vi.runAllTimersAsync();

      const result = await runPromise;
      expect(result).toBe('Success');
      expect(call).toBe(2);
    });
  });

  describe('Wait Sleep Liveness', () => {
    it('keeps the 5s wait timer REFERENCED — never unref\'d', async () => {
      // Regression (unref'd-semaphore incident class): the wait sleep IS the
      // run's only pending operation at that moment. safeUnref on it let Node
      // drain the event loop and exit 0 silently mid-run when no other
      // referenced handle existed.
      vi.useFakeTimers();
      const { safeUnref } = await import('../../../src/utils/safe-unref.ts');
      vi.mocked(safeUnref).mockClear();

      let call = 0;
      mockPlanningService.generatePlan.mockImplementation(async () => {
        call++;
        if (call === 1) return { action: 'wait' };
        return { action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }], allQueries: ['q1'] };
      });
      mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'ok' });

      const orchestrator = new DeepResearchOrchestrator(baseOptions);
      const runPromise = orchestrator.run();

      await vi.advanceTimersByTimeAsync(5000); // resolves the wait sleep
      await vi.runAllTimersAsync();
      await runPromise;

      expect(vi.mocked(safeUnref)).not.toHaveBeenCalled();
    });
  });

  describe('Once-Per-Round Events Across Wait Retries', () => {
    it("emits evaluation_start and runs the health probe exactly once for a round that waits then decides", async () => {
      // A 'wait' decision decrements the round and re-enters the loop to run the
      // SAME round again. Pre-fix, every re-entry re-emitted round_start /
      // evaluation_start (2, 2, 2 for one round-2 evaluation — consumers counting
      // evaluations got duplicates) and re-ran the full infrastructure health
      // probe it had just run. firstEntryThisRound gates all three per round.
      vi.useFakeTimers();

      const observer = {
        onRoundStart: vi.fn(),
        onEvaluationStart: vi.fn(),
      };

      // Round 1 delegates; round 2's router waits once, then chooses synthesize.
      mockPlanningService.generatePlan.mockResolvedValue({
        action: 'delegate',
        researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
        allQueries: ['q1'],
      });
      let routerCall = 0;
      mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
        if (opts?.mustSynthesize) return { action: 'synthesize', content: 'Final' };
        routerCall++;
        if (routerCall === 1) return { action: 'wait' };
        return { action: 'synthesize', content: '' };
      });

      // complexity 2 -> maxRounds 3, so round 2 genuinely evaluates instead of
      // breaking straight to the forced final synthesis.
      const orchestrator = new DeepResearchOrchestrator({
        ...baseOptions,
        complexity: 2 as const,
        observer: observer as any,
      });
      const runPromise = orchestrator.run();

      await vi.advanceTimersByTimeAsync(5000); // round 2's wait sleep
      await vi.runAllTimersAsync();
      const result = await runPromise;
      expect(result).toBe('Final');
      expect(routerCall).toBe(2); // the wait retry did re-invoke the router

      // Exactly ONE evaluation_start for round 2, none for the wait re-entry.
      expect(observer.onEvaluationStart).toHaveBeenCalledTimes(1);
      expect(observer.onEvaluationStart).toHaveBeenCalledWith(2);

      // Health probe once per round (rounds 1 and 2) — the wait retry re-enters
      // round 2 without re-probing.
      expect(mockOrchestrationService.checkHealth).toHaveBeenCalledTimes(2);
      expect(mockOrchestrationService.checkHealth.mock.calls[0][0]).toBe(1);
      expect(mockOrchestrationService.checkHealth.mock.calls[1][0]).toBe(2);

      // round_start follows the same once-per-round contract.
      expect(observer.onRoundStart.mock.calls.map((c: any[]) => c[0])).toEqual([1, 2]);
    });
  });

  describe('Integration Behavior', () => {
    it('completes successfully when waits are interleaved', async () => {
      vi.useFakeTimers();

      let gpCall = 0;
      let upfrCall = 0;
      mockPlanningService.generatePlan.mockImplementation(async () => {
        gpCall++;
        if (gpCall === 1) return { action: 'wait' };
        return { action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }], allQueries: ['q1'] };
      });
      // Mirror the real PlanningService: `mustSynthesize` FORCES action to
      // 'synthesize' (planning-service.ts), so the forced final call can never come
      // back as a 'wait'. Without honouring that here the mock's call counter, not
      // the orchestrator, decides the outcome.
      mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
        if (opts?.mustSynthesize) return { action: 'synthesize', content: 'Interleaved' };
        upfrCall++;
        if (upfrCall === 1) return { action: 'wait' };
        return { action: 'synthesize', content: 'Interleaved' };
      });

      const orchestrator = new DeepResearchOrchestrator(baseOptions);
      const runPromise = orchestrator.run();

      await vi.advanceTimersByTimeAsync(5000); // Round 1 wait
      await vi.runAllTimersAsync();
      await vi.advanceTimersByTimeAsync(5000); // Round 2 wait
      await vi.runAllTimersAsync();

      const result = await runPromise;
      expect(result).toBe('Interleaved');
    });
  });
});