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
    subscribe: vi.fn(() => () => {}),
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

vi.mock('../../../src/orchestration/swarm-reducer', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    swarmReducer: vi.fn(actual.swarmReducer),
  };
});

describe('SwarmOrchestrator', () => {
  const createMockOptions = () => ({
    ctx: {
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'test-key', headers: {} })),
      },
      cwd: '/test/cwd',
    } as any,
    model: { id: 'test-model' } as any,
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
    
    // Mock the run loop to complete after planning
    vi.spyOn(orchestrator as any, 'doPlanning').mockImplementation(async () => {
      (orchestrator as any).state.status = 'completed';
      (orchestrator as any).state.finalSynthesis = 'final synthesis';
    });

    const result = await orchestrator.run();
    expect(result).toBe('final synthesis');
    expect((orchestrator as any).doPlanning).toHaveBeenCalled();
  });

  it('should transition from planning to researching', async () => {
    const options = createMockOptions();
    const orchestrator = new SwarmOrchestrator(options);

    // Run planning
    await (orchestrator as any).doPlanning();

    const state = (orchestrator as any).state;
    expect(state.status).toBe('researching');
    expect(state.initialAgenda).toEqual(['aspect 1', 'aspect 2']);
    expect(Object.keys(state.aspects)).toHaveLength(2);
  });

  it('should handle sibling execution and promotion', async () => {
    const options = createMockOptions();
    const orchestrator = new SwarmOrchestrator(options);

    // Setup orchestrator state
    (orchestrator as any).state.status = 'researching';
    (orchestrator as any).state.aspects['1.1'] = { id: '1.1', query: 'q1', status: 'pending' };

    // Mock completion to synthesize
    const { complete } = await import('@mariozechner/pi-ai');
    vi.mocked(complete).mockResolvedValue({
      content: [{ type: 'text', text: '# final synthesis' }],
    } as any);

    // Run sibling
    const aspect = (orchestrator as any).state.aspects['1.1'];
    await (orchestrator as any).executeSibling(aspect);

    // Check orchestrator's internal state
    const finalState = (orchestrator as any).state;
    expect(finalState.aspects['1.1'].status).toBe('completed');
    expect(finalState.status).toBe('completed');
    expect(finalState.finalSynthesis).toContain('final synthesis');
  });

  it('should fail the task if all siblings fail in the first round', async () => {
    const options = createMockOptions();
    const orchestrator = new SwarmOrchestrator(options);

    // Setup orchestrator state with two siblings
    (orchestrator as any).state.status = 'researching';
    (orchestrator as any).state.aspects['1.1'] = { id: '1.1', query: 'q1', status: 'pending' };
    (orchestrator as any).state.aspects['1.2'] = { id: '1.2', query: 'q2', status: 'pending' };

    // Mock researcher to fail
    const { createResearcherSession } = await import('../../../src/orchestration/researcher');
    vi.mocked(createResearcherSession).mockImplementation(async () => {
      throw new Error('Provider error');
    });

    // Run first sibling - it should fail but NOT trigger total failure yet
    await (orchestrator as any).executeSibling((orchestrator as any).state.aspects['1.1']);
    expect((orchestrator as any).state.aspects['1.1'].status).toBe('failed');
    
    // Total failure shouldn't have happened yet
    let rejectedError: any;
    (orchestrator as any).run().catch((e: any) => rejectedError = e);

    // Run second sibling - it should fail and trigger total failure
    await (orchestrator as any).executeSibling((orchestrator as any).state.aspects['1.2']);
    
    // Wait for the run promise to reject
    await new Promise(resolve => setTimeout(resolve, 10));
    
    expect(rejectedError).toBeDefined();
    expect(rejectedError.message).toContain('Research failed');
    expect(rejectedError.message).toContain('• Researcher 1: Error: Provider error');
    expect(rejectedError.message).toContain('• Researcher 2: Error: Provider error');
  });

  it('should fail the task on resumption if all siblings in the current round have failed', async () => {
    const options = createMockOptions();
    const orchestrator = new SwarmOrchestrator(options);

    // Setup state as if it just resumed with two failed siblings
    (orchestrator as any).state.status = 'researching';
    (orchestrator as any).state.currentRound = 1;
    (orchestrator as any).state.aspects['1.1'] = { id: '1.1', query: 'q1', status: 'failed', error: 'Network error' };
    (orchestrator as any).state.aspects['1.2'] = { id: '1.2', query: 'q2', status: 'failed', error: 'Timeout' };

    let rejectedError: any;
    (orchestrator as any).rejectCompletion = vi.fn((e) => rejectedError = e);

    await (orchestrator as any).startRound();

    expect(rejectedError).toBeDefined();
    expect(rejectedError.message).toContain('Research failed on resumption');
    expect(rejectedError.message).toContain('Researcher 1: Network error');
    expect(rejectedError.message).toContain('Researcher 2: Timeout');
  });
});
