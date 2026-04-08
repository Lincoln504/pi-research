/**
 * Research Tool Unit Tests
 *
 * Meaningful, robust tests for quick vs swarm mode branching and core behaviors.
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
  },
  createResearchRunId: vi.fn(() => 'run-test'),
  runWithLogContext: vi.fn((_context, callback) => callback()),
  isVerboseFromEnv: vi.fn(() => false),
}));

// Mock SwarmOrchestrator as a class
const mockRun = vi.fn(async () => 'swarm result');
vi.mock('../../src/orchestration/swarm-orchestrator.ts', () => ({
  SwarmOrchestrator: class {
    run = mockRun;
  },
}));

vi.mock('../../src/orchestration/researcher.ts', () => ({
  createResearcherSession: vi.fn(),
}));

vi.mock('../../src/infrastructure/searxng-lifecycle.ts', () => ({
  initLifecycle: vi.fn(async () => undefined),
  ensureRunning: vi.fn(async () => 'http://localhost:8888'),
  getStatus: vi.fn(() => ({ state: 'active', url: '', isFunctional: true })),
  onStatusChange: vi.fn(() => vi.fn()),
  getManager: vi.fn(() => ({})),
  isFunctional: vi.fn().mockReturnValue(true), // Skip health check by default
  setFunctional: vi.fn(),
}));

vi.mock('../../src/healthcheck/index.ts', () => ({
  runHealthCheck: vi.fn(async () => ({ success: true, details: {} })),
}));

// Mock the panel module
vi.mock('../../src/tui/research-panel.ts', () => ({
  createResearchPanel: vi.fn(() => ({})),
  clearAllFlashTimeouts: vi.fn(),
  addSlice: vi.fn(),
  activateSlice: vi.fn(),
  completeSlice: vi.fn(),
  removeSlice: vi.fn(),
  flashSlice: vi.fn(),
  updateSliceTokens: vi.fn(),
  createInitialPanelState: vi.fn(() => ({
    searxngStatus: { state: 'active', url: '', isFunctional: true },
    totalTokens: 0,
    slices: new Map(),
    modelName: 'test-model',
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
}));

vi.mock('../../src/utils/shared-links.ts', () => ({
  generateSessionId: vi.fn(() => 'session-id-123'),
  cleanupSharedLinks: vi.fn(),
}));

vi.mock('../../src/web-research/utils.ts', () => ({
  onConnectionCountChange: vi.fn(() => vi.fn()),
  setSearxngManager: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn((path: string) => {
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

vi.mock('@mariozechner/pi-ai', () => ({
  complete: vi.fn(async () => ({
    content: [{ type: 'text', text: '2' }], // Complexity 2
  })),
}));

// Import mocked modules
import * as panel from '../../src/tui/research-panel.ts';
import { createResearcherSession } from '../../src/orchestration/researcher.ts';

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
            usage: { totalTokens: 150 },
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
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'key', headers: {} })),
    },
    cwd: '/test',
    ui: { setWidget: vi.fn(), notify: vi.fn() },
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

  describe('Quick Mode Branching (quick: true)', () => {
    it('calls createResearcherSession when quick=true', async () => {
      vi.mocked(createResearcherSession).mockResolvedValue(createMockSession());

      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', quick: true }, undefined, undefined, createMockContext());

      expect(vi.mocked(createResearcherSession)).toHaveBeenCalled();
    });

    it('does not mutate console methods on successful quick research', async () => {
      vi.mocked(createResearcherSession).mockResolvedValue(createMockSession());
      const originalConsole = {
        log: console.log,
        info: console.info,
        error: console.error,
        warn: console.warn,
        debug: console.debug,
      };

      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', quick: true }, undefined, undefined, createMockContext());

      expect(console.log).toBe(originalConsole.log);
      expect(console.info).toBe(originalConsole.info);
      expect(console.error).toBe(originalConsole.error);
      expect(console.warn).toBe(originalConsole.warn);
      expect(console.debug).toBe(originalConsole.debug);
    });

    it('creates and completes TUI slice "researching ..."', async () => {
      vi.mocked(createResearcherSession).mockResolvedValue(createMockSession());

      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', quick: true }, undefined, undefined, createMockContext());

      expect(panel.addSlice).toHaveBeenCalledWith(expect.any(Object), 'researching ...', 'researching ...', false);
      expect(panel.activateSlice).toHaveBeenCalledWith(expect.any(Object), 'researching ...');
      expect(panel.completeSlice).toHaveBeenCalledWith(expect.any(Object), 'researching ...');
    });
  });

  describe('Swarm Mode Branching (quick: false or omitted)', () => {
    it('initializes SwarmOrchestrator and runs it', async () => {
      const tool = createResearchTool();
      const result = await tool.execute('id', { query: 'test' }, undefined, undefined, createMockContext());

      expect(mockRun).toHaveBeenCalled();
      expect(result.content[0]).toEqual(expect.objectContaining({ text: 'swarm result' }));
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
  });
});
