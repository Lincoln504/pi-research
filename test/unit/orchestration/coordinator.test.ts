/**
 * Coordinator Unit Tests
 *
 * Tests the createCoordinatorSession function.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCoordinatorSession, type CreateCoordinatorSessionOptions } from '../../../src/orchestration/coordinator';

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

// Mock resource loader
vi.mock('../../../src/make-resource-loader.js', () => ({
  makeResourceLoader: vi.fn(() => ({})),
}));

describe('coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockOptions = (): CreateCoordinatorSessionOptions => ({
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
    systemPrompt: 'You are a helpful coordinator.',
    customTools: [],
  });

  describe('createCoordinatorSession', () => {
    it('should throw error when ctxModel is undefined', async () => {
      const options: CreateCoordinatorSessionOptions = {
        ...createMockOptions(),
        ctxModel: undefined,
      };

      await expect(createCoordinatorSession(options)).rejects.toThrow(
        'No model selected. Please select a model before using the research tool.'
      );
    });

    it('should throw error when ctxModel is null', async () => {
      const options: CreateCoordinatorSessionOptions = {
        ...createMockOptions(),
        ctxModel: null as any,
      };

      await expect(createCoordinatorSession(options)).rejects.toThrow(
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
      await createCoordinatorSession(options);

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
      await createCoordinatorSession(options);

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
      await createCoordinatorSession(options);

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
      await createCoordinatorSession(options);

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
      await createCoordinatorSession(options);

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
      await createCoordinatorSession(options);

      expect(makeResourceLoader).toHaveBeenCalledWith('You are a helpful coordinator.');
      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceLoader: mockResourceLoader,
        })
      );
    });

    it('should create agent session with custom tools when provided', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession });

      const customTools = [
        { name: 'tool1', execute: vi.fn() },
        { name: 'tool2', execute: vi.fn() },
      ];

      const options = createMockOptions();
      options.customTools = customTools;

      await createCoordinatorSession(options);

      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          customTools,
        })
      );
    });

    it('should create agent session with empty custom tools array when not provided', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      const mockSession = {
        prompt: vi.fn(),
        messages: [],
        subscribe: vi.fn(),
        abort: vi.fn(),
      };
      vi.mocked(createAgentSession).mockResolvedValue({ session: mockSession });

      const options = createMockOptions();
      delete options.customTools;

      await createCoordinatorSession(options);

      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          customTools: [],
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
      const result = await createCoordinatorSession(options);

      expect(result).toBe(mockSession);
    });

    it('should handle createAgentSession errors gracefully', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      vi.mocked(createAgentSession).mockRejectedValue(new Error('Session creation failed'));

      const options = createMockOptions();

      await expect(createCoordinatorSession(options)).rejects.toThrow('Session creation failed');
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
      const session = await createCoordinatorSession(options);

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
      const session = await createCoordinatorSession(options);

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
      const session = await createCoordinatorSession(options);

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
      const session = await createCoordinatorSession(options);

      expect(Array.isArray(session.messages)).toBe(true);
    });
  });
});
