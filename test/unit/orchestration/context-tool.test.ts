/**
 * Context Tool Unit Tests
 *
 * Tests the investigate_context tool creation and basic structure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInvestigateContextTool, type ContextToolOptions } from '../../../src/orchestration/context-tool';

// Mock logger to avoid side effects
vi.mock('../../../src/logger.js', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock dependencies to avoid complex setup
vi.mock('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: vi.fn(),
  createReadTool: vi.fn(() => ({ name: 'read' })),
  SessionManager: {
    inMemory: vi.fn(() => ({ getBranch: vi.fn(() => []) })),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
}));

// Mock grep tool
vi.mock('../../../src/tools/grep.ts', () => ({
  createGrepTool: vi.fn(() => ({ name: 'rg_grep' })),
}));

// Mock resource loader
vi.mock('../../../src/make-resource-loader.js', () => ({
  makeResourceLoader: vi.fn(() => ({})),
}));

describe('context-tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createInvestigateContextTool', () => {
    const mockOptions: ContextToolOptions = {
      cwd: '/test/project',
      ctxModel: undefined,
      modelRegistry: {} as any,
    };

    it('should create tool definition with correct name', () => {
      const tool = createInvestigateContextTool(mockOptions);
      expect(tool.name).toBe('investigate_context');
    });

    it('should create tool definition with correct label', () => {
      const tool = createInvestigateContextTool(mockOptions);
      expect(tool.label).toBe('Investigate Context');
    });

    it('should create tool definition with description mentioning project inspection', () => {
      const tool = createInvestigateContextTool(mockOptions);
      expect(tool.description.toLowerCase()).toContain('project');
      expect(tool.description.toLowerCase()).toContain('inspect');
    });

    it('should create tool definition with description mentioning read and grep', () => {
      const tool = createInvestigateContextTool(mockOptions);
      expect(tool.description.toLowerCase()).toContain('read');
      expect(tool.description.toLowerCase()).toContain('grep');
    });

    it('should create tool definition with description excluding web search', () => {
      const tool = createInvestigateContextTool(mockOptions);
      expect(tool.description.toLowerCase()).toContain('no web');
    });

    it('should require question parameter', () => {
      const tool = createInvestigateContextTool(mockOptions);
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters).toHaveProperty('properties');
      expect((tool.parameters as any).properties).toHaveProperty('question');
    });

    it('should have execute function', () => {
      const tool = createInvestigateContextTool(mockOptions);
      expect(typeof tool.execute).toBe('function');
    });

    it('should create tool with consistent structure', () => {
      const tool = createInvestigateContextTool(mockOptions);
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('label');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('parameters');
      expect(tool).toHaveProperty('execute');
    });
  });

  describe('execute interface', () => {
    const mockOptions: ContextToolOptions = {
      cwd: '/test/project',
      ctxModel: undefined,
      modelRegistry: {} as any,
    };

    it('should accept correct parameter structure', async () => {
      const tool = createInvestigateContextTool(mockOptions);
      // Just verify the execute function exists and accepts params
      expect(tool.execute).toBeDefined();
      expect(tool.execute.length).toBeGreaterThan(0);
    });

    it('should handle tool id parameter', async () => {
      const tool = createInvestigateContextTool(mockOptions);
      // Mock createAgentSession to avoid actual execution
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      vi.mocked(createAgentSession).mockResolvedValue({
        session: {
          prompt: vi.fn(),
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Result' }] }],
        },
      } as any);

      const result = await tool.execute(
        'tool-id-123',
        { question: 'Test' },
        undefined,
        undefined,
        undefined as any
      );
      expect(result).toBeDefined();
    });

    it('should handle abort signal', async () => {
      const tool = createInvestigateContextTool(mockOptions);
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Result' }] }],
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession } as any);

      const abortController = new AbortController();
      const result = await tool.execute(
        'tool-id',
        { question: 'Test' },
        abortController.signal,
        undefined,
        undefined as any
      );
      expect(result).toBeDefined();
    });
  });

  describe('parameter validation', () => {
    const mockOptions: ContextToolOptions = {
      cwd: '/test/project',
      ctxModel: undefined,
      modelRegistry: {} as any,
    };

    it('should handle empty question', async () => {
      const tool = createInvestigateContextTool(mockOptions);
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [{ role: 'assistant', content: [{ type: 'text', text: '' }] }],
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession } as any);

      const result = await tool.execute('test-id', { question: '' }, undefined, undefined, undefined as any);
      expect(result.content).toBeDefined();
    });

    it('should handle long question', async () => {
      const tool = createInvestigateContextTool(mockOptions);
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Result' }] }],
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession } as any);

      const longQuestion = 'A'.repeat(1000);
      const result = await tool.execute('test-id', { question: longQuestion }, undefined, undefined, undefined as any);
      expect(result.content).toBeDefined();
    });

    it('should handle question with special characters', async () => {
      const tool = createInvestigateContextTool(mockOptions);
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Result' }] }],
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession } as any);

      const question = 'What about the async/await pattern? #typescript';
      const result = await tool.execute('test-id', { question }, undefined, undefined, undefined as any);
      expect(result.content).toBeDefined();
    });
  });
});
