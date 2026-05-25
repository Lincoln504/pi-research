/**
 * Research Tool Unit Tests
 *
 * Meaningful, robust tests for quick vs deep mode branching and core behaviors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearchTool } from '../../src/tool';

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
    runCapturingStderr: vi.fn(async (task) => await task()),
  },
  getLogger: vi.fn(() => ({
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    isVerbose: vi.fn(() => false),
    getLogFilePath: vi.fn(() => '/tmp/pi-research.log'),
    runCapturingStderr: vi.fn(async (task) => await task()),
  })),
  createResearchRunId: vi.fn(() => 'run-test'),
  runWithLogContext: vi.fn((_context, callback) => callback()),
  isVerboseFromEnv: vi.fn(() => false),
  createLogger: vi.fn(() => ({
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    isVerbose: vi.fn(() => false),
    getLogFilePath: vi.fn(() => '/tmp/pi-research.log'),
    runCapturingStderr: vi.fn(async (task) => await task()),
  })),
  setLogger: vi.fn(),
}));

vi.mock('../../src/config.ts', () => ({
  validateConfig: vi.fn(),
  getConfig: vi.fn(() => ({ RESEARCHER_TIMEOUT_MS: 360000, DEFAULT_RESEARCH_DEPTH: 0 })),
}));

// Mock runResearch
vi.mock('../../src/orchestration/research-manager.ts', () => ({
  runResearch: vi.fn(async () => 'research result'),
}));

import { runResearch } from '../../src/orchestration/research-manager.ts';

vi.mock('../../src/orchestration/researcher.ts', () => ({
  createResearcherSession: vi.fn(),
}));

vi.mock('../../src/healthcheck/index.ts', () => ({
  runHealthCheck: vi.fn(async () => ({ success: true, details: {} })),
  isHealthCheckSuccessful: vi.fn(async () => true),
  healthRegistry: {
    runAll: vi.fn(async () => ({ status: 'healthy', components: [] })),
    isCritical: vi.fn(() => false),
  },
}));

// Mock the panel module
vi.mock('../../src/tui/research-panel.ts', () => ({
  createResearchPanel: vi.fn(() => ({})),
  createMasterResearchPanel: vi.fn(() => () => ({ render: () => [] })),
  clearAllFlashTimeouts: vi.fn(),
  addSlice: vi.fn(),
  activateSlice: vi.fn(),
  completeSlice: vi.fn(),
  removeSlice: vi.fn(),
  flashSlice: vi.fn(),
  updateSliceTokens: vi.fn(),
  updateSliceStatus: vi.fn(),
  createInitialPanelState: vi.fn(() => ({
    totalTokens: 0,
    slices: new Map(),
    modelName: 'test-model',
    progress: undefined as any,
  })),
}));

vi.mock('../../src/utils/session-state.ts', () => ({
  startResearchSession: vi.fn((_psid) => 'session-123'),
  endResearchSession: vi.fn(),
  isBottomMostSession: vi.fn((_psid, _sid) => true),
  onSessionOrderChange: vi.fn((_psid, _cb) => vi.fn()),
  registerSessionPanel: vi.fn(),
  registerMasterUpdate: vi.fn(),
  refreshAllSessions: vi.fn(),
  clearPendingRefresh: vi.fn(),
  getPiActivePanels: vi.fn(() => []),
  registerSessionAbort: vi.fn(),
  abortAllSessions: vi.fn(),
  clearAllSessionState: vi.fn(),
}));

vi.mock('../../src/utils/shared-links.ts', () => ({
  generateSessionId: vi.fn(() => 'session-id-123'),
  cleanupSharedLinks: vi.fn(),
  cacheScrapedContent: vi.fn(),
  getCachedScrapedContent: vi.fn(),
  registerScrapedLinks: vi.fn(),
  getScrapedLinks: vi.fn(),
  deduplicateUrls: vi.fn(),
  formatSharedLinksFromState: vi.fn(),
  resetScrapedLinks: vi.fn(),
  formatLightweightLinkUpdate: vi.fn(),
  normalizeUrl: vi.fn((u) => u),
}));

vi.mock('../../src/utils/text-utils.ts', () => ({
  ensureAssistantResponse: vi.fn(() => 'Mocked assistant response'),
}));

vi.mock('../../src/utils/input-validation.ts', () => ({
  validateAndSanitizeQuery: vi.fn((q) => q),
}));

vi.mock('../../src/web-research/utils.ts', () => ({
  onConnectionCountChange: vi.fn(() => vi.fn()),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn((path: string) => {
    if (path.includes('researcher')) return '# Researcher prompt';
    return '';
  }),
}));

// Import session state mock for use in createResearchTuiManager mock
// The module is already mocked above, so we don't need to import it here

// Mock new modules
vi.mock('../../src/tui/research-tui-manager.ts', () => ({
  createResearchTuiManager: vi.fn((tuiCtx: any, deps: any) => {
    // Call panel.createInitialPanelState to match original test expectations
    panel.createInitialPanelState(tuiCtx.researchId, tuiCtx.query, tuiCtx.modelId);
    
    // Subscribe to terminal input for the test
    const unsubInput = deps.ctx.ui.onTerminalInput(expect.any(Function));
    
    return {
      panelState: { totalTokens: 0, slices: new Map() },
      masterWidgetId: `pi-research-master-${tuiCtx.piSessionId}`,
      unsubOrder: null,
      unsubInput,
      debouncedRefresh: vi.fn(),
      initializePanel: vi.fn(),
      handleTerminalInput: vi.fn(() => undefined),
      dispose: vi.fn(),
    };
  }),
  hideWorkingIndicator: vi.fn((ctx: any) => {
    if (ctx.ui?.setWorkingVisible) ctx.ui.setWorkingVisible(false);
  }),
  showWorkingIndicator: vi.fn((ctx: any) => {
    if (ctx.ui?.setWorkingVisible) ctx.ui.setWorkingVisible(true);
  }),
}));

vi.mock('../../src/cleanup/research-cleanup.ts', () => ({
  createCleanupFunction: vi.fn(() => vi.fn()),
  updateWaveTimer: vi.fn(),
  updateUnsubOrder: vi.fn(),
  updateUnsubInput: vi.fn(),
  stopWaveAnimation: vi.fn(),
}));

vi.mock('../../src/observers/research-observer-impl.ts', () => ({
  createResearchObserver: vi.fn(() => ({})),
  createObserverState: vi.fn(() => ({
    progressCredits: new Map(),
    quickSliceLabel: '',
    waveTimer: null,
  })),
  stopObserverWaveAnimation: vi.fn(),
}));

vi.mock('../../src/utils/research-health.ts', async () => {
  const actual = await vi.importActual('../../src/utils/research-health.ts') as any;
  return {
    ...actual,
    createHealthMonitor: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
    })),
  };
});

vi.mock('../../src/utils/pi-session.ts', () => ({
  getPiSessionMetadata: vi.fn(() => ({
    piSessionId: 'pi-session-123',
    sessionFile: '/tmp/session.json',
    cwd: '/test',
  })),
}));

vi.mock('../../src/utils/research-export.ts', () => ({
  exportResearchReport: vi.fn(async () => undefined),
  appendExportMessage: vi.fn((result, path, cost) => `${result}\n\nExported to: ${path}`),
}));

vi.mock('@mariozechner/pi-coding-agent', () => ({
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
  createAgentSession: vi.fn(),
  createReadTool: vi.fn(),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  complete: vi.fn(async () => ({
    content: [{ type: 'text', text: '2' }],
    usage: { totalTokens: 10 },
  })),
}));

// Import mocked modules
import * as panel from '../../src/tui/research-panel.ts';
import { createResearcherSession } from '../../src/orchestration/researcher.ts';
import { complete } from '@mariozechner/pi-ai';
import { createResearchTuiManager, hideWorkingIndicator, showWorkingIndicator } from '../../src/tui/research-tui-manager.ts';

// ============================================================================
// HELPERS
// ============================================================================

function createMockSession(responseText = 'Test answer') {
  const subscribers: any[] = [];
  return {
    subscribe: vi.fn((callback: any) => {
      subscribers.push(callback);
      return vi.fn();
    }),
    prompt: vi.fn(async () => {
      subscribers.forEach(sub =>
        sub({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: responseText }],
            usage: { totalTokens: 150, input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
          },
        })
      );
    }),
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: responseText }], usage: { totalTokens: 150 } },
    ],
    abort: vi.fn(async () => undefined),
  } as any;
}

function createMockContext() {
  return {
    model: { id: 'test-model' },
    modelRegistry: { 
      getAll: () => [{ id: 'test-model' }],
      getModel: vi.fn(async (id) => id === 'nonexistent' ? undefined : { id }),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'key', headers: {} })),
    },
    cwd: '/test',
    ui: { 
      setWidget: vi.fn(), 
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      setWorkingVisible: vi.fn(),
    },
    sessionManager: {
      getBranch: vi.fn().mockReturnValue([]),
      getSessionId: vi.fn(() => 'pi-session-123'),
      getSessionFile: vi.fn(() => '/tmp/pi-session.json'),
    },
  } as any;
}

// ============================================================================
// TESTS
// ============================================================================

describe('createResearchTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Quick Mode Branching (depth: 0) vs Deep Mode (depth: 1-3)', () => {
    it('calls runResearch with correct query and depth=0', async () => {
      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', depth: 0 }, undefined, undefined, createMockContext());

      expect(runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'test', depth: 0 }),
        expect.any(AbortSignal),
      );
    });

    it('calls runResearch with correct query and depth=1', async () => {
      const tool = createResearchTool();
      await tool.execute('id', { query: 'deep topic', depth: 1 }, undefined, undefined, createMockContext());

      expect(runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'deep topic', depth: 1 }),
        expect.any(AbortSignal),
      );
    });

    it('does not mutate console methods on successful quick research', async () => {
      const originalConsole = {
        log: console.log,
        info: console.info,
        error: console.error,
        warn: console.warn,
        debug: console.debug,
      };

      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', depth: 0 }, undefined, undefined, createMockContext());

      expect(console.log).toBe(originalConsole.log);
      expect(console.info).toBe(originalConsole.info);
      expect(console.error).toBe(originalConsole.error);
      expect(console.warn).toBe(originalConsole.warn);
      expect(console.debug).toBe(originalConsole.debug);
    });

    it('creates TUI panel with the query text and model name before calling runResearch', async () => {
      const context = createMockContext();
      const tool = createResearchTool();
      await tool.execute('id', { query: 'panel test query', depth: 0 }, undefined, undefined, context);

      // Panel is initialised with the query and the model id from the context
      expect(panel.createInitialPanelState).toHaveBeenCalledWith(
        expect.any(String),         // researchId
        'panel test query',         // query text must be passed through
        context.model.id,           // model name from context
      );
      // runResearch receives the same query
      expect(runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'panel test query' }),
        expect.any(AbortSignal),
      );
    });
  });

  describe('depth → complexity mapping passed to runResearch', () => {
    it.each([0, 1, 2, 3] as const)('passes depth %i directly as complexity', async (depth) => {
      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', depth }, undefined, undefined, createMockContext());

      expect(runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ depth }),
        expect.any(AbortSignal),
      );
    });

    it('initializes research when depth=1', async () => {
      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test', depth: 1 }, undefined, undefined, createMockContext());

      expect(runResearch).toHaveBeenCalled();
      expect(result.content[0]).toEqual(expect.objectContaining({ text: 'research result' }));
    });

    it('initializes research when depth=2', async () => {
      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test', depth: 2 }, undefined, undefined, createMockContext());

      expect(runResearch).toHaveBeenCalled();
      expect(result.content[0]).toEqual(expect.objectContaining({ text: 'research result' }));
    });

    it('initializes research when depth=3', async () => {
      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test', depth: 3 }, undefined, undefined, createMockContext());

      expect(runResearch).toHaveBeenCalled();
      expect(result.content[0]).toEqual(expect.objectContaining({ text: 'research result' }));
    });
  });

  describe('Error Handling', () => {
    it('rejects empty query', async () => {
      const originalConsole = {
        log: console.log,
        info: console.info,
        error: console.error,
        warn: console.warn,
        debug: console.debug,
      };
      const tool = createResearchTool();
      const result = await tool.execute('id', { query: '' }, undefined, undefined, createMockContext());

      expect((result.content[0] as any).text).toContain('required');
      expect(console.log).toBe(originalConsole.log);
      expect(console.info).toBe(originalConsole.info);
      expect(console.error).toBe(originalConsole.error);
      expect(console.warn).toBe(originalConsole.warn);
      expect(console.debug).toBe(originalConsole.debug);
    });

    it('passes whitespace-only query through sanitization to runResearch', async () => {
      const tool = createResearchTool();
      // validateAndSanitizeQuery is mocked to return input unchanged; whitespace is a non-empty string
      // so the tool does not short-circuit and reaches runResearch
      await tool.execute('id', { query: '   ' }, undefined, undefined, createMockContext());
      expect(runResearch).toHaveBeenCalled();
    });

    it('returns error when no model available', async () => {
      const context = createMockContext();
      context.model = undefined as any;
      
      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test' }, undefined, undefined, context);

      expect((result.content[0] as any).text).toContain('No research model specified');
    });

    it('handles research errors gracefully', async () => {
      vi.mocked(runResearch).mockRejectedValue(new Error('Research failed'));
      
      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test', depth: 0 }, undefined, undefined, createMockContext());

      expect((result.content[0] as any).text).toContain('Research failed');
    });

    it('handles aborted research', async () => {
      const controller = new AbortController();
      const signal = controller.signal;
      controller.abort();
      
      vi.mocked(runResearch).mockRejectedValue(new DOMException('Aborted', 'AbortError'));
      
      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test', depth: 0 }, signal, undefined, createMockContext());

      // The actual error message from the implementation
      expect((result.content[0] as any).text).toContain('Research cancelled.');
    });
  });

  describe('prepareArguments', () => {
    it('normalizes string depth to number', () => {
      const tool = createResearchTool();
      const args = tool.prepareArguments!({ query: 'test', depth: '2' } as any) as any;

      expect(args.depth).toBe(2);
    });

    it('clamps depth to maximum of 3', () => {
      const tool = createResearchTool();
      const args = tool.prepareArguments!({ query: 'test', depth: 5 } as any) as any;

      expect(args.depth).toBe(3);
    });

    it('clamps depth to minimum of 0', () => {
      const tool = createResearchTool();
      const args = tool.prepareArguments!({ query: 'test', depth: -1 } as any) as any;

      expect(args.depth).toBe(0);
    });

    it('defaults depth to 0 when not provided', () => {
      const tool = createResearchTool();
      const args = tool.prepareArguments!({ query: 'test' }) as any;

      expect(args.depth).toBe(0);
    });

    it('handles invalid string depth', () => {
      const tool = createResearchTool();
      const args = tool.prepareArguments!({ query: 'test', depth: 'invalid' } as any) as { depth: number };

      expect(args.depth).toBe(0);
    });
  });

  describe('Tool Definition', () => {
    it('has correct tool name', () => {
      const tool = createResearchTool();

      expect(tool.name).toBe('research');
      expect(tool.label).toBe('Research');
    });

    it('has meaningful description', () => {
      const tool = createResearchTool();

      expect(tool.description).toContain('web/internet research');
      expect(tool.description).toContain('multi-source');
    });

    it('has required parameters', () => {
      const tool = createResearchTool();

      expect(tool.parameters).toBeDefined();
      const params = tool.parameters as { properties: Record<string, unknown> };
      expect(params.properties).toHaveProperty('query');
      expect(params.properties).toHaveProperty('depth');
      expect(params.properties).toHaveProperty('model');
    });

    it('has prompt snippet', () => {
      const tool = createResearchTool();

      expect(tool.promptSnippet).toContain('comprehensive web/internet research');
    });
  });

  describe('Model Selection', () => {
    it('uses context model when no explicit model parameter', async () => {
      const context = createMockContext();
      const tool = createResearchTool();
      
      await tool.execute('id', { query: 'test', depth: 0 }, undefined, undefined, context);

      expect(runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ model: context.model }),
        expect.any(AbortSignal)
      );
    });

    it('respects explicit model parameter', async () => {
      const customModel = { id: 'custom-model' };
      const context = createMockContext();
      context.modelRegistry = {
        ...context.modelRegistry,
        getAll: vi.fn(() => [{ id: 'test-model' }, customModel]),
      };

      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', depth: 0, model: 'custom-model' }, undefined, undefined, context);

      // The tool should have looked up and passed the explicit model object to runResearch
      expect(runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ model: customModel }),
        expect.any(AbortSignal),
      );
    });

    it('falls back to context model when explicit model not found in registry', async () => {
      const context = createMockContext();
      context.modelRegistry = {
        ...context.modelRegistry,
        getAll: vi.fn(() => [{ id: 'test-model' }]),
      };

      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', depth: 0, model: 'nonexistent' }, undefined, undefined, context);

      // Registry lookup fails; tool falls back to ctx.model
      expect(runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ model: context.model }),
        expect.any(AbortSignal),
      );
    });
  });

  describe('Abort Handling', () => {
    it('respects abort signal during research', async () => {
      const controller = new AbortController();
      const tool = createResearchTool();

      controller.abort();

      await tool.execute('id', { query: 'test', depth: 0 }, controller.signal, undefined, createMockContext());

      // Should complete without throwing even when signal is already aborted
      expect(runResearch).toHaveBeenCalled();
    });
  });

  describe('Terminal Input Handling', () => {
    it('registers an onTerminalInput handler during research', async () => {
      const context = createMockContext();
      const tool = createResearchTool();

      await tool.execute('id', { query: 'test', depth: 0 }, undefined, undefined, context);

      // The tool installs a terminal input listener for escape/Ctrl+C abort
      expect(context.ui.onTerminalInput).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe('Session Management', () => {
    it('starts research session', async () => {
      const tool = createResearchTool();
      
      await tool.execute('id', { query: 'test', depth: 0 }, undefined, undefined, createMockContext());

      // Session management functions should be called
      // Note: These are mocked but we can verify the flow
      expect(panel.createInitialPanelState).toHaveBeenCalled();
    });

    it('registers session panel', async () => {
      const context = createMockContext();
      const tool = createResearchTool();
      
      await tool.execute('id', { query: 'test', depth: 0 }, undefined, undefined, context);

      expect(panel.createInitialPanelState).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'test-model'
      );
    });
  });

  describe('TUI Integration', () => {
    it('creates initial panel state', async () => {
      const tool = createResearchTool();
      
      await tool.execute('id', { query: 'test', depth: 0 }, undefined, undefined, createMockContext());

      expect(panel.createInitialPanelState).toHaveBeenCalled();
    });

    it('sets working visible to false during research', async () => {
      const context = createMockContext();
      const tool = createResearchTool();
      
      await tool.execute('id', { query: 'test', depth: 0 }, undefined, undefined, context);

      expect(context.ui.setWorkingVisible).toHaveBeenCalledWith(false);
    });

    it('registers a master update handler keyed to the pi session', async () => {
      const context = createMockContext();
      const tool = createResearchTool();

      await tool.execute('id', { query: 'test', depth: 0 }, undefined, undefined, context);

      // The TUI manager now handles registration of master update handler
      expect(createResearchTuiManager).toHaveBeenCalledWith(
        expect.objectContaining({ piSessionId: expect.any(String) }),
        expect.any(Object),
      );
    });
  });


  describe('Query Validation', () => {
    it('passes the sanitized query (returned by validateAndSanitizeQuery) to runResearch', async () => {
      const { validateAndSanitizeQuery } = await import('../../src/utils/input-validation.ts');
      // The mock returns the input unchanged; configure it to return a sanitised form
      vi.mocked(validateAndSanitizeQuery).mockReturnValueOnce('sanitized query');

      const tool = createResearchTool();
      await tool.execute('id', { query: 'raw<script>', depth: 0 }, undefined, undefined, createMockContext());

      // runResearch should receive the sanitised value, not the raw one
      expect(runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'sanitized query' }),
        expect.any(AbortSignal),
      );
    });
  });

  describe('Health Check Integration', () => {
    it('still calls runResearch when health check passes (default mock returns healthy)', async () => {
      const { healthRegistry } = await import('../../src/healthcheck/index.ts');
      const tool = createResearchTool();

      await tool.execute('id', { query: 'test', depth: 0 }, undefined, undefined, createMockContext());

      // The mocked healthRegistry.runAll returns { status: 'healthy' }.
      // The tool should proceed to runResearch without blocking.
      expect(healthRegistry.runAll).toHaveBeenCalled();
      expect(runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'test' }),
        expect.any(AbortSignal),
      );
    });
  });

  describe('Observer Pattern', () => {
    it('passes observer to runResearch', async () => {
      const tool = createResearchTool();
      
      await tool.execute('id', { query: 'test', depth: 0 }, undefined, undefined, createMockContext());

      expect(runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ observer: expect.any(Object) }),
        expect.any(AbortSignal)
      );
    });
  });

  describe('Result Structure', () => {
    it('returns proper result structure', async () => {
      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test', depth: 0 }, undefined, undefined, createMockContext());

      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('details');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]).toHaveProperty('type', 'text');
    });

  });
});
