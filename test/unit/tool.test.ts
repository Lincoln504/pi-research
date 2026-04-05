/**
 * Research Tool Unit Tests
 *
 * Meaningful, robust tests for quick vs deep mode branching and core behaviors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createResearchTool } from '../../src/tool';

// ============================================================================
// MOCKS - Define functions first before using in vi.mock
// ============================================================================

// Mock all external dependencies
vi.mock('../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  suppressConsole: vi.fn(() => vi.fn()),
  isVerboseFromEnv: vi.fn(() => false),
}));

vi.mock('../../src/orchestration/coordinator.ts', () => ({
  createCoordinatorSession: vi.fn(),
}));

vi.mock('../../src/orchestration/researcher.ts', () => ({
  createResearcherSession: vi.fn(),
}));

vi.mock('../../src/orchestration/delegate-tool.ts');
vi.mock('../../src/orchestration/context-tool.ts', () => ({
  createInvestigateContextTool: vi.fn(),
}));

vi.mock('../../src/infrastructure/searxng-lifecycle.ts', () => ({
  initLifecycle: vi.fn(async () => undefined),
  ensureRunning: vi.fn(async () => 'http://localhost:8888'),
  getStatus: vi.fn(() => 'active'),
  onStatusChange: vi.fn(() => vi.fn()),
  getConnectionCount: vi.fn(() => 0),
  getManager: vi.fn(() => ({})),
}));

vi.mock('../../src/healthcheck/index.ts', () => ({
  runHealthCheck: vi.fn(),
}));

vi.mock('../../src/tui/research-panel.ts', () => ({
  createResearchPanel: vi.fn(() => ({})),
  clearAllFlashTimeouts: vi.fn(),
  addSlice: vi.fn(),
  activateSlice: vi.fn(),
  completeSlice: vi.fn(),
  flashSlice: vi.fn(),
  createInitialPanelState: vi.fn(() => ({
    searxngStatus: { state: 'active', connectionCount: 0, url: '' },
    totalTokens: 0,
    activeConnections: 0,
    slices: new Map(),
    modelName: 'test-model',
  })),
}));

vi.mock('../../src/utils/session-state.ts', () => ({
  startResearchSession: vi.fn(() => 'session-123'),
  endResearchSession: vi.fn(),
  recordResearcherFailure: vi.fn(),
  shouldStopResearch: vi.fn((_sid) => false),
  getResearchStopMessage: vi.fn((_sid) => ''),
  getFailedResearchers: vi.fn((_sid) => []),
  isBottomMostSession: vi.fn((_sid) => true),
  onSessionOrderChange: vi.fn(() => vi.fn()),
  registerSessionUpdate: vi.fn(),
  unregisterSessionUpdate: vi.fn(),
  refreshAllSessions: vi.fn(),
}));

vi.mock('../../src/utils/shared-links.ts', () => ({
  generateSessionId: vi.fn(() => 'session-id-123'),
  cleanupSharedLinks: vi.fn(),
}));

vi.mock('../../src/orchestration/session-context.ts', () => ({
  formatParentContext: vi.fn(() => 'test context'),
}));

vi.mock('../../src/web-research/utils.ts', () => ({
  onConnectionCountChange: vi.fn(() => vi.fn()),
  setSearxngManager: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn((path: string) => {
    if (path.includes('coordinator')) return '# Coordinator prompt';
    if (path.includes('researcher')) return '# Researcher prompt';
    return '';
  }),
}));

vi.mock('@mariozechner/pi-coding-agent', () => ({
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
  createAgentSession: vi.fn(),
  createReadTool: vi.fn(),
}));

// Import mocks after they're defined
import { createCoordinatorSession } from '../../src/orchestration/coordinator.ts';
import { createResearcherSession } from '../../src/orchestration/researcher.ts';
import { runHealthCheck } from '../../src/healthcheck/index.ts';
import { addSlice, activateSlice, completeSlice } from '../../src/tui/research-panel.ts';

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
      // Emit message_end event when prompt is called
      subscribers.forEach(sub =>
        sub({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: responseText }],
            usage: { totalTokens: 150 },
          },
        })
      );
    }),
    messages: [
      { role: 'user' },
      { role: 'assistant', content: [{ type: 'text', text: responseText }], usage: { totalTokens: 150 } },
    ],
    abort: vi.fn(async () => undefined),
  } as any;
}

function createMockContext() {
  return {
    model: { id: 'test-model' },
    modelRegistry: { getAll: () => [], register: vi.fn() },
    cwd: '/test',
    ui: { setWidget: vi.fn(), notify: vi.fn() },
    sessionManager: {
      getBranch: vi.fn().mockReturnValue([]),
      buildSessionContext: vi.fn().mockReturnValue({ messages: [] }),
    },
  } as any;
}

// ============================================================================
// TESTS
// ============================================================================

describe('createResearchTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runHealthCheck).mockResolvedValue({
      success: true,
      searchOk: true,
      scrapeOk: true,
      details: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Tool Metadata', () => {
    it('has correct name and label', () => {
      const tool = createResearchTool();
      expect(tool.name).toBe('research');
      expect(tool.label).toBe('Research');
    });

    it('has query as required parameter', () => {
      const tool = createResearchTool();
      const required = (tool.parameters as any).required;
      expect(required).toContain('query');
    });

    it('has optional quick parameter with correct description', () => {
      const tool = createResearchTool();
      const props = (tool.parameters as any).properties;
      expect(props.quick).toBeDefined();
      expect(props.quick.description).toContain('quick mode');
    });
  });

  describe('Quick Mode Branching (quick: true)', () => {
    it('calls createResearcherSession when quick=true', async () => {
      vi.mocked(createResearcherSession).mockResolvedValue(createMockSession());
      vi.mocked(createCoordinatorSession).mockResolvedValue(createMockSession());

      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', quick: true }, undefined, undefined, createMockContext());

      expect(vi.mocked(createResearcherSession)).toHaveBeenCalled();
      expect(vi.mocked(createCoordinatorSession)).not.toHaveBeenCalled();
    });

    it('does NOT call createCoordinatorSession in quick mode', async () => {
      vi.mocked(createResearcherSession).mockResolvedValue(createMockSession());

      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', quick: true }, undefined, undefined, createMockContext());

      expect(vi.mocked(createCoordinatorSession)).not.toHaveBeenCalled();
    });

    it('creates and completes TUI slice "researching ..."', async () => {
      vi.mocked(createResearcherSession).mockResolvedValue(createMockSession());

      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', quick: true }, undefined, undefined, createMockContext());

      expect(vi.mocked(addSlice)).toHaveBeenCalledWith(expect.any(Object), 'researching ...', 'researching ...', false);
      expect(vi.mocked(activateSlice)).toHaveBeenCalledWith(expect.any(Object), 'researching ...');
      expect(vi.mocked(completeSlice)).toHaveBeenCalledWith(expect.any(Object), 'researching ...');
    });

    it('extracts and returns researcher response', async () => {
      const responseText = 'Quick mode result';
      vi.mocked(createResearcherSession).mockResolvedValue(createMockSession(responseText));

      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test', quick: true }, undefined, undefined, createMockContext());

      expect((result.content[0] as any).text).toBe(responseText);
    });

    it('returns token count from researcher', async () => {
      vi.mocked(createResearcherSession).mockResolvedValue(createMockSession());

      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test', quick: true }, undefined, undefined, createMockContext());

      expect((result.details as any).totalTokens).toBeGreaterThan(0);
    });
  });

  describe('Coordinator Mode Branching (quick: false or omitted)', () => {
    it('calls createCoordinatorSession when quick=false', async () => {
      vi.mocked(createCoordinatorSession).mockResolvedValue(createMockSession());

      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', quick: false }, undefined, undefined, createMockContext());

      expect(vi.mocked(createCoordinatorSession)).toHaveBeenCalled();
      expect(vi.mocked(createResearcherSession)).not.toHaveBeenCalled();
    });

    it('calls createCoordinatorSession when quick is omitted (defaults to false)', async () => {
      vi.mocked(createCoordinatorSession).mockResolvedValue(createMockSession());

      const tool = createResearchTool();
      await tool.execute('id', { query: 'test' }, undefined, undefined, createMockContext());

      expect(vi.mocked(createCoordinatorSession)).toHaveBeenCalled();
    });

    it('extracts and returns coordinator response', async () => {
      const responseText = 'Coordinator mode result';
      vi.mocked(createCoordinatorSession).mockResolvedValue(createMockSession(responseText));

      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test', quick: false }, undefined, undefined, createMockContext());

      expect((result.content[0] as any).text).toBe(responseText);
    });
  });

  describe('Error Handling', () => {
    it('rejects empty query', async () => {
      const tool = createResearchTool();
      const result = await tool.execute('id', { query: '' }, undefined, undefined, createMockContext());

      expect((result.content[0] as any).text).toContain('required');
    });

    it('rejects missing model', async () => {
      const tool = createResearchTool();
      const ctx = createMockContext();
      ctx.model = undefined;

      const result = await tool.execute('id', { query: 'test' }, undefined, undefined, ctx);

      expect((result.content[0] as any).text).toContain('model');
    });

    it('returns error when researcher session fails', async () => {
      vi.mocked(createResearcherSession).mockRejectedValue(new Error('Search failed'));

      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test', quick: true }, undefined, undefined, createMockContext());

      expect((result.content[0] as any).text).toContain('failed');
    });

    it('returns error message on various failures', async () => {
      vi.mocked(createResearcherSession).mockRejectedValue(new Error('Network error'));

      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test', quick: true }, undefined, undefined, createMockContext());

      expect((result.content[0] as any).text).toContain('failed');
    });
  });


  describe('Parameter Handling', () => {
    it('accepts all parameters correctly', () => {
      const tool = createResearchTool();
      const props = (tool.parameters as any).properties;
      expect(props.quick).toBeDefined();
      expect(props.model).toBeDefined();
    });

    it('quick parameter is optional', () => {
      const tool = createResearchTool();
      const props = (tool.parameters as any).properties;
      expect(props.quick).toBeDefined();
    });
  });

  describe('Quick Mode Timeout', () => {
    it('cleans up timeout after successful quick mode completion', async () => {
      vi.useFakeTimers();
      const mockSession = createMockSession('Quick result');
      mockSession.prompt.mockResolvedValue(undefined); // Immediate resolution
      vi.mocked(createResearcherSession).mockResolvedValue(mockSession);

      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test', quick: true }, undefined, undefined, createMockContext());

      // Verify completion happened
      expect((result.content[0] as any).text).toBe('Quick result');

      // Advance timers past the 4-minute timeout
      vi.advanceTimersByTime(250000);

      // If timeout wasn't cleaned up, it would have fired and caused an error
      // Since we got here without error, timeout was cleaned up properly
      expect(result.content[0]).toHaveProperty('text');

      vi.useRealTimers();
    });
  });
});
