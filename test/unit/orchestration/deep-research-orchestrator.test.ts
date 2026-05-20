import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepResearchOrchestrator } from '../../../src/orchestration/deep-research-orchestrator.ts';
import { completeSimple, complete } from '@mariozechner/pi-ai';

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
  search: vi.fn(async () => []),
}));

// Mock researcher session (via createResearcherSession)
vi.mock('../../../src/orchestration/researcher.ts', () => ({
  createResearcherSession: vi.fn(async () => ({
    prompt: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    abort: vi.fn(async () => {}),
    getHistory: () => [{ role: 'assistant', content: [{ type: 'text', text: 'Report content\n\n### CITED LINKS\n[1] https://example.com\nDescription: Test description' }] }],
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Report content\n\n### CITED LINKS\n[1] https://example.com\nDescription: Test description' }] }],
  })),
}));

// Mock knowledge module
vi.mock('../../../src/knowledge/index.ts', () => {
  const mockStore = {
    findRelevantUrls: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
    rebuildFtsIndex: vi.fn().mockResolvedValue(undefined),
  };
  const mockWriter = {
    enqueue: vi.fn(),
    drain: vi.fn().mockResolvedValue(undefined),
  };
  return {
    isKnowledgeStoreReady: vi.fn().mockReturnValue(true),
    getStore: vi.fn().mockResolvedValue(mockStore),
    getWriterQueue: vi.fn().mockResolvedValue(mockWriter),
  };
});

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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should run a basic research round and synthesize', async () => {
    // Mock planning response
    vi.mocked(complete).mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n{ "researchers": [{ "id": "r1", "name": "R1", "goal": "G1", "queries": ["q1"] }], "allQueries": ["q1"] }\n```' }],
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    } as any);

    // Mock evaluation response
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n{ "action": "synthesize", "content": "The final result" }\n```' }],
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    } as any);

    const orchestrator = new DeepResearchOrchestrator(options);
    const result = await orchestrator.run();

    expect(result).toBe('The final result');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it('should handle multi-round research (delegate then synthesize)', async () => {
    // Round 1 Planning
    vi.mocked(complete).mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n{ "researchers": [{ "id": "r1", "name": "R1", "goal": "G1", "queries": ["q1"] }], "allQueries": ["q1"] }\n```' }],
      usage: { totalTokens: 20 },
    } as any);

    // Round 1 Evaluation -> Delegate
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n{ "action": "delegate", "researchers": [{ "id": "r2", "name": "R2", "goal": "G2", "queries": ["q2"] }], "allQueries": ["q2"] }\n```' }],
      usage: { totalTokens: 20 },
    } as any);

    // Round 2 Evaluation -> Synthesize
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n{ "action": "synthesize", "content": "Multi-round result" }\n```' }],
      usage: { totalTokens: 20 },
    } as any);

    const orchestrator = new DeepResearchOrchestrator(options);
    const result = await orchestrator.run();

    expect(result).toBe('Multi-round result');
    expect(complete).toHaveBeenCalledTimes(1); // Planning only happens once
    expect(completeSimple).toHaveBeenCalledTimes(2); // Two evaluations
  });

  it('should inject historical links into planning prompt', async () => {
    const { getStore } = await import('../../../src/knowledge/index.ts');
    const store = await getStore();
    vi.mocked(store.findRelevantUrls).mockResolvedValueOnce(['https://hist1.com', 'https://hist2.com']);

    vi.mocked(complete).mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n{ "researchers": [], "allQueries": [] }\n```' }],
      usage: { totalTokens: 20 },
    } as any);

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    const systemPrompt = vi.mocked(complete).mock.calls[0][1].systemPrompt;
    expect(systemPrompt).toContain('Historical Knowledge Store');
    expect(systemPrompt).toContain('https://hist1.com');
  });

  it('should store researcher-derived link descriptions in knowledge store', async () => {
    const { getWriterQueue } = await import('../../../src/knowledge/index.ts');
    const { search } = await import('../../../src/web-research/search.ts');
    const writer = await getWriterQueue();
    
    // Mock search to return a result for q1
    vi.mocked(search).mockResolvedValueOnce([{ query: 'q1', results: [{ url: 'https://example.com' }], error: null }]);

    // Planning
    vi.mocked(complete).mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n{ "researchers": [{ "id": "r1", "name": "R1", "goal": "G1", "queries": ["q1"] }], "allQueries": ["q1"] }\n```' }],
      usage: { totalTokens: 20 },
    } as any);

    // Round 1 Evaluation -> Synthesize
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n{ "action": "synthesize", "content": "Done" }\n```' }],
      usage: { totalTokens: 20 },
    } as any);

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    // Check if writer.enqueue was called with researcher's citation
    expect(writer.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://example.com',
      markdown: 'Test description',
      metadata: expect.objectContaining({ source: 'researcher' })
    }));
    expect(writer.drain).toHaveBeenCalled();
  });

  it('should attempt self-correction if evaluator returns invalid JSON', async () => {
    // Planning
    vi.mocked(complete).mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n{ "researchers": [{ "id": "r1", "name": "R1", "goal": "G1", "queries": ["q1"] }], "allQueries": ["q1"] }\n```' }],
      usage: { totalTokens: 20 },
    } as any);

    // Evaluation Attempt 1: Malformed
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'This is not JSON' }],
      usage: { totalTokens: 10 },
    } as any);

    // Evaluation Attempt 2: Corrected
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n{ "action": "synthesize", "content": "Corrected" }\n```' }],
      usage: { totalTokens: 15 },
    } as any);

    const orchestrator = new DeepResearchOrchestrator(options);
    const result = await orchestrator.run();

    expect(result).toBe('Corrected');
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(vi.mocked(completeSimple).mock.calls[1][1].messages[0].content[0].text).toContain('YOUR PREVIOUS RESPONSE');
  });

  it('should handle planning failure and fallback', async () => {
    vi.mocked(complete).mockRejectedValue(new Error('Planning failed'));

    const orchestrator = new DeepResearchOrchestrator(options);
    const result = await orchestrator.run();

    expect(result).toContain('Research failed');
  });

  it('should enforce maximum rounds and force synthesis', async () => {
    // Planning
    vi.mocked(complete).mockResolvedValue({
      content: [{ type: 'text', text: '```json\n{ "researchers": [{ "id": "r1", "name": "R1", "goal": "G1", "queries": ["q1"] }], "allQueries": ["q1"] }\n```' }],
      usage: { totalTokens: 20 },
    } as any);

    // Always delegate
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: 'text', text: '```json\n{ "action": "delegate", "researchers": [{ "id": "r2", "name": "R2", "goal": "G2", "queries": ["q2"] }], "allQueries": ["q2"] }\n```' }],
      usage: { totalTokens: 20 },
    } as any);

    const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 1 });
    // complexity 1 has MAX_ROUNDS_LEVEL_1 = 2 rounds.
    // Plus MAX_EXTRA_ROUNDS = 2. Total 4 rounds.
    
    const result = await orchestrator.run();

    expect(result).toContain('Research Findings'); // Fallback synthesis since it never returned 'synthesize'
    // 1 planning + 4 evaluation calls
    expect(completeSimple).toHaveBeenCalledTimes(4);
  });

  describe('ensureCitedLinks (private)', () => {
    it('appends cited links if missing from synthesis', () => {
      const orchestrator = new DeepResearchOrchestrator(options);
      const synthesis = '# Summary\nSome content.';
      
      // Inject some reports with citations
      (orchestrator as any).reports.set('1.r1', 'Report 1\n\n### CITED LINKS\n[1] https://a.com — Desc A');
      (orchestrator as any).reports.set('1.r2', 'Report 2\n\n### CITED LINKS\n[1] https://b.com — Desc B');

      const result = (orchestrator as any).ensureCitedLinks(synthesis);
      expect(result).toContain('### CITED LINKS');
      expect(result).toContain('https://a.com');
      expect(result).toContain('https://b.com');
    });

    it('returns original synthesis if CITED LINKS already exists', () => {
      const orchestrator = new DeepResearchOrchestrator(options);
      const synthesis = '# Summary\n### CITED LINKS\n[1] https://existing.com';
      const result = (orchestrator as any).ensureCitedLinks(synthesis);
      expect(result).toBe(synthesis);
    });
  });

  it('should handle researcher retries and eventual failure', async () => {
    vi.useFakeTimers();
    const { createResearcherSession } = await import('../../../src/orchestration/researcher.ts');
    const { search } = await import('../../../src/web-research/search.ts');
    
    // Mock search to return results so researcher isn't skipped
    vi.mocked(search).mockResolvedValue([{ query: 'q1', results: [{ url: 'https://ex.com' }], error: null }]);

    // Mock researcher session to fail
    vi.mocked(createResearcherSession).mockResolvedValue({
      prompt: vi.fn().mockImplementation(() => Promise.reject(new Error('Network error'))),
      subscribe: vi.fn(() => () => {}),
      abort: vi.fn(async () => {}),
    } as any);

    // Mock planning
    vi.mocked(complete).mockResolvedValue({
      content: [{ type: 'text', text: '```json\n{ "researchers": [{ "id": "r1", "name": "R1", "goal": "G1", "queries": ["q1"] }], "allQueries": ["q1"] }\n```' }],
      usage: { totalTokens: 20 },
    } as any);

    const orchestrator = new DeepResearchOrchestrator(options);
    
    const promise = orchestrator.run();
    
    // Default config has RESEARCHER_MAX_RETRIES = 3, so total 4 attempts
    // Need to advance timers for each retry delay
    for (let i = 0; i < 3; i++) {
        await vi.runAllTimersAsync();
    }
    
    const result = await promise;
    
    expect(createResearcherSession).toHaveBeenCalledTimes(4);
    expect(result).toContain('No researcher reports were generated');
    vi.useRealTimers();
  });

  describe('capResearcherQueries (private)', () => {
    it('filters out researchers with empty queries', () => {
      const orchestrator = new DeepResearchOrchestrator(options);
      const plan = {
        researchers: [
          { id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] },
          { id: 'r2', name: 'R2', goal: 'G2', queries: [] },
        ],
        allQueries: ['q1'],
      };
      const result = (orchestrator as any).capResearcherQueries(plan);
      expect(result.researchers).toHaveLength(1);
      expect(result.researchers[0].id).toBe('r1');
    });

    it('caps per-researcher queries to budget', () => {
      // complexity=1 budget is MAX_QUERIES_PER_RESEARCHER_LEVEL_1=10
      const orchestrator = new DeepResearchOrchestrator(options);
      const manyQueries = Array.from({ length: 15 }, (_, i) => `q${i}`);
      const plan = {
        researchers: [{ id: 1, name: 'R1', goal: 'G1', queries: manyQueries }],
        allQueries: manyQueries,
      };
      const result = (orchestrator as any).capResearcherQueries(plan);
      expect(result.researchers[0].queries.length).toBe(10);
    });

    it('normalizes researcher IDs to strings', () => {
      const orchestrator = new DeepResearchOrchestrator(options);
      const plan = {
        researchers: [{ id: 42, name: 'R1', goal: 'G1', queries: ['q1'] }],
        allQueries: ['q1'],
      };
      const result = (orchestrator as any).capResearcherQueries(plan);
      expect(result.researchers[0].id).toBe('42');
    });

    it('enforces round hard cap of 20 for complexity=1', () => {
      const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 1 });
      const makeResearcher = (id: string, n: number) => ({
        id, name: `R${id}`, goal: 'G', queries: Array.from({ length: n }, (_, i) => `${id}-q${i}`),
      });
      const plan = {
        researchers: [makeResearcher('r1', 15), makeResearcher('r2', 15)],
        allQueries: [],
      };
      const result = (orchestrator as any).capResearcherQueries(plan);
      const total = result.researchers.reduce((s: number, r: any) => s + r.queries.length, 0);
      expect(total).toBe(20);
    });

    it('returns plan unchanged when researchers is undefined', () => {
      const orchestrator = new DeepResearchOrchestrator(options);
      const plan = { allQueries: [] };
      const result = (orchestrator as any).capResearcherQueries(plan);
      expect(result).toEqual(plan);
    });
  });

  describe('parseJsonPlan (private)', () => {
    it('parses valid JSON plan from text', () => {
      const orchestrator = new DeepResearchOrchestrator(options);
      const text = '```json\n{ "researchers": [{ "id": "r1", "name": "R1", "goal": "G1", "queries": ["q1"] }], "allQueries": ["q1"] }\n```';
      const plan = (orchestrator as any).parseJsonPlan(text);
      expect(plan.researchers).toHaveLength(1);
      expect(plan.researchers[0].id).toBe('r1');
    });

    it('throws on invalid JSON', () => {
      const orchestrator = new DeepResearchOrchestrator(options);
      expect(() => (orchestrator as any).parseJsonPlan('not json at all')).toThrow();
    });

    it('throws when researchers is not an array', () => {
      const orchestrator = new DeepResearchOrchestrator(options);
      const text = '```json\n{ "researchers": "wrong" }\n```';
      expect(() => (orchestrator as any).parseJsonPlan(text)).toThrow();
    });
  });

  describe('buildFallbackCoordinatorPlan (private)', () => {
    it('returns a single-researcher plan with action delegate', () => {
      const orchestrator = new DeepResearchOrchestrator({ ...options, query: 'best AI models 2025' });
      const plan = (orchestrator as any).buildFallbackCoordinatorPlan('');
      expect(plan.action).toBe('delegate');
      expect(plan.researchers).toHaveLength(1);
      expect(plan.researchers[0].queries.length).toBeGreaterThan(0);
    });

    it('includes the original query as one of the queries', () => {
      const orchestrator = new DeepResearchOrchestrator({ ...options, query: 'specific test query' });
      const plan = (orchestrator as any).buildFallbackCoordinatorPlan('');
      expect(plan.allQueries).toContain('specific test query');
    });
  });

  describe('distributeResults (private)', () => {
    it('assigns links to researcher whose query exactly matches', () => {
      const orchestrator = new DeepResearchOrchestrator(options);
      const plan = {
        researchers: [
          { id: 'r1', name: 'R1', goal: 'G1', queries: ['quantum computing'] },
          { id: 'r2', name: 'R2', goal: 'G2', queries: ['machine learning'] },
        ],
      };
      const results = [
        { query: 'quantum computing', results: [{ url: 'https://quantum.example.com' }], error: null },
        { query: 'machine learning', results: [{ url: 'https://ml.example.com' }], error: null },
      ];
      const map = (orchestrator as any).distributeResults(plan, results);
      expect(map.get('r1')).toContain('https://quantum.example.com');
      expect(map.get('r2')).toContain('https://ml.example.com');
    });

    it('assigns links via fuzzy matching when query is a substring', () => {
      const orchestrator = new DeepResearchOrchestrator(options);
      const plan = {
        researchers: [
          { id: 'r1', name: 'R1', goal: 'G1', queries: ['neural networks'] },
        ],
      };
      const results = [
        { query: 'neural networks overview', results: [{ url: 'https://nn.example.com' }], error: null },
      ];
      const map = (orchestrator as any).distributeResults(plan, results);
      expect(map.get('r1')).toContain('https://nn.example.com');
    });

    it('returns empty links for researcher with no matching queries', () => {
      const orchestrator = new DeepResearchOrchestrator(options);
      const plan = {
        researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['topic a'] }],
      };
      const results = [
        { query: 'completely different topic', results: [{ url: 'https://other.example.com' }], error: null },
      ];
      const map = (orchestrator as any).distributeResults(plan, results);
      expect(map.get('r1')).toEqual([]);
    });

    it('returns empty map when plan has no researchers', () => {
      const orchestrator = new DeepResearchOrchestrator(options);
      const map = (orchestrator as any).distributeResults({}, []);
      expect(map.size).toBe(0);
    });
  });
});
