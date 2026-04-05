/**
 * Researcher Unit Tests
 *
 * Tests the createResearcherSession function.
 *
 * NOTE: researcher.ts is a thin wrapper around createAgentSession.
 * These tests provide minimal sanity checking. Most value comes from
 * integration testing of actual researcher behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import { createResearcherSession, type CreateResearcherSessionOptions } from '../../../src/orchestration/researcher';

// Mock logger to avoid side effects
vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock dependencies
vi.mock('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: vi.fn(),
  createReadTool: vi.fn(() => ({ name: 'read' })),
  SessionManager: {
    inMemory: vi.fn(() => ({})),
  },
}));

// Mock tool imports
vi.mock('../../../src/tools/search.ts', () => ({
  createSearchTool: vi.fn(() => ({ name: 'web_search' })),
}));

vi.mock('../../../src/tools/scrape.ts', () => ({
  createScrapeTool: vi.fn(() => ({ name: 'scrape' })),
}));

vi.mock('../../../src/tools/security.ts', () => ({
  createSecuritySearchTool: vi.fn(() => ({ name: 'security' })),
}));

vi.mock('../../../src/tools/stackexchange.ts', () => ({
  createStackexchangeTool: vi.fn(() => ({ name: 'stackexchange' })),
}));

vi.mock('../../../src/tools/grep.ts', () => ({
  createGrepTool: vi.fn(() => ({ name: 'rg_grep' })),
}));

// Mock agent tools
vi.mock('../../../src/tools/index.ts', () => ({
  createResearchTools: vi.fn(() => [
    { name: 'web_search' },
    { name: 'scrape' },
    { name: 'security' },
  ]),
}));

// Mock resource loader
vi.mock('../../../src/utils/make-resource-loader.ts', () => ({
  makeResourceLoader: vi.fn(() => ({})),
}));

describe('researcher', () => {
  const createMockOptions = (): CreateResearcherSessionOptions => ({
    cwd: '/test/project',
    ctxModel: { id: 'test-model' } as any,
    modelRegistry: {
      getAll: vi.fn(() => []),
      get: vi.fn(),
      register: vi.fn(),
    } as any,
    settingsManager: {} as any,
    systemPrompt: 'You are a helpful researcher.',
    searxngUrl: 'http://localhost:8888',
    extensionCtx: {} as any,
  });

  describe('createResearcherSession', () => {
    it('should throw error when ctxModel is undefined', async () => {
      const options: CreateResearcherSessionOptions = {
        ...createMockOptions(),
        ctxModel: undefined,
      };

      await expect(createResearcherSession(options)).rejects.toThrow(
        'No model selected. Please select a model before using the research tool.'
      );
    });

    it('should throw error when ctxModel is null', async () => {
      const options: CreateResearcherSessionOptions = {
        ...createMockOptions(),
        ctxModel: null as any,
      };

      await expect(createResearcherSession(options)).rejects.toThrow(
        'No model selected. Please select a model before using the research tool.'
      );
    });

    it('should create agent session successfully', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession } as any);

      const options = createMockOptions();
      const result = await createResearcherSession(options);

      expect(result).toBe(mockSession);
      expect(createAgentSession).toHaveBeenCalled();
    });

    it('should create research tools with correct options', async () => {
      const { createResearchTools } = await import('../../../src/tools/index.ts');
      const mockTools = [
        { name: 'web_search' },
        { name: 'scrape' },
        { name: 'security' },
      ];
      vi.mocked(createResearchTools).mockReturnValue(mockTools as any);

      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession } as any);

      const options = createMockOptions();
      await createResearcherSession(options);

      expect(createResearchTools).toHaveBeenCalledWith(expect.objectContaining({
        searxngUrl: 'http://localhost:8888',
        ctx: options.extensionCtx,
        tracker: expect.anything(),
      }));
    });

    it('should handle createAgentSession errors gracefully', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      vi.mocked(createAgentSession).mockRejectedValue(new Error('Session creation failed'));

      const options = createMockOptions();

      await expect(createResearcherSession(options)).rejects.toThrow('Session creation failed');
    });
  });
});
