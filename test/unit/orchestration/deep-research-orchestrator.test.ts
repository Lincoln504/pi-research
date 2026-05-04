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
    getHistory: () => [{ role: 'assistant', content: [{ type: 'text', text: 'Report content' }] }],
  })),
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

  it('should handle planning failure and fallback', async () => {
    vi.mocked(complete).mockRejectedValue(new Error('Planning failed'));

    const orchestrator = new DeepResearchOrchestrator(options);
    const result = await orchestrator.run();

    expect(result).toContain('Research failed');
  });
});
