/**
 * Research Tool Robustness Tests
 * 
 * Verifies that the "Working..." indicator and UI widgets are handled
 * correctly during simultaneous research tool executions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearchTool } from '../../src/tool';
import { getPiActivePanels } from '../../src/utils/session-state';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createResearchRunId: vi.fn(() => 'run-test'),
  runWithLogContext: vi.fn((_context, callback) => callback()),
  isVerboseFromEnv: vi.fn(() => false),
}));

vi.mock('../../src/config.ts', () => ({
  validateConfig: vi.fn(),
  getConfig: vi.fn(() => ({ RESEARCHER_TIMEOUT_MS: 360000, DEFAULT_RESEARCH_DEPTH: 0 })),
}));

vi.mock('../../src/orchestration/research-manager.ts', () => ({
  runResearch: vi.fn(async () => 'research result'),
}));

vi.mock('../../src/healthcheck/index.ts', () => ({
  runHealthCheck: vi.fn(async () => ({ success: true, details: {} })),
  isHealthCheckSuccessful: vi.fn(async () => true),
}));

vi.mock('../../src/tui/research-panel.ts', () => ({
  createMasterResearchPanel: vi.fn(() => () => ({ render: () => [] })),
  addSlice: vi.fn(),
  activateSlice: vi.fn(),
  completeSlice: vi.fn(),
  removeSlice: vi.fn(),
  updateSliceTokens: vi.fn(),
  updateSliceStatus: vi.fn(),
  createInitialPanelState: vi.fn(() => ({
    totalTokens: 0,
    slices: new Map(),
    modelName: 'test-model',
  })),
}));

vi.mock('../../src/utils/session-state.ts', () => ({
  startResearchSession: vi.fn((_psid) => 'session-123'),
  endResearchSession: vi.fn(),
  registerSessionPanel: vi.fn(),
  registerMasterUpdate: vi.fn(),
  refreshAllSessions: vi.fn(),
  onSessionOrderChange: vi.fn((_psid, _cb) => vi.fn()),
  getPiActivePanels: vi.fn(), // We will control this in tests
  registerSessionAbort: vi.fn(),
  abortAllSessions: vi.fn(),
}));

vi.mock('../../src/utils/shared-links.ts', () => ({
  cleanupSharedLinks: vi.fn(),
}));

vi.mock('../../src/utils/input-validation.ts', () => ({
  validateAndSanitizeQuery: vi.fn((q) => q),
}));

// ============================================================================
// HELPERS
// ============================================================================

function createMockContext() {
  return {
    model: { id: 'test-model' },
    modelRegistry: { 
      getAll: () => [{ id: 'test-model' }],
    },
    cwd: '/test',
    ui: { 
      setWidget: vi.fn(), 
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      setWorkingVisible: vi.fn(),
    },
    sessionManager: {
      getSessionId: vi.fn(() => 'pi-session-123'),
      getSessionFile: vi.fn(() => '/tmp/pi-session.json'),
    },
  } as any;
}

// ============================================================================
// TESTS
// ============================================================================

describe('Research Tool UI Coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps Working indicator hidden if other research sessions are active', async () => {
    const tool = createResearchTool();
    const ctx = createMockContext();
    
    // Simulate one session remaining after this one finishes
    vi.mocked(getPiActivePanels).mockReturnValueOnce([{}] as any);

    await tool.execute('id', { query: 'test' }, undefined, undefined, ctx);

    // Initial start should hide it
    expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(false);
    
    // On finish, it should NOT be set to true because activePanels.length > 0
    // Note: In our mock, we returned [{}] once, which represents the remaining session.
    // Our code calls getPiActivePanels AFTER endResearchSession.
    
    const setWorkingVisibleCalls = vi.mocked(ctx.ui.setWorkingVisible).mock.calls;
    const trueCalls = setWorkingVisibleCalls.filter(call => call[0] === true);
    
    expect(trueCalls.length).toBe(0);
  });

  it('restores Working indicator only when the last research session finishes', async () => {
    const tool = createResearchTool();
    const ctx = createMockContext();
    
    // Simulate NO sessions remaining after this one finishes
    vi.mocked(getPiActivePanels).mockReturnValueOnce([]);

    await tool.execute('id', { query: 'test' }, undefined, undefined, ctx);

    // Initial start should hide it
    expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(false);
    
    // On finish, it SHOULD be set to true because activePanels.length === 0
    expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(true);
  });

  it('clears the Master Widget only when the last research session finishes', async () => {
    const tool = createResearchTool();
    const ctx = createMockContext();
    const masterWidgetId = `pi-research-master-pi-session-123`;
    
    // Case 1: Sessions still active
    vi.mocked(getPiActivePanels).mockReturnValueOnce([{}] as any);
    await tool.execute('id1', { query: 'test1' }, undefined, undefined, ctx);
    
    // Should NOT clear the widget
    expect(ctx.ui.setWidget).not.toHaveBeenCalledWith(masterWidgetId, undefined);

    // Case 2: Last session finishing
    vi.mocked(getPiActivePanels).mockReturnValueOnce([]);
    await tool.execute('id2', { query: 'test2' }, undefined, undefined, ctx);
    
    // SHOULD clear the widget
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(masterWidgetId, undefined);
  });
});
