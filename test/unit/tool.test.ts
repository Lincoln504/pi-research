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
  runWithLogger: vi.fn(async (_logger, fn) => await fn()),
}));

vi.mock('../../src/config.ts', () => ({
  validateConfig: vi.fn(),
  getConfig: vi.fn(() => ({ RESEARCHER_TIMEOUT_MS: 360000, DEFAULT_RESEARCH_DEPTH: 1 })),
}));

vi.mock('../../src/utils/metrics.ts', () => ({
  metrics: {
    increment: vi.fn(),
    recordRunSummary: vi.fn(),
    setGauge: vi.fn(),
    observe: vi.fn(),
    getSnapshot: vi.fn(() => ({ counters: {}, gauges: {}, histograms: {} })),
  },
  MetricsRegistry: class {
    increment = vi.fn();
    setGauge = vi.fn();
    observe = vi.fn();
    getSnapshot = vi.fn(() => ({ counters: {}, gauges: {}, histograms: {} }));
  },
  runWithRunRegistry: vi.fn(async (_registry, fn) => await fn()),
}));

import { ServiceNames } from '../../src/core/interfaces/service-names.ts';

// Mock IResearchOrchestration
const mockRunResearch = vi.fn(async () => 'research result');
const mockResolveResearchModel = vi.fn(async (options: any) => ({
  id: options.model?.id || options.ctx?.model?.id || 'ctx-model',
  provider: 'mock-provider',
  contextWindow: 128000,
}));

vi.mock('../../src/core/service-registry.ts', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getServiceContainer: vi.fn(() => ({
      isReady: true,
    })),
    getService: vi.fn(async (name) => {
      if (name === ServiceNames.RESEARCH_ORCHESTRATION) {
        return {
          runResearch: mockRunResearch,
          resolveResearchModel: mockResolveResearchModel,
          cleanupResearchServices: vi.fn(),
        };
      }
      return {};
    }),
    tryGetServiceContainerFromCtx: vi.fn((ctx: any) => ctx?.container || { isReady: true }),
  };
});

vi.mock('../../src/utils/text-utils.ts', () => ({
  ensureAssistantResponse: vi.fn(() => 'Mocked assistant response'),
  parseCitations: vi.fn(() => []),
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

vi.mock('../../src/orchestration/session-state.ts', () => ({
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
  clearSteeringMessages: vi.fn(),
  getSteeringMessages: vi.fn(() => []),
  getAllTrackedSessions: vi.fn(() => []),
  normalizeSessionId: vi.fn((id) => id || 'default'),
}));

vi.mock('../../src/utils/shared-links.ts', () => ({
  generateSessionId: vi.fn(() => 'session-id-123'),
  cleanupSharedLinks: vi.fn(),
  cacheScrapedContent: vi.fn(),
  getCachedScrapedContent: vi.fn(),
  registerScrapedLinks: vi.fn(),
  getScrapedLinks: vi.fn(),
  deduplicateUrls: vi.fn(),
  normalizeUrl: vi.fn((u) => u),
  registerResearcherScrapes: vi.fn(),
  buildSessionPoolFooter: vi.fn(() => ''),
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

vi.mock('../../src/tui/research-health.ts', () => ({
  ensureFunctionalHealth: vi.fn(async () => undefined),
  createHealthMonitor: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../../src/tui/research-tui-manager.ts', () => ({
  createResearchTuiManager: vi.fn((tuiCtx: any, deps: any) => {
    panel.createInitialPanelState(tuiCtx.piSessionId, tuiCtx.researchId, tuiCtx.query, tuiCtx.modelId);
    const unsubInput = deps.ctx.ui.onTerminalInput(vi.fn());
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
  updateUnsubOrder: vi.fn(),
}));

vi.mock('../../src/observers/research-observer-impl.ts', () => ({
  createResearchObserver: vi.fn(() => ({})),
  createObserverState: vi.fn(() => ({
    progressCredits: new Map(),
    quickSliceLabel: '',
  })),
  stopObserverWaveAnimation: vi.fn(),
}));

vi.mock('../../src/utils/error-tracker.ts', () => ({
  runWithTracker: vi.fn(async (_tracker, fn) => await fn()),
  ErrorTracker: class {
    getReport = vi.fn(() => ({ totalErrors: 0 }));
  },
}));

vi.mock('../../src/utils/research-export.ts', () => ({
  exportResearchReport: vi.fn(async () => undefined),
  appendExportMessage: vi.fn((result, path, _cost) => `${result}\n\nExported to: ${path}`),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
  createAgentSession: vi.fn(),
  createReadToolDefinition: vi.fn(),
}));

// Import mocked modules
import * as panel from '../../src/tui/research-panel.ts';

// ============================================================================
// HELPERS
// ============================================================================

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
    process.env['PI_RESEARCH_FORCE_READY'] = 'true';
  });

  describe('Normal Mode (depth: 1) vs Deep Mode (depth: 2-3)', () => {
    it('calls runResearch with correct query and depth=1', async () => {
      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', depth: 1 }, undefined, undefined, createMockContext());

      expect(mockRunResearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'test', depth: 1 }),
        expect.any(AbortSignal),
      );
    });

    it('creates TUI panel with the query text and model name before calling runResearch', async () => {
      const context = createMockContext();
      context.mode = 'tui';
      context.hasUI = true;
      
      const tool = createResearchTool();
      await tool.execute('id', { query: 'panel test query', depth: 1 }, undefined, undefined, context);

      expect(panel.createInitialPanelState).toHaveBeenCalled();
      expect(mockRunResearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'panel test query' }),
        expect.any(AbortSignal),
      );
    });
  });

  describe('depth → complexity mapping passed to runResearch', () => {
    it.each([1, 2, 3] as const)('passes depth %i directly as complexity', async (depth) => {
      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', depth }, undefined, undefined, createMockContext());

      expect(mockRunResearch).toHaveBeenCalledWith(
        expect.objectContaining({ depth }),
        expect.any(AbortSignal),
      );
    });
  });

  describe('Error Handling', () => {
    it('rejects empty query', async () => {
      const tool = createResearchTool();
      const result = await tool.execute('id', { query: '' }, undefined, undefined, createMockContext());
      expect((result.content[0] as any).text).toContain('requires a query');
    });

    it('handles research errors gracefully', async () => {
      mockRunResearch.mockRejectedValueOnce(new Error('Research failed'));
      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test', depth: 1 }, undefined, undefined, createMockContext());
      expect((result.content[0] as any).text).toContain('Research failed');
    });
  });

  describe('initialLinks validation (parity with CLI --initial-links)', () => {
    it('rejects more than 20 initialLinks', async () => {
      const tool = createResearchTool();
      const links = Array.from({ length: 21 }, (_, i) => `https://example.com/page${i}`);
      const result = await tool.execute('id', { query: 'test', initialLinks: links }, undefined, undefined, createMockContext());
      expect((result.content[0] as any).text).toContain('invalid initialLinks');
      expect((result.content[0] as any).text).toContain('at most 20 URLs');
      expect((result.details as any).error).toBe('invalid_initial_links');
      expect(mockRunResearch).not.toHaveBeenCalled();
    });

    it('rejects non-http(s) links (file:, javascript:)', async () => {
      const tool = createResearchTool();
      for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com/x']) {
        mockRunResearch.mockClear();
        const result = await tool.execute('id', { query: 'test', initialLinks: [bad] }, undefined, undefined, createMockContext());
        expect((result.content[0] as any).text).toContain('only http(s) URLs are allowed');
        expect((result.details as any).error).toBe('invalid_initial_links');
        expect(mockRunResearch).not.toHaveBeenCalled();
      }
    });

    it('rejects a link longer than 2048 characters', async () => {
      const tool = createResearchTool();
      const longLink = 'https://example.com/' + 'a'.repeat(2100);
      const result = await tool.execute('id', { query: 'test', initialLinks: [longLink] }, undefined, undefined, createMockContext());
      expect((result.content[0] as any).text).toContain('at most 2048 characters');
      expect((result.details as any).error).toBe('invalid_initial_links');
      expect(mockRunResearch).not.toHaveBeenCalled();
    });

    it('rejects strings that are not URLs at all', async () => {
      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test', initialLinks: ['not a url'] }, undefined, undefined, createMockContext());
      expect((result.content[0] as any).text).toContain('is not a valid URL');
      expect((result.details as any).error).toBe('invalid_initial_links');
      expect(mockRunResearch).not.toHaveBeenCalled();
    });

    it('accepts valid http(s) links and forwards them to runResearch', async () => {
      const tool = createResearchTool();
      const links = ['https://example.com/a', 'http://example.org/b'];
      await tool.execute('id', { query: 'test', depth: 1, initialLinks: links }, undefined, undefined, createMockContext());
      expect(mockRunResearch).toHaveBeenCalledWith(
        expect.objectContaining({ initialLinks: links }),
        expect.any(AbortSignal),
      );
    });

    it('declares the bounds in the TypeBox schema (maxItems 20, maxLength 2048)', async () => {
      const { Value } = await import('typebox/value');
      const tool = createResearchTool();
      const schema = tool.parameters as any;

      expect(Value.Check(schema, { query: 'q', initialLinks: ['https://example.com/a'] })).toBe(true);
      expect(Value.Check(schema, { query: 'q', initialLinks: Array.from({ length: 21 }, () => 'https://e.com') })).toBe(false);
      expect(Value.Check(schema, { query: 'q', initialLinks: ['https://example.com/' + 'a'.repeat(2100)] })).toBe(false);
    });
  });

  describe('prepareArguments', () => {
    it('normalizes string depth to number', () => {
      const tool = createResearchTool();
      const args = tool.prepareArguments!({ query: 'test', depth: '2' }) as any;
      expect(args.depth).toBe(2);
    });

    it('leaves depth undefined when not provided (resolved in execute)', () => {
      const toolInstance = createResearchTool();
      const args = toolInstance.prepareArguments!({ query: 'test' }) as any;
      expect(args.depth).toBeUndefined();
    });
  });

  describe('Tool Definition', () => {
    it('has correct tool name', () => {
      const tool = createResearchTool();
      expect(tool.name).toBe('research');
    });
  });

  describe('Model Selection', () => {
    it('uses context model when no explicit model parameter', async () => {
      const context = createMockContext();
      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', depth: 1 }, undefined, undefined, context);
      expect(mockRunResearch).toHaveBeenCalledWith(
        expect.objectContaining({ model: expect.objectContaining({ id: 'test-model' }) }),
        expect.any(AbortSignal)
      );
    });
  });
});
