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

vi.mock('../../../src/orchestration/research-session-manager.ts', () => ({
  getResearchSynthesisService: vi.fn(() => Promise.resolve({
    synthesize: vi.fn(),
    storeReport: vi.fn(),
    getReports: vi.fn(() => []),
    hasReports: vi.fn(() => false),
    buildFallbackSynthesis: vi.fn(() => '# Fallback'),
    clearReports: vi.fn(),
    getAllReports: vi.fn(() => new Map()),
    ensureCitedLinks: vi.fn((_id: string, text: string) => text),
    appendSteeringGuidance: vi.fn((text: string) => text),
  })),
  resetResearchServices: vi.fn(() => Promise.resolve()),
  cleanupResearchServices: vi.fn(() => Promise.resolve()),
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

    registerService(ServiceNames.PLANNING, () => mockPlanningService, { allowOverwrite: true });
    registerService(ServiceNames.RESEARCH_ORCHESTRATION, () => mockOrchestrationService, { allowOverwrite: true });
  });

  afterEach(() => {
    resetServiceContainer();
    vi.useRealTimers();
  });

  describe('Wait Retry Counter', () => {
    it('throws descriptive error after 6 wait actions (hits limit of 5)', async () => {
      vi.useFakeTimers();

      mockPlanningService.generatePlan.mockResolvedValue({ action: 'wait' });

      const orchestrator = new DeepResearchOrchestrator(baseOptions);
      const runPromise = orchestrator.run();
      // Attach a no-op catch early so Node doesn't flag this as an unhandled rejection
      // while timers are advancing. The .rejects assertion below still catches it correctly.
      runPromise.catch(() => {});

      // We need 6 calls to 'wait' to exceed MAX_WAIT_RETRIES (5)
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(5000);
      }

      await expect(runPromise).rejects.toThrow(/Max wait retries/);
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
      mockPlanningService.updatePlanForRound.mockImplementation(async () => {
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