/**
 * Deep Research Orchestrator – Wait Action Handling Tests
 *
 * These tests exercise the *actual* orchestrator through the same mock
 * infrastructure used by deep-research-orchestrator.test.ts. They focus
 * specifically on the 'wait' action path:
 *
 *   - waitRetryCount is incremented each time the evaluator returns 'wait'
 *   - After MAX_WAIT_RETRIES (5) consecutive waits it throws a descriptive error
 *   - The counter resets to 0 after any successful non-wait action
 *   - A pre-aborted signal causes the wait sleep to throw immediately
 *   - Passing a signal that is aborted *during* the sleep rejects the run promise
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeepResearchOrchestrator } from '../../../src/orchestration/deep-research-orchestrator.ts';
import { resetServiceContainer, registerService, getService } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Module-level mocks (hoisted by vitest before any imports)
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../../../src/core/service-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/service-registry.ts')>();
  return { ...actual, getService: vi.fn() };
});

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createResearchRunId: () => 'test-run-id',
  runWithLogContext: (_ctx: any, fn: any) => fn(),
}));

vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({
    KNOWLEDGE_STORE_ENABLED: false,
    MAX_CONCURRENT_RESEARCHERS: 3,
    RESEARCHER_MAX_RETRIES: 2,
    RESEARCHER_MAX_RETRY_DELAY_MS: 5000,
    RESEARCHER_TIMEOUT_MS: 120000,
  })),
  DEFAULTS: { KNOWLEDGE_STORE_ENABLED: false },
}));

vi.mock('../../../src/orchestration/research-session-manager.ts', () => ({
  getResearchSynthesisService: vi.fn(() => Promise.resolve({
    synthesize: vi.fn(),
    storeReport: vi.fn(),
    getReports: vi.fn(() => []),
    hasReports: vi.fn(() => false),
    buildFallbackSynthesis: vi.fn(() => '# Fallback'),
    clearReports: vi.fn(),
    getAllReports: vi.fn(() => new Map()),
    getReport: vi.fn(),
    getReportsForRound: vi.fn(() => new Map()),
    getReportCount: vi.fn(() => 0),
    ensureCitedLinks: vi.fn((text: string) => text),
  })),
  getResearchSessionService: vi.fn(() => Promise.resolve({
    registerSession: vi.fn(), getSession: vi.fn(), hasSession: vi.fn(),
    unregisterSession: vi.fn(), abortSession: vi.fn(), abortAllSessions: vi.fn(),
    cleanup: vi.fn(), reset: vi.fn(),
    getActiveSessionCount: vi.fn(() => 0), getActiveSessionIds: vi.fn(() => []),
  })),
  resetResearchServices: vi.fn(() => Promise.resolve()),
  cleanupResearchServices: vi.fn(() => Promise.resolve()),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Shared test fixtures
// ─────────────────────────────────────────────────────────────────────────────

describe('Deep Research Orchestrator - Wait Handling', () => {
  const mockCtx = {
    cwd: '/tmp',
    model: { id: 'test-model' },
    modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'key', headers: {} })) },
    ui: { setWidget: vi.fn() },
  };

  const baseOptions = {
    ctx: mockCtx as any,
    model: { id: 'test-model' } as any,
    query: 'wait test query',
    complexity: 1 as const,
    sessionId: 'test-session',
    researchId: 'test-research',
  };

  let mockPlanningService: any;
  let mockOrchestrationService: any;

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
    };

    vi.mocked(getService).mockImplementation(async (name) => {
      if (name === ServiceNames.PLANNING) return mockPlanningService;
      if (name === ServiceNames.RESEARCH_ORCHESTRATION) return mockOrchestrationService;
      return null;
    });

    registerService(ServiceNames.PLANNING, () => mockPlanningService,
      { lazyInitialization: false, allowOverwrite: true, enableLogging: false });
    registerService(ServiceNames.RESEARCH_ORCHESTRATION, () => mockOrchestrationService,
      { lazyInitialization: false, allowOverwrite: true, enableLogging: false });
  });

  afterEach(() => {
    resetServiceContainer();
    vi.useRealTimers();
  });

  // ─── Wait counter and MAX_WAIT_RETRIES enforcement ───────────────────────

  describe('Wait Retry Counter', () => {
    it('throws descriptive error after 5 consecutive wait actions (MAX_WAIT_RETRIES)', async () => {
      vi.useFakeTimers();

      // evaluator always returns 'wait'
      mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'wait' });

      const orchestrator = new DeepResearchOrchestrator(baseOptions);
      const runPromise = orchestrator.run();
      // Suppress unhandled-rejection warning: the promise rejects via timer
      // callbacks before await expect(...).rejects gets to add its own handler.
      runPromise.catch(() => {});

      // Advance through 5 × 5 s sleeps so each wait iteration can complete
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(5000);
      }

      await expect(runPromise).rejects.toThrow('Max wait retries');
      await expect(runPromise).rejects.toThrow('5');
      await expect(runPromise).rejects.toThrow('research coordinator');
    });

    it('resets wait retry counter after a successful delegate action and completes', async () => {
      vi.useFakeTimers();

      // Sequence: wait, wait, delegate, synthesize
      let call = 0;
      mockPlanningService.updatePlanForRound.mockImplementation(async () => {
        call++;
        if (call <= 2) return { action: 'wait' };
        if (call === 3) return {
          action: 'delegate',
          researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
          allQueries: ['q1'],
        };
        return { action: 'synthesize', content: 'Reset counter result' };
      });

      const orchestrator = new DeepResearchOrchestrator(baseOptions);
      const runPromise = orchestrator.run();

      // Advance through 2 wait sleeps
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);
      // Allow the remaining async actions to drain
      await vi.runAllTimersAsync();

      const result = await runPromise;
      expect(result).toBe('Reset counter result');
    });

    it('counter increments correctly: throws only after 5 consecutive waits, not after reset', async () => {
      vi.useFakeTimers();

      // sequence: wait×3, delegate (resets counter), wait×5 (throws at 6th wait)
      let call = 0;
      mockPlanningService.updatePlanForRound.mockImplementation(async () => {
        call++;
        if (call <= 3) return { action: 'wait' };
        if (call === 4) return {
          action: 'delegate',
          researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
          allQueries: ['q1'],
        };
        // After the delegate, always return wait again → should eventually throw
        return { action: 'wait' };
      });

      const orchestrator = new DeepResearchOrchestrator({ ...baseOptions, complexity: 3 });
      const runPromise = orchestrator.run();
      runPromise.catch(() => {}); // suppress unhandled-rejection before expect() catches it

      // Advance through all sleeps liberally
      for (let i = 0; i < 15; i++) {
        await vi.advanceTimersByTimeAsync(5000);
      }

      await expect(runPromise).rejects.toThrow('Max wait retries');
    });
  });

  // ─── Abort signal during wait ─────────────────────────────────────────────

  describe('Abort Signal During Wait', () => {
    it('throws immediately when signal is already aborted before the first round starts', async () => {
      // The orchestrator checks signal.aborted at the very top of the while-loop,
      // before calling updatePlanForRound.  A pre-aborted signal should therefore
      // throw 'Research aborted' without any timer involvement or planning calls.
      mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'wait' });

      const controller = new AbortController();
      controller.abort(); // pre-abort

      const orchestrator = new DeepResearchOrchestrator(baseOptions);
      await expect(orchestrator.run(controller.signal)).rejects.toThrow('Research aborted');
      // updatePlanForRound should NOT have been called — the loop exits before it
      expect(mockPlanningService.updatePlanForRound).not.toHaveBeenCalled();
    });

    it('throws Research cancelled when signal is aborted during the 5 s sleep', async () => {
      vi.useFakeTimers();

      mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'wait' });

      const controller = new AbortController();
      const orchestrator = new DeepResearchOrchestrator(baseOptions);
      const runPromise = orchestrator.run(controller.signal);
      runPromise.catch(() => {}); // suppress unhandled-rejection before expect() catches it

      // Advance just enough to enter the sleep promise but not resolve it
      await vi.advanceTimersByTimeAsync(100);
      // Now abort — the abort listener inside the sleep rejects the promise
      controller.abort();
      await vi.advanceTimersByTimeAsync(100);

      await expect(runPromise).rejects.toThrow('Research cancelled');
    });
  });

  // ─── State machine logic (wait/delegate/synthesize interleaving) ──────────

  describe('Integration Behavior — wait/delegate/synthesize interleaving', () => {
    it('completes successfully when waits are interleaved with delegate and synthesize', async () => {
      vi.useFakeTimers();

      // wait, wait, research, wait (counter reset after research → 1), synthesize
      let call = 0;
      mockPlanningService.updatePlanForRound.mockImplementation(async () => {
        call++;
        const sequence: Record<number, any> = {
          1: { action: 'wait' },
          2: { action: 'wait' },
          3: { action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }], allQueries: ['q1'] },
          4: { action: 'wait' },
        };
        return sequence[call] ?? { action: 'synthesize', content: 'Interleaved result' };
      });

      const orchestrator = new DeepResearchOrchestrator(baseOptions);
      const runPromise = orchestrator.run();

      // Advance through 3 wait sleeps (2 before delegate, 1 after)
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(5000);
      }
      await vi.runAllTimersAsync();

      const result = await runPromise;
      expect(result).toBe('Interleaved result');
    });

    it('counter is per-sequence: 5 consecutive waits before first reset throws, not fewer', async () => {
      vi.useFakeTimers();

      // Exactly 4 waits then a delegate (should NOT throw) then synthesize
      let call = 0;
      mockPlanningService.updatePlanForRound.mockImplementation(async () => {
        call++;
        if (call <= 4) return { action: 'wait' };
        if (call === 5) return {
          action: 'delegate',
          researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
          allQueries: ['q1'],
        };
        return { action: 'synthesize', content: 'Under-limit result' };
      });

      const orchestrator = new DeepResearchOrchestrator({ ...baseOptions, complexity: 2 });
      const runPromise = orchestrator.run();

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(5000);
      }
      await vi.runAllTimersAsync();

      // 4 waits < 5 MAX_WAIT_RETRIES, should not throw
      const result = await runPromise;
      expect(result).toBe('Under-limit result');
    });
  });
});
