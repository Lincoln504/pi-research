/**
 * Swarm Orchestrator Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SwarmOrchestrator } from '../../../src/orchestration/swarm-orchestrator';

// Mock dependencies
const mockInitialize = vi.fn((q, c) => ({
  version: 1,
  rootQuery: q,
  complexity: c,
  currentRound: 1,
  status: 'planning',
  aspects: {},
  allScrapedLinks: [],
  initialAgenda: [],
}));
const mockSave = vi.fn();
const mockLoad = vi.fn();

vi.mock('../../../src/orchestration/state-manager', () => ({
  SwarmStateManager: class {
    initialize = mockInitialize;
    save = mockSave;
    load = mockLoad;
  }
}));

vi.mock('../../../src/orchestration/researcher', () => ({
  createResearcherSession: vi.fn(async () => ({
    subscribe: vi.fn(),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    appendMessage: vi.fn(),
    continue: vi.fn(async () => {}),
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'sibling report' }] }],
    agent: {},
  })),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  complete: vi.fn(async () => ({
    content: [{ type: 'text', text: '["aspect 1", "aspect 2"]' }],
  })),
}));

vi.mock('../../../src/orchestration/session-context', () => ({
  formatParentContext: vi.fn(async () => 'mock parent context'),
}));

vi.mock('../../../src/logger', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock TUI
vi.mock('../../../src/tui/research-panel', () => ({
  addSlice: vi.fn(),
  activateSlice: vi.fn(),
  completeSlice: vi.fn(),
  removeSlice: vi.fn(),
  flashSlice: vi.fn(),
}));

describe('SwarmOrchestrator', () => {
  const createMockOptions = () => ({
    ctx: {
      model: { id: 'test-model' },
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'test-key', headers: {} })),
      },
      cwd: '/test/cwd',
    } as any,
    query: 'test query',
    complexity: 2 as 1 | 2 | 3,
    onTokens: vi.fn(),
    onUpdate: vi.fn(),
    searxngUrl: 'http://localhost:8888',
    panelState: {},
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize and run planning phase', async () => {
    const options = createMockOptions();
    const orchestrator = new SwarmOrchestrator(options);
    
    const state = (orchestrator as any).state;
    
    // Mock the run loop to complete after planning
    vi.spyOn(orchestrator as any, 'doPlanning').mockImplementation(async () => {
      state.status = 'completed';
      state.finalSynthesis = 'final synthesis';
    });

    const result = await orchestrator.run();
    expect(result).toBe('final synthesis');
    expect((orchestrator as any).doPlanning).toHaveBeenCalled();
  });

  it('should transition from planning to researching', async () => {
    const options = createMockOptions();
    const orchestrator = new SwarmOrchestrator(options);
    const state = (orchestrator as any).state;

    // Run planning
    await (orchestrator as any).doPlanning();

    expect(state.status).toBe('researching');
    expect(state.initialAgenda).toEqual(['aspect 1', 'aspect 2']);
    expect(Object.keys(state.aspects)).toHaveLength(2);
  });

  it('should handle sibling execution and promotion', async () => {
    const options = createMockOptions();
    const orchestrator = new SwarmOrchestrator(options);
    const state = (orchestrator as any).state;
    state.status = 'researching';
    state.aspects['1.1'] = { id: '1.1', query: 'q1', status: 'pending' };

    // Mock completion to synthesize
    const { createResearcherSession } = await import('../../../src/orchestration/researcher');
    const mockSession: any = {
      subscribe: vi.fn(),
      prompt: vi.fn(async (p) => {
        if (p.includes('Lead Evaluator')) {
          return; // Lead evaluation prompt
        }
      }),
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final synthesis' }] }],
      agent: {},
    };
    vi.mocked(createResearcherSession).mockResolvedValue(mockSession);

    // Run sibling
    await (orchestrator as any).executeSibling(state.aspects['1.1']);

    expect(state.aspects['1.1'].status).toBe('completed');
    expect(state.status).toBe('completed');
    expect(state.finalSynthesis).toContain('final synthesis');
  });
});
