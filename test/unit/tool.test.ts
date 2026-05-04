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
  },
  createResearchRunId: vi.fn(() => 'run-test'),
  runWithLogContext: vi.fn((_context, callback) => callback()),
  isVerboseFromEnv: vi.fn(() => false),
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
}));

vi.mock('../../src/utils/shared-links.ts', () => ({
  generateSessionId: vi.fn(() => 'session-id-123'),
  cleanupSharedLinks: vi.fn(),
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
    it('calls runResearch when depth=0', async () => {
      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', depth: 0 }, undefined, undefined, createMockContext());

      expect(runResearch).toHaveBeenCalled();
    });

    it('calls runResearch when depth=1', async () => {
      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', depth: 1 }, undefined, undefined, createMockContext());

      expect(runResearch).toHaveBeenCalled();
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

    it('creates TUI panel and calls runResearch', async () => {
      const tool = createResearchTool();
      await tool.execute('id', { query: 'test', depth: 0 }, undefined, undefined, createMockContext());

      expect(panel.createInitialPanelState).toHaveBeenCalled();
      expect(runResearch).toHaveBeenCalled();
    });
  });

  describe('Deep Mode Branching (complexity 2, 3, or 4)', () => {
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
  });
});
