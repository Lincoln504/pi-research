/**
 * Deep Research Orchestrator Unit Tests
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

vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({
    LOCAL_KNOWLEDGE_STORE_ENABLED: false,
GLOBAL_KNOWLEDGE_STORE_ENABLED: false,
    MAX_CONCURRENT_RESEARCHERS: 3,
    RESEARCHER_MAX_RETRIES: 2,
    RESEARCHER_MAX_RETRY_DELAY_MS: 5000,
    RESEARCHER_TIMEOUT_MS: 120000,
  })),
  DEFAULTS: { LOCAL_KNOWLEDGE_STORE_ENABLED: false, GLOBAL_KNOWLEDGE_STORE_ENABLED: false },
}));

// Mock session-state for steering functions
vi.mock('../../../src/orchestration/session/session-state.ts', () => ({
  getSteeringMessages: vi.fn(() => []),
  getQueuedSteeringMessages: vi.fn(() => []),
  consumeQueuedMessages: vi.fn(() => []),
  getActiveSteeringMessages: vi.fn(() => []),
  getActiveSessionCount: vi.fn(() => 1),
}));

describe('DeepResearchOrchestrator', () => {
  const mockCtx = {
    cwd: '/tmp',
    model: { id: 'test-model' },
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'test-key', headers: {} })),
    },
    ui: {
      setWidget: vi.fn(),
    },
  };

  const options = {
    ctx: mockCtx as any,
    model: { id: 'test-model' } as any,
    query: 'test query',
    complexity: 1 as const,
    sessionId: 'test-session',
    researchId: 'test-research',
  };

  let mockPlanningService: any;
  let mockOrchestrationService: any;
  let mockSynthesisService: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock planning service
    mockPlanningService = {
      name: 'planning',
      lifecycle: 'initialized',
      async initialize() {},
      async dispose() {},
      generatePlan: vi.fn().mockResolvedValue({
        action: 'delegate',
        researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
        allQueries: ['q1'],
      }),
      updatePlanForRound: vi.fn(),
      getCurrentPlan: vi.fn(() => null),
      getTotalResearchersPlanned: vi.fn(() => 0),
      incrementTotalResearchersPlanned: vi.fn(),
      addToQueryHistory: vi.fn(),
      clearPlanningState: vi.fn(),
    };

    // Create mock orchestration service
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

    // Create mock synthesis service
    mockSynthesisService = {
      name: 'research-synthesis',
      lifecycle: 'initialized',
      async initialize() {},
      async dispose() {},
      synthesize: vi.fn(),
      storeReport: vi.fn(),
      getReports: vi.fn(() => []),
      hasReports: vi.fn(() => false),
      buildFallbackSynthesis: vi.fn(() => '# Fallback Synthesis'),
      clearReports: vi.fn(),
      getAllReports: vi.fn(() => new Map()),
      getReport: vi.fn(),
      getReportsForRound: vi.fn(() => new Map()),
      getReportCount: vi.fn(() => 0),
      ensureCitedLinks: vi.fn((_id: string, text: string) => text),
      appendSteeringGuidance: vi.fn((text: string) => text),
      appendMetadata: vi.fn((text: string) => text),
    };

    // Default getService implementation
    vi.mocked(getService).mockImplementation(async (name) => {
      if (name === ServiceNames.PLANNING) return mockPlanningService;
      if (name === ServiceNames.RESEARCH_ORCHESTRATION) return mockOrchestrationService;
      if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) return mockSynthesisService;
      return null;
    });

    // Register mock planning service
    registerService(
      ServiceNames.PLANNING,
      () => mockPlanningService,
      { lazyInitialization: false, allowOverwrite: true, enableLogging: false }
    );

    registerService(
      ServiceNames.RESEARCH_ORCHESTRATION,
      () => mockOrchestrationService,
      { lazyInitialization: false, allowOverwrite: true, enableLogging: false }
    );

    registerService(
      ServiceNames.RESEARCH_SYNTHESIS_SERVICE,
      () => mockSynthesisService,
      { lazyInitialization: false, allowOverwrite: true, enableLogging: false }
    );
  });

  afterEach(() => {
    resetServiceContainer();
  });

  it('should run a basic research round and synthesize', async () => {
    // Mock updatePlanForRound to return synthesize (forced synthesis)
    mockPlanningService.updatePlanForRound.mockResolvedValue({
        action: 'synthesize',
        content: 'The final result',
    });

    const orchestrator = new DeepResearchOrchestrator(options);
    const result = await orchestrator.run();

    expect(result).toBe('The final result');
    expect(mockPlanningService.generatePlan).toHaveBeenCalled();
    expect(mockPlanningService.updatePlanForRound).toHaveBeenCalled();
    expect(mockOrchestrationService.runSearchBurst).toHaveBeenCalled();
    expect(mockOrchestrationService.runResearchers).toHaveBeenCalled();
  });

  it('should handle multi-round research (delegate then synthesize)', async () => {
    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
      // Round 2 - delegate
      if (opts.round === 2) {
        return {
          action: 'delegate',
          researchers: [{ id: 'r2', name: 'R2', goal: 'G2', queries: ['q2'] }],
          allQueries: ['q2'],
        };
      }
      // All subsequent calls - synthesize
      return {
        action: 'synthesize',
        content: 'Multi-round result',
      };
    });

    const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 2 });
    const result = await orchestrator.run();

    expect(result).toBe('Multi-round result');
    expect(mockPlanningService.generatePlan).toHaveBeenCalled();
    expect(mockPlanningService.updatePlanForRound).toHaveBeenCalled();
  });

  it('should handle immediate synthesis request', async () => {
    mockPlanningService.generatePlan.mockResolvedValue({
      action: 'synthesize',
      content: 'Direct synthesis',
    });

    const orchestrator = new DeepResearchOrchestrator(options);
    const result = await orchestrator.run();

    expect(result).toBe('Direct synthesis');
    expect(mockPlanningService.generatePlan).toHaveBeenCalled();
    expect(mockOrchestrationService.runResearchers).not.toHaveBeenCalled();
  });

  it('should handle planning failure gracefully', async () => {
    mockPlanningService.generatePlan.mockRejectedValueOnce(new Error('Planning failed'));

    const orchestrator = new DeepResearchOrchestrator(options);

    await expect(orchestrator.run()).rejects.toThrow('Planning failed');
  });

  it('should enforce maximum rounds and force synthesis', async () => {
    // Mock updatePlanForRound to always return delegate
    mockPlanningService.updatePlanForRound.mockResolvedValue({
      action: 'delegate',
      researchers: [{ id: 'r', name: 'R', goal: 'G', queries: ['q'] }],
      allQueries: ['q'],
    });

    // Forced synthesis (last call)
    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
        if (opts.mustSynthesize) {
            return { action: 'synthesize', content: 'Forced synthesis result' };
        }
        return {
            action: 'delegate',
            researchers: [{ id: 'r', name: 'R', goal: 'G', queries: ['q'] }],
            allQueries: ['q'],
        };
    });

    const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 1 }); // maxRounds = 2
    const result = await orchestrator.run();

    expect(result).toContain('Forced synthesis result');
  });

  it('should extend round budget when queued steering messages exist at run start', async () => {
    // Pretend the user has 2 queued steering messages waiting when this
    // research run begins. For complexity 1, the base budget is 2 rounds;
    // with 2 queued messages we should get up to 2 extra rounds (capped
    // at MAX_EXTRA_ROUNDS_WITH_STEERING = 2).
    const { getSteeringMessages } = await import('../../../src/orchestration/session/session-state.ts');
    vi.mocked(getSteeringMessages).mockReturnValue([
      { id: '1', text: 'focus on X', status: 'queued', addedAt: 0, consumedAt: null, poppedAt: null },
      { id: '2', text: 'and Y', status: 'queued', addedAt: 0, consumedAt: null, poppedAt: null },
    ]);

    // Evaluator keeps delegating until the loop exits, then forced synthesis.
    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
      if (opts.mustSynthesize) {
        return { action: 'synthesize', content: 'Final synthesis' };
      }
      return {
        action: 'delegate',
        researchers: [{ id: 'r', name: 'R', goal: 'G', queries: ['q'] }],
        allQueries: ['q'],
      };
    });

    const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 1 });
    const result = await orchestrator.run();

    expect(result).toContain('Final synthesis');

    // With 2 queued messages and cap=2, the budget extends from 2 → 4 rounds.
    // updatePlanForRound is called once per round 2..N and once more for the
    // forced final synthesis: so 3 in-loop evaluator calls + 1 forced = 4.
    const updateCalls = vi.mocked(mockPlanningService.updatePlanForRound).mock.calls;
    expect(updateCalls.length).toBe(4);
  });

  it('should NOT extend round budget when no queued steering messages exist', async () => {
    // Explicitly reset steering mock in case a previous test set it.
    const { getSteeringMessages } = await import('../../../src/orchestration/session/session-state.ts');
    vi.mocked(getSteeringMessages).mockReturnValue([]);

    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
      if (opts.mustSynthesize) {
        return { action: 'synthesize', content: 'Base synthesis' };
      }
      return {
        action: 'delegate',
        researchers: [{ id: 'r', name: 'R', goal: 'G', queries: ['q'] }],
        allQueries: ['q'],
      };
    });

    const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 1 });
    const result = await orchestrator.run();

    expect(result).toContain('Base synthesis');
    // Base budget 2 rounds → 1 in-loop evaluator call (round 2) + 1 forced = 2.
    const updateCalls = vi.mocked(mockPlanningService.updatePlanForRound).mock.calls;
    expect(updateCalls.length).toBe(2);
  });

  it('should cap extra rounds at MAX_EXTRA_ROUNDS_WITH_STEERING even with many queued messages', async () => {
    // 5 queued messages — but cap is 2, so we should only get 2 extra rounds.
    const { getSteeringMessages } = await import('../../../src/orchestration/session/session-state.ts');
    vi.mocked(getSteeringMessages).mockReturnValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: String(i),
        text: `steer ${i}`,
        status: 'queued' as const,
        addedAt: 0,
        consumedAt: null,
        poppedAt: null,
      })),
    );

    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
      if (opts.mustSynthesize) {
        return { action: 'synthesize', content: 'Capped synthesis' };
      }
      return {
        action: 'delegate',
        researchers: [{ id: 'r', name: 'R', goal: 'G', queries: ['q'] }],
        allQueries: ['q'],
      };
    });

    const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 1 });
    const result = await orchestrator.run();

    expect(result).toContain('Capped synthesis');
    // Cap=2 + base=2 = 4 rounds → 3 in-loop calls + 1 forced = 4.
    const updateCalls = vi.mocked(mockPlanningService.updatePlanForRound).mock.calls;
    expect(updateCalls.length).toBe(4);
  });

  it('should report round progress to observer', async () => {
    const onRoundStart = vi.fn();
    const onSearchProgress = vi.fn();

    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Progress test' });

    const orchestrator = new DeepResearchOrchestrator({
      ...options,
      observer: { onRoundStart, onSearchProgress },
    });

    await orchestrator.run();

    expect(onRoundStart).toHaveBeenCalledWith(1);
    expect(onRoundStart).toHaveBeenCalledWith(2); // Final synthesis round
  });

  it('should increment totalResearchersPlanned after each delegate round', async () => {
    mockPlanningService.generatePlan.mockResolvedValue({
      action: 'delegate',
      researchers: [
        { id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] },
        { id: 'r2', name: 'R2', goal: 'G2', queries: ['q2'] },
      ],
      allQueries: ['q1', 'q2'],
    });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    // Should have incremented by 2 (number of researchers in the delegate plan)
    expect(mockPlanningService.incrementTotalResearchersPlanned).toHaveBeenCalledWith(options.researchId, 2);
  });

  it('should record query history after each delegate round', async () => {
    mockPlanningService.generatePlan.mockResolvedValue({
      action: 'delegate',
      researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1', 'q2'] }],
      allQueries: ['q1', 'q2'],
    });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    expect(mockPlanningService.addToQueryHistory).toHaveBeenCalledWith(options.researchId, ['q1', 'q2']);
  });

  it('should pass getCurrentPlan as previousPlan to updatePlanForRound', async () => {
    const mockPreviousPlan = { action: 'delegate' as const, researchers: [], allQueries: ['prev-q'] };
    
    mockPlanningService.generatePlan.mockResolvedValue(mockPreviousPlan);
    mockPlanningService.getCurrentPlan.mockImplementation(() => {
      return mockPlanningService.generatePlan.mock.calls.length > 0 ? mockPreviousPlan : null;
    });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    // Round 2 (final synthesis) should pass the previous plan
    expect(mockPlanningService.updatePlanForRound).toHaveBeenCalledWith(
      expect.objectContaining({ previousPlan: mockPreviousPlan })
    );
  });

  it('should not increment totalResearchersPlanned on synthesize action', async () => {
    mockPlanningService.generatePlan.mockResolvedValue({ action: 'synthesize', content: 'Direct result' });

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    expect(mockPlanningService.incrementTotalResearchersPlanned).not.toHaveBeenCalled();
  });

  it('should fire onStart observer event at the beginning of run()', async () => {
    const onStart = vi.fn();

    mockPlanningService.generatePlan.mockResolvedValue({ action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }], allQueries: ['q1'] });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onStart } });
    await orchestrator.run();

    expect(onStart).toHaveBeenCalledWith(options.query, options.complexity);
  });

  it('should fire onPlanningStart and onPlanningProgress observer events during planning', async () => {
    const onPlanningStart = vi.fn();
    const onPlanningProgress = vi.fn();

    mockPlanningService.generatePlan.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator({
      ...options,
      observer: { onPlanningStart, onPlanningProgress },
    });
    await orchestrator.run();

    expect(onPlanningStart).toHaveBeenCalledWith(1);
    expect(onPlanningProgress).toHaveBeenCalledWith('planning');
  });

  it('should fire onPlanningSuccess when plan action is delegate', async () => {
    const onPlanningSuccess = vi.fn();

    mockPlanningService.generatePlan.mockResolvedValue({ action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }], allQueries: ['q1'] });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onPlanningSuccess } });
    await orchestrator.run();

    expect(onPlanningSuccess).toHaveBeenCalledWith(expect.objectContaining({ action: 'delegate' }));
  });

  it('should fire onSearchStart when queries are available', async () => {
    const onSearchStart = vi.fn();

    mockPlanningService.generatePlan.mockResolvedValue({ action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1', 'q2'] }], allQueries: ['q1', 'q2'] });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onSearchStart } });
    await orchestrator.run();

    expect(onSearchStart).toHaveBeenCalledWith(['q1', 'q2']);
  });

  it('should fire onSearchComplete with result count after search phase', async () => {
    const onSearchComplete = vi.fn();

    mockPlanningService.generatePlan.mockResolvedValue({ action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }], allQueries: ['q1'] });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    // Return 3 results from search burst
    mockOrchestrationService.runSearchBurst.mockResolvedValue([
      { results: [{ url: 'a' }, { url: 'b' }] },
      { results: [{ url: 'c' }] },
    ]);

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onSearchComplete } });
    await orchestrator.run();

    // 2 results from first query, 1 from second = 3 total
    expect(onSearchComplete).toHaveBeenCalledWith(3);
  });

  it('should fire onEvaluationStart and onEvaluationProgress observer events', async () => {
    const onEvaluationStart = vi.fn();
    const onEvaluationProgress = vi.fn();

    mockPlanningService.generatePlan.mockResolvedValue({ action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }], allQueries: ['q1'] });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator({
      ...options,
      observer: { onEvaluationStart, onEvaluationProgress },
    });
    await orchestrator.run();

    expect(onEvaluationStart).toHaveBeenCalled();
    expect(onEvaluationProgress).toHaveBeenCalledWith('embedding');
    expect(onEvaluationProgress).toHaveBeenCalledWith('evaluating');
  });

  it('should fire onEvaluationDecision with delegate action after research round', async () => {
    const onEvaluationDecision = vi.fn();

    // complexity 2 → maxRounds = 4
    mockPlanningService.generatePlan.mockResolvedValue({ action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }], allQueries: ['q1'] });
    
    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
      if (opts.round === 2) {
        return { action: 'delegate', researchers: [{ id: 'r2', name: 'R2', goal: 'G2', queries: ['q2'] }], allQueries: ['q2'] };
      }
      return { action: 'synthesize', content: 'Done' };
    });

    const orchestrator = new DeepResearchOrchestrator({
      ...options,
      complexity: 2 as const,
      observer: { onEvaluationDecision },
    });
    await orchestrator.run();

    expect(onEvaluationDecision).toHaveBeenCalledWith('delegate', expect.anything(), 2);
  });

  it('should fire onComplete with the final result string', async () => {
    const onComplete = vi.fn();

    mockPlanningService.generatePlan.mockResolvedValue({ action: 'synthesize', content: 'Final answer' });

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onComplete } });
    await orchestrator.run();

    expect(onComplete).toHaveBeenCalledWith('Final answer');
  });

  it('should fire onError when planning throws', async () => {
    const onError = vi.fn();
    const testError = new Error('Planning blew up');
    mockPlanningService.generatePlan.mockRejectedValue(testError);

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onError } });
    await expect(orchestrator.run()).rejects.toThrow('Planning blew up');
    expect(onError).toHaveBeenCalledWith(testError);
  });

  it('should fire onPlanningProgress with wait status when plan returns wait action', async () => {
    const onPlanningProgress = vi.fn();
    const onError = vi.fn();

    mockPlanningService.generatePlan.mockResolvedValue({ action: 'wait' });

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onPlanningProgress, onError } });

    // Use fake timers so the 5-second wait between retries resolves immediately
    vi.useFakeTimers();
    try {
      const runPromise = orchestrator.run();
      // Attach the rejection handler BEFORE advancing any timers.
      const settled = expect(runPromise).rejects.toThrow('Max wait retries');
      // Drain all pending timers (each retry schedules one 5s setTimeout)
      for (let i = 0; i < 6; i++) {
        await vi.runAllTimersAsync();
      }
      await settled;
    } finally {
      vi.useRealTimers();
    }

    // onPlanningProgress should have been called (with 'planning' for wait retries)
    expect(onPlanningProgress).toHaveBeenCalledWith('planning');
  }, 15000);
});