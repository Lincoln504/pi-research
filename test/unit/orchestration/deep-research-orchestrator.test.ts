import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeepResearchOrchestrator } from '../../../src/orchestration/deep-research-orchestrator.ts';
import { completeSimple, complete } from '@mariozechner/pi-ai';
import { resetServiceContainer, registerService, replaceServiceInstance, getService } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';

// Mock service registry
vi.mock('../../../src/core/service-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/service-registry.ts')>();
  return {
    ...actual,
    getService: vi.fn(),
  };
});

// Mock PI AI
vi.mock('@mariozechner/pi-ai', () => ({
  complete: vi.fn(),
  completeSimple: vi.fn(),
}));

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

// Mock web-research/search
vi.mock('../../../src/web-research/search.ts', () => ({
  search: vi.fn(async (queries: string[], config: any, signal?: AbortSignal, onProgress?: (links: number) => void) => {
    // Return search results so researchers have links to work with
    return queries.map(query => ({
      query,
      results: [{ url: 'https://example.com', title: 'Example', snippet: 'Test result' }],
    }));
  }),
}));

// Mock researcher session (via createResearcherSession)
vi.mock('../../../src/orchestration/researcher.ts', () => {
  let sessionMessages: any[] = [];
  return {
    createResearcherSession: vi.fn(async () => {
      sessionMessages = [];
      const session = {
        prompt: vi.fn(async () => {
          // Add an assistant message when prompted
          sessionMessages.push({
            role: 'assistant',
            content: [{ type: 'text', text: 'Report content\n\n### CITED LINKS\n[1] https://example.com\nDescription: Test description' }],
            stopReason: 'stop',
          });
        }),
        subscribe: vi.fn(() => () => {}),
        abort: vi.fn(async () => {}),
        getHistory: () => sessionMessages,
        get messages() {
          return sessionMessages;
        },
      };
      return session;
    }),
  };
});

// Mock knowledge module
vi.mock('../../../src/knowledge/index.ts', () => {
  return {
    isKnowledgeStoreReady: vi.fn().mockReturnValue(true),
  };
});

// Mock research session services
let mockReports = new Map<string, string>();
let mockSynthesize = vi.fn();

vi.mock('../../../src/orchestration/research-session-manager.ts', () => ({
  initializeResearchServices: vi.fn(() => {
    mockReports.clear();
  }),
  getResearchSessionService: vi.fn(() => ({
    addSession: vi.fn(),
    getSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    cleanup: vi.fn(),
    registerSession: vi.fn(),
    unregisterSession: vi.fn(),
    abortAllSessions: vi.fn(),
  })),
  getResearchSynthesisService: vi.fn(() => ({
    synthesize: mockSynthesize,
    storeReport: vi.fn((id: string, report: string) => {
      mockReports.set(id, report);
    }),
    getReports: vi.fn(() => []),
    hasReports: vi.fn(() => mockReports.size > 0),
    buildFallbackSynthesis: vi.fn(() => '# Research Findings\n\n*Automated synthesis of researcher reports*'),
    clearReports: vi.fn(() => {
      mockReports.clear();
    }),
    getAllReports: vi.fn(() => new Map(mockReports)),
    getReport: vi.fn((id: string) => mockReports.get(id)),
    getReportsForRound: vi.fn(() => new Map()),
    getReportCount: vi.fn(() => mockReports.size),
    ensureCitedLinks: vi.fn((text: string) => text),
  })),
  cleanupResearchServices: vi.fn(),
  areResearchServicesInitialized: vi.fn(() => true),
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

  const mockConfig = {
    KNOWLEDGE_STORE_ENABLED: true,
    MAX_CONCURRENT_RESEARCHERS: 3,
    RESEARCHER_MAX_RETRIES: 2,
    RESEARCHER_MAX_RETRY_DELAY_MS: 5000,
    RESEARCHER_TIMEOUT_MS: 120000,
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockReports.clear();
    mockSynthesize = vi.fn();

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
      addToQueryHistory: vi.fn(),
      clearPlanningState: vi.fn(),
    };

    const mockStore = {
      findRelevantUrls: vi.fn().mockResolvedValue([]),
      close: vi.fn(),
      rebuildFtsIndex: vi.fn().mockResolvedValue(undefined),
    };
    const mockWriter = {
      enqueue: vi.fn(),
      drain: vi.fn().mockResolvedValue(undefined),
    };

    // Default getService implementation
    vi.mocked(getService).mockImplementation(async (name) => {
      if (name === ServiceNames.PLANNING) return mockPlanningService;
      if (name === ServiceNames.KNOWLEDGE_STORE) return mockStore;
      if (name === ServiceNames.WRITER_QUEUE) return mockWriter;
      return null;
    });

    // Register mock planning service
    registerService(
      ServiceNames.PLANNING,
      () => mockPlanningService,
      { lazyInitialization: false, allowOverwrite: true, enableLogging: false }
    );
  });

  afterEach(() => {
    resetServiceContainer();
  });

  it('should run a basic research round and synthesize', async () => {
    // Mock planning service methods
    mockPlanningService.generatePlan.mockResolvedValue({
      action: 'delegate',
      researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
      allQueries: ['q1'],
    });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'The final result' });

    const orchestrator = new DeepResearchOrchestrator({ ...options, config: mockConfig as any });
    const result = await orchestrator.run();

    expect(result).toBe('The final result');
    expect(mockPlanningService.generatePlan).toHaveBeenCalledTimes(1);
    expect(mockPlanningService.updatePlanForRound).toHaveBeenCalledTimes(1);
  });

  it('should handle multi-round research (delegate then synthesize)', async () => {
    // Round 1: Planning
    mockPlanningService.generatePlan.mockResolvedValue({
      action: 'delegate',
      researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
      allQueries: ['q1'],
    });

    // Round 1: Evaluation - delegate
    mockPlanningService.updatePlanForRound.mockResolvedValueOnce({
      action: 'delegate',
      researchers: [{ id: 'r2', name: 'R2', goal: 'G2', queries: ['q2'] }],
      allQueries: ['q2'],
    });

    // Round 2: Evaluation - synthesize
    mockPlanningService.updatePlanForRound.mockResolvedValueOnce({ action: 'synthesize', content: 'Multi-round result' });
    mockSynthesize.mockResolvedValue('Multi-round result');

    const orchestrator = new DeepResearchOrchestrator(options);
    const result = await orchestrator.run();

    expect(result).toBe('Multi-round result');
    expect(mockPlanningService.generatePlan).toHaveBeenCalledTimes(1);
    expect(mockPlanningService.updatePlanForRound).toHaveBeenCalledTimes(2);
  });

  it('should inject historical links into planning prompt', async () => {
    mockPlanningService.generatePlan.mockImplementation(async (args: any) => {
      // Check that historical links were included in the context
      expect(args.historicalLinksSection).toBeDefined();
      return {
        action: 'delegate',
        researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
        allQueries: ['q1'],
      };
    });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Result' });

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    expect(mockPlanningService.generatePlan).toHaveBeenCalled();
  });

  it('should store researcher-derived link descriptions in knowledge store', async () => {
    mockPlanningService.generatePlan.mockResolvedValue({
      action: 'delegate',
      researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
      allQueries: ['q1'],
    });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Result' });

    const orchestrator = new DeepResearchOrchestrator({ ...options, config: mockConfig as any });
    await orchestrator.run();

    // Verify knowledge store was called (through writer queue)
    const writer = await getService<any>(ServiceNames.WRITER_QUEUE);
    expect(writer.enqueue).toHaveBeenCalled();
  });

  it('should attempt self-correction if evaluator returns invalid JSON', async () => {
    mockPlanningService.generatePlan.mockResolvedValue({
      action: 'delegate',
      researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
      allQueries: ['q1'],
    });

    // First evaluation: invalid JSON - this will trigger fallback synthesis since there are reports
    mockPlanningService.updatePlanForRound.mockRejectedValueOnce(new Error('Invalid JSON'));

    const orchestrator = new DeepResearchOrchestrator({ ...options, config: mockConfig as any });
    const result = await orchestrator.run();

    // Since evaluation fails and there are reports, it returns fallback synthesis
    expect(result).toContain('Research Findings');
    expect(mockPlanningService.updatePlanForRound).toHaveBeenCalledTimes(1);
  });

  it('should handle planning failure and fallback', async () => {
    // When planning fails, no researchers run, so no reports are generated
    mockPlanningService.generatePlan.mockRejectedValue(new Error('Planning failed'));

    const orchestrator = new DeepResearchOrchestrator(options);
    const result = await orchestrator.run();

    // When no reports are generated, it returns the error message
    expect(result).toContain('Research failed');
  });

  it('should enforce maximum rounds and force synthesis', async () => {
    // Planning
    mockPlanningService.generatePlan.mockResolvedValue({
      action: 'delegate',
      researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
      allQueries: ['q1'],
    });

    // Always delegate
    mockPlanningService.updatePlanForRound.mockResolvedValue({
      action: 'delegate',
      researchers: [{ id: 'r2', name: 'R2', goal: 'G2', queries: ['q2'] }],
      allQueries: ['q2'],
    });

    const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 1 });
    // complexity 1 has MAX_ROUNDS_LEVEL_1 = 2 rounds.
    // Plus MAX_EXTRA_ROUNDS = 2. Total 4 rounds.

    const result = await orchestrator.run();

    expect(result).toContain('Research Findings'); // Fallback synthesis since it never returned 'synthesize'
    // 1 planning + 4 evaluation calls
    expect(mockPlanningService.updatePlanForRound).toHaveBeenCalledTimes(4);
  });
});