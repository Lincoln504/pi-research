import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeepResearchOrchestrator } from '../../../src/orchestration/deep-research-orchestrator.ts';
import { resetServiceContainer, registerService, getService } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';

// Mock service registry
vi.mock('../../../src/core/service-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/service-registry.ts')>();
  return {
    ...actual,
    getService: vi.fn(),
  };
});

// Mock logger
vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createResearchRunId: () => 'test-run-id',
  runWithLogContext: (ctx: any, fn: any) => fn(),
}));

// Mock config
vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({
    KNOWLEDGE_STORE_ENABLED: false,
    MAX_CONCURRENT_RESEARCHERS: 3,
    RESEARCHER_MAX_RETRIES: 2,
    RESEARCHER_MAX_RETRY_DELAY_MS: 5000,
    RESEARCHER_TIMEOUT_MS: 120000,
  })),
  DEFAULTS: {
    KNOWLEDGE_STORE_ENABLED: false,
  },
}));

// Mock research session services
vi.mock('../../../src/orchestration/research-session-manager.ts', () => ({
  getResearchSynthesisService: vi.fn(() => Promise.resolve({
    synthesize: vi.fn(),
    storeReport: vi.fn(),
    getReports: vi.fn(() => []),
    hasReports: vi.fn(() => false),
    buildFallbackSynthesis: vi.fn(() => '# Research Findings\n\n*Automated synthesis of researcher reports*'),
    clearReports: vi.fn(),
    getAllReports: vi.fn(() => new Map()),
    getReport: vi.fn(),
    getReportsForRound: vi.fn(() => new Map()),
    getReportCount: vi.fn(() => 0),
    ensureCitedLinks: vi.fn((text: string) => text),
  })),
  getResearchSessionService: vi.fn(() => Promise.resolve({
    registerSession: vi.fn(),
    getSession: vi.fn(),
    hasSession: vi.fn(),
    unregisterSession: vi.fn(),
    abortSession: vi.fn(),
    abortAllSessions: vi.fn(),
    cleanup: vi.fn(),
    reset: vi.fn(),
    getActiveSessionCount: vi.fn(() => 0),
    getActiveSessionIds: vi.fn(() => []),
  })),
  resetResearchServices: vi.fn(() => Promise.resolve()),
  cleanupResearchServices: vi.fn(() => Promise.resolve()),
}));

describe('DeepResearchOrchestrator', () => {
  const mockCtx = {
    cwd: '/tmp',
    model: { id: 'test-model' },
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'key', headers: {} })),
    },
    ui: { setWidget: vi.fn() },
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

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock planning service
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
    };

    // Default getService implementation
    vi.mocked(getService).mockImplementation(async (name) => {
      if (name === ServiceNames.PLANNING) return mockPlanningService;
      if (name === ServiceNames.RESEARCH_ORCHESTRATION) return mockOrchestrationService;
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
  });

  afterEach(() => {
    resetServiceContainer();
  });

  it('should run a basic research round and synthesize', async () => {
    // Mock updatePlanForRound to return delegate first, then synthesize
    let callCount = 0;
    mockPlanningService.updatePlanForRound.mockImplementation(async () => {
      callCount++;
      // First call (round 1) - delegate
      if (callCount === 1) {
        return {
          action: 'delegate',
          researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
          allQueries: ['q1'],
        };
      }
      // All subsequent calls - synthesize (including forced synthesis)
      return {
        action: 'synthesize',
        content: 'The final result',
      };
    });

    const orchestrator = new DeepResearchOrchestrator(options);
    const result = await orchestrator.run();

    expect(result).toBe('The final result');
    expect(mockPlanningService.updatePlanForRound).toHaveBeenCalled();
    expect(mockOrchestrationService.runSearchBurst).toHaveBeenCalled();
    expect(mockOrchestrationService.runResearchers).toHaveBeenCalled();
  });

  it('should handle multi-round research (delegate then synthesize)', async () => {
    let callCount = 0;
    mockPlanningService.updatePlanForRound.mockImplementation(async () => {
      callCount++;
      // First 2 calls (rounds 1-2) - delegate
      if (callCount <= 2) {
        return {
          action: 'delegate',
          researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
          allQueries: ['q1'],
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
    expect(mockPlanningService.updatePlanForRound).toHaveBeenCalled();
  });

  it('should handle immediate synthesis request', async () => {
    mockPlanningService.updatePlanForRound.mockImplementation(async () => {
      return {
        action: 'synthesize',
        content: 'Direct synthesis',
      };
    });

    const orchestrator = new DeepResearchOrchestrator(options);
    const result = await orchestrator.run();

    expect(result).toBe('Direct synthesis');
    expect(mockOrchestrationService.runSearchBurst).not.toHaveBeenCalled();
    expect(mockOrchestrationService.runResearchers).not.toHaveBeenCalled();
  });

  it('should handle planning failure gracefully', async () => {
    mockPlanningService.updatePlanForRound.mockRejectedValueOnce(new Error('Planning failed'));

    const orchestrator = new DeepResearchOrchestrator(options);

    await expect(orchestrator.run()).rejects.toThrow('Planning failed');
  });

  it('should enforce maximum rounds and force synthesis', async () => {
    const delegateResponse = {
      action: 'delegate',
      researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
      allQueries: ['q1'],
    };
    const synthesizeResponse = { action: 'synthesize', content: 'Forced synthesis result' };

    // Always delegate for the first N calls, then synthesize
    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
      // Check if this is a forced synthesis call (mustSynthesize: true)
      if (opts?.mustSynthesize) {
        return synthesizeResponse;
      }
      return delegateResponse;
    });

    const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 2 }); // Max 4 rounds for complexity 2
    const result = await orchestrator.run();

    expect(result).toContain('Forced synthesis result');
  });

  it('should report round progress to observer', async () => {
    const onRoundStart = vi.fn();
    const onSearchProgress = vi.fn();

    let callCount = 0;
    mockPlanningService.updatePlanForRound.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }], allQueries: ['q1'] };
      } else {
        return { action: 'synthesize', content: 'Progress test' };
      }
    });

    const orchestrator = new DeepResearchOrchestrator({
      ...options,
      observer: { onRoundStart, onSearchProgress },
    });

    await orchestrator.run();

    expect(onRoundStart).toHaveBeenCalledWith(1);
    expect(onRoundStart).toHaveBeenCalledWith(2); // Final synthesis round
  });

  it('should increment totalResearchersPlanned after each delegate round', async () => {
    let callCount = 0;
    mockPlanningService.updatePlanForRound.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          action: 'delegate',
          researchers: [
            { id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] },
            { id: 'r2', name: 'R2', goal: 'G2', queries: ['q2'] },
          ],
          allQueries: ['q1', 'q2'],
        };
      }
      return { action: 'synthesize', content: 'Done' };
    });

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    // Should have incremented by 2 (number of researchers in the delegate plan)
    expect(mockPlanningService.incrementTotalResearchersPlanned).toHaveBeenCalledWith(2);
  });

  it('should record query history after each delegate round', async () => {
    let callCount = 0;
    mockPlanningService.updatePlanForRound.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          action: 'delegate',
          researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1', 'q2'] }],
          allQueries: ['q1', 'q2'],
        };
      }
      return { action: 'synthesize', content: 'Done' };
    });

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    expect(mockPlanningService.addToQueryHistory).toHaveBeenCalledWith(['q1', 'q2']);
  });

  it('should pass getCurrentPlan as previousPlan to updatePlanForRound', async () => {
    const mockPreviousPlan = { action: 'delegate' as const, researchers: [], allQueries: ['prev-q'] };
    // First call: getCurrentPlan returns null (initial state)
    // After first plan, getCurrentPlan returns the plan
    let callCount = 0;
    mockPlanningService.getCurrentPlan.mockImplementation(() => {
      return callCount > 0 ? mockPreviousPlan : null;
    });
    mockPlanningService.updatePlanForRound.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          action: 'delegate',
          researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
          allQueries: ['q1'],
        };
      }
      return { action: 'synthesize', content: 'Done' };
    });

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    // First call should pass null (initial state)
    expect(mockPlanningService.updatePlanForRound).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ previousPlan: null })
    );
    // Second call (or final synthesis) should pass the previous plan
    expect(mockPlanningService.updatePlanForRound).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ previousPlan: mockPreviousPlan })
    );
  });

  it('should not increment totalResearchersPlanned on synthesize action', async () => {
    mockPlanningService.updatePlanForRound.mockImplementation(async () => {
      return { action: 'synthesize', content: 'Direct result' };
    });

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    expect(mockPlanningService.incrementTotalResearchersPlanned).not.toHaveBeenCalled();
  });
});