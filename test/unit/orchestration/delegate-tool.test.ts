/**
 * Delegate Tool Unit Tests
 *
 * Tests the createDelegateTool function and core behaviors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDelegateTool, type DelegateToolOptions } from '../../../src/orchestration/delegate-tool';

// Mock logger
vi.mock('../../../src/logger.js', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock researcher
vi.mock('../../../src/orchestration/researcher.js', () => ({
  createResearcherSession: vi.fn(),
}));

// Mock shared-links utils
vi.mock('../../../src/utils/shared-links.ts', () => ({
  buildSharedLinksPool: vi.fn(() => new Map()),
  saveSharedLinks: vi.fn(),
  loadSharedLinks: vi.fn(() => new Map()),
  formatSharedLinksForPrompt: vi.fn(() => ''),
}));

// Mock session-state utils
vi.mock('../../../src/utils/session-state.ts', () => ({
  startResearchSession: vi.fn(() => 'session-123'),
  endResearchSession: vi.fn(),
  recordResearcherFailure: vi.fn(),
  shouldStopResearch: vi.fn(() => false),
  getResearchStopMessage: vi.fn(() => ''),
  getFailedResearchers: vi.fn(() => []),
}));

// Mock text-utils
vi.mock('../../../src/utils/text-utils.ts', () => ({
  extractText: vi.fn((msg) => msg?.content?.[0]?.text || ''),
}));

// Mock TUI functions
vi.mock('../../../src/tui/research-panel.ts', () => ({
  createResearchPanel: vi.fn(() => '<div>Panel</div>'),
  addSlice: vi.fn(),
  completeSlice: vi.fn(),
  flashSlice: vi.fn(),
  activateSlice: vi.fn(),
  clearAllFlashTimeouts: vi.fn(),
}));

describe('delegate-tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createMockOptions = (): DelegateToolOptions => ({
    sessionId: 'test-session',
    breadthCounter: { value: 0 },
    panelState: {
      searxngStatus: 'running',
      totalTokens: 0,
      activeConnections: 0,
      slices: new Map(),
      modelName: 'test-model',
    },
    onTokens: vi.fn(),
    onUpdate: vi.fn(),
    researcherOptions: {
      cwd: '/test/project',
      ctxModel: { id: 'test-model' },
      modelRegistry: {
        getAll: vi.fn(() => []),
        get: vi.fn(),
        register: vi.fn(),
      } as any,
      sessionManager: {
        getBranch: vi.fn(() => []),
        set: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
      } as any,
      settingsManager: {} as any,
      systemPrompt: 'You are a helpful researcher.',
      searxngUrl: 'http://localhost:8888',
      extensionCtx: {} as any,
    },
    signal: new AbortController().signal,
    timeoutMs: 30000,
    flashTimeoutMs: 1000,
  });

  const createMockSession = () => ({
    prompt: vi.fn(),
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Result' }], stopReason: 'stop' }],
    subscribe: vi.fn(),
    abort: vi.fn(),
  });

  describe('createDelegateTool', () => {
    it('should create tool with correct name', () => {
      const tool = createDelegateTool(createMockOptions());
      expect(tool.name).toBe('delegate_research');
    });

    it('should create tool with correct label', () => {
      const tool = createDelegateTool(createMockOptions());
      expect(tool.label).toBe('Delegate Research');
    });

    it('should create tool with description mentioning parallel or sequential', () => {
      const tool = createDelegateTool(createMockOptions());
      expect(tool.description.toLowerCase()).toContain('parallel');
      expect(tool.description.toLowerCase()).toContain('sequential');
    });

    it('should require slices parameter', () => {
      const tool = createDelegateTool(createMockOptions());
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters).toHaveProperty('properties');
      expect(tool.parameters.properties).toHaveProperty('slices');
    });

    it('should require simultaneous parameter', () => {
      const tool = createDelegateTool(createMockOptions());
      expect(tool.parameters.properties).toHaveProperty('simultaneous');
    });

    it('should have optional nonConcurrent parameter', () => {
      const tool = createDelegateTool(createMockOptions());
      expect(tool.parameters.properties).toHaveProperty('nonConcurrent');
    });

    it('should have optional iterateOn parameter', () => {
      const tool = createDelegateTool(createMockOptions());
      expect(tool.parameters.properties).toHaveProperty('iterateOn');
    });

    it('should have optional iterationNumber parameter', () => {
      const tool = createDelegateTool(createMockOptions());
      expect(tool.parameters.properties).toHaveProperty('iterationNumber');
    });

    it('should have execute function', () => {
      const tool = createDelegateTool(createMockOptions());
      expect(typeof tool.execute).toBe('function');
    });

    it('should have prompt snippet', () => {
      const tool = createDelegateTool(createMockOptions());
      expect(tool.promptSnippet).toBeDefined();
    });

    it('should have prompt guidelines', () => {
      const tool = createDelegateTool(createMockOptions());
      expect(tool.promptGuidelines).toBeDefined();
      expect(Array.isArray(tool.promptGuidelines)).toBe(true);
    });
  });

  describe('execute - basic functionality', () => {
    it('should handle single slice', async () => {
      const { createResearcherSession } = await import('../../../src/orchestration/researcher.js');
      vi.mocked(createResearcherSession).mockResolvedValue(createMockSession());

      const tool = createDelegateTool(createMockOptions());
      const result = await tool.execute(
        'test-id',
        { slices: ['single slice'], simultaneous: false },
        undefined,
        undefined,
        undefined
      );

      expect(result).toBeDefined();
    });

    it('should handle multiple slices', async () => {
      const { createResearcherSession } = await import('../../../src/orchestration/researcher.js');
      vi.mocked(createResearcherSession).mockResolvedValue(createMockSession());

      const tool = createDelegateTool(createMockOptions());
      const result = await tool.execute(
        'test-id',
        { slices: ['slice1', 'slice2', 'slice3'], simultaneous: false },
        undefined,
        undefined,
        undefined
      );

      expect(result).toBeDefined();
    });

    it('should return markdown formatted results', async () => {
      const { createResearcherSession } = await import('../../../src/orchestration/researcher.js');
      vi.mocked(createResearcherSession).mockResolvedValue(createMockSession());

      const tool = createDelegateTool(createMockOptions());
      const result = await tool.execute(
        'test-id',
        { slices: ['test'], simultaneous: false },
        undefined,
        undefined,
        undefined
      );

      expect(result.content[0]?.type).toBe('text');
      expect(result.content[0]?.text).toBeDefined();
    });
  });

  describe('execute - cumulative failure handling', () => {
    it('should throw error when shouldStopResearch returns true', async () => {
      const { shouldStopResearch, getResearchStopMessage } = await import('../../../src/utils/session-state.ts');
      vi.mocked(shouldStopResearch).mockReturnValue(true);
      vi.mocked(getResearchStopMessage).mockReturnValue('Too many failures');

      const tool = createDelegateTool(createMockOptions());
      await expect(
        tool.execute(
          'test-id',
          { slices: ['test'], simultaneous: false },
          undefined,
          undefined,
          undefined
        )
      ).rejects.toThrow('Too many failures');
    });

    it('should proceed when shouldStopResearch returns false', async () => {
      const { shouldStopResearch } = await import('../../../src/utils/session-state.ts');
      vi.mocked(shouldStopResearch).mockReturnValue(false);

      const { createResearcherSession } = await import('../../../src/orchestration/researcher.js');
      vi.mocked(createResearcherSession).mockResolvedValue(createMockSession());

      const tool = createDelegateTool(createMockOptions());
      const result = await tool.execute(
        'test-id',
        { slices: ['test'], simultaneous: false },
        undefined,
        undefined,
        undefined
      );

      expect(result).toBeDefined();
    });
  });

  describe('execute - mode configuration', () => {
    it('should recognize non-concurrent mode', async () => {
      const { createResearcherSession } = await import('../../../src/orchestration/researcher.js');
      vi.mocked(createResearcherSession).mockResolvedValue(createMockSession());

      const { logger } = await import('../../../src/logger.js');
      const tool = createDelegateTool(createMockOptions());
      await tool.execute(
        'test-id',
        { slices: ['slice1'], simultaneous: false, nonConcurrent: true },
        undefined,
        undefined,
        undefined
      );

      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('non-concurrent (1)')
      );
    });

    it('should recognize parallel mode', async () => {
      const { createResearcherSession } = await import('../../../src/orchestration/researcher.js');
      vi.mocked(createResearcherSession).mockResolvedValue(createMockSession());

      const { logger } = await import('../../../src/logger.js');
      const tool = createDelegateTool(createMockOptions());
      await tool.execute(
        'test-id',
        { slices: ['slice1'], simultaneous: true },
        undefined,
        undefined,
        undefined
      );

      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('parallel')
      );
    });
  });
});
