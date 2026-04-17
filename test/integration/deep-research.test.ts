/**
 * Deep Research Integration Tests
 *
 * Tests the full deep research lifecycle with mocked models.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepResearchOrchestrator } from '../../src/orchestration/deep-research-orchestrator';
import { SessionManager } from '@mariozechner/pi-coding-agent';

// Mock dependencies
vi.mock('../../src/orchestration/researcher', () => ({
  createResearcherSession: vi.fn(async () => ({
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    appendMessage: vi.fn(),
    continue: vi.fn(async () => {}),
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'sibling findings' }] }],
    agent: { customTools: [] },
  })),
}));

vi.mock('../../src/infrastructure/searxng-lifecycle', () => ({
  getManager: vi.fn(() => ({})),
}));

describe('Deep Research Integration', () => {
  const mockCtx = {
    model: { id: 'test-model' },
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'test-key', headers: {} })),
    },
    cwd: '/test/cwd',
    sessionManager: SessionManager.inMemory(),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should run a full deep research session from planning to synthesis', async () => {
    // Mock doPlanning to immediately set completed state
    const orchestrator = new DeepResearchOrchestrator({
      ctx: mockCtx,
      model: mockCtx.model,
      query: 'how to build a deep research system',
      complexity: 2,
      onTokens: vi.fn(),
      onUpdate: vi.fn(),
      searxngUrl: 'http://localhost:8888',
      panelState: {
        sessionId: 'test-session',
        query: 'how to build a deep research system',
        searxngStatus: { state: 'inactive', url: '', isFunctional: false },
        totalTokens: 0,
        slices: new Map(),
        modelName: 'test-model',
      } as any,
    });

    vi.spyOn(orchestrator as any, 'doPlanning').mockImplementation(async () => {
      (orchestrator as any).updateState({
        type: 'PLANNING_COMPLETE',
        agenda: ['aspect 1', 'aspect 2'],
        initialCount: 2
      });
      (orchestrator as any).state.status = 'completed';
      (orchestrator as any).state.finalSynthesis = 'test synthesis result';
    });

    const result = await orchestrator.run();
    expect(result).toBeDefined();
    expect(result).toBe('test synthesis result');
  });
});
