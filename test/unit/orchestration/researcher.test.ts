/**
 * Researcher Unit Tests
 *
 * Tests the createResearcherSession function.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearcherSession, type CreateResearcherSessionOptions } from '../../../src/orchestration/researcher';

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

// Mock dependencies
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
vi.mock('../../../src/agent-tools.ts', () => ({
  createAgentTools: vi.fn(() => [
    { name: 'web_search' },
    { name: 'scrape' },
    { name: 'security' },
  ]),
}));

// Mock resource loader
vi.mock('../../../src/make-resource-loader.js', () => ({
  makeResourceLoader: vi.fn(() => ({})),
}));

describe('researcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockOptions = (): CreateResearcherSessionOptions => ({
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

    it('should create agent session with correct cwd', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession });

      const options = createMockOptions();
      await createResearcherSession(options);

      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/test/project',
        })
      );
    });

    it('should create agent session with ctxModel', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession });

      const options = createMockOptions();
      await createResearcherSession(options);

      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          model: { id: 'test-model' },
        })
      );
    });

    it('should create agent session with modelRegistry', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession });

      const options = createMockOptions();
      await createResearcherSession(options);

      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          modelRegistry: options.modelRegistry,
        })
      );
    });

    it('should create agent session with sessionManager', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession });

      const options = createMockOptions();
      await createResearcherSession(options);

      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionManager: options.sessionManager,
        })
      );
    });

    it('should create agent session with settingsManager', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession });

      const options = createMockOptions();
      await createResearcherSession(options);

      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          settingsManager: options.settingsManager,
        })
      );
    });

    it('should create agent session with resourceLoader', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const { makeResourceLoader } = await import('../../../src/make-resource-loader.js');
      const mockResourceLoader = { load: vi.fn() };
      vi.mocked(makeResourceLoader).mockReturnValue(mockResourceLoader);

      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession });

      const options = createMockOptions();
      await createResearcherSession(options);

      expect(makeResourceLoader).toHaveBeenCalledWith('You are a helpful researcher.');
      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceLoader: mockResourceLoader,
        })
      );
    });

    it('should create agent session with custom tools from createAgentTools', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const { createAgentTools } = await import('../../../src/agent-tools.ts');
      const mockTools = [
        { name: 'web_search' },
        { name: 'scrape' },
        { name: 'security' },
      ];
      vi.mocked(createAgentTools).mockReturnValue(mockTools);

      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession });

      const options = createMockOptions();
      await createResearcherSession(options);

      expect(createAgentTools).toHaveBeenCalledWith({
        searxngUrl: 'http://localhost:8888',
        ctx: options.extensionCtx,
      });
      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          customTools: mockTools,
        })
      );
    });

    it('should return the created session', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession });

      const options = createMockOptions();
      const result = await createResearcherSession(options);

      expect(result).toBe(mockSession);
    });

    it('should handle createAgentSession errors gracefully', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      vi.mocked(createAgentSession).mockRejectedValue(new Error('Session creation failed'));

      const options = createMockOptions();

      await expect(createResearcherSession(options)).rejects.toThrow('Session creation failed');
    });
  });

  describe('session behavior', () => {
    it('should create session with prompt method', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession });

      const options = createMockOptions();
      const session = await createResearcherSession(options);

      expect(typeof session.prompt).toBe('function');
    });

    it('should create session with subscribe method', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession });

      const options = createMockOptions();
      const session = await createResearcherSession(options);

      expect(typeof session.subscribe).toBe('function');
    });

    it('should create session with abort method', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession });

      const options = createMockOptions();
      const session = await createResearcherSession(options);

      expect(typeof session.abort).toBe('function');
    });

    it('should create session with messages property', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession });

      const options = createMockOptions();
      const session = await createResearcherSession(options);

      expect(Array.isArray(session.messages)).toBe(true);
    });
  });
});
