/**
 * Coordinator Unit Tests
 *
 * Tests the createCoordinatorSession function.
 *
 * NOTE: coordinator.ts is a thin wrapper around createAgentSession.
 * These tests provide minimal sanity checking. Most value comes from
 * integration testing of actual coordinator behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import { createCoordinatorSession, type CreateCoordinatorSessionOptions } from '../../../src/orchestration/coordinator';

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
}));

// Mock resource loader
vi.mock('../../../src/utils/make-resource-loader.ts', () => ({
  makeResourceLoader: vi.fn(() => ({})),
}));

describe('coordinator', () => {
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
      const result = await createCoordinatorSession(options);

      expect(result).toBe(mockSession);
      expect(createAgentSession).toHaveBeenCalled();
    });

    it('should handle createAgentSession errors gracefully', async () => {
      const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
      vi.mocked(createAgentSession).mockRejectedValue(new Error('Session creation failed'));

      const options = createMockOptions();

      await expect(createCoordinatorSession(options)).rejects.toThrow('Session creation failed');
    });
  });
});
