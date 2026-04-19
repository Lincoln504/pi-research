/**
 * Report Injection Robustness Fixes - Unit Tests
 *
 * Tests for the critical fixes to improve report injection robustness:
 * 1. Abort signal handling - state is properly updated on abort
 * 2. Error logging - injection failures are logged, not silently suppressed
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepResearchOrchestrator } from '../../../src/orchestration/deep-research-orchestrator';
import { logger } from '../../../src/logger';

// Mock logger
vi.mock('../../../src/logger', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock researcher session creation
vi.mock('../../../src/orchestration/researcher', () => ({
  createResearcherSession: vi.fn(),
}));

// Mock filesystem
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => 'mock prompt content'),
}));

describe('Report Injection Robustness Fixes', () => {
  const createMockOptions = () => ({
    ctx: {
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'test-key', headers: {} })),
      },
      cwd: '/test/cwd',
    } as any,
    model: { id: 'test-model' } as any,
    query: 'test query',
    complexity: 2 as 1 | 2 | 3,
    onTokens: vi.fn(),
    onUpdate: vi.fn(),
    searxngUrl: 'http://localhost:8888',
    panelState: {
      sessionId: 'test-session',
      query: 'test query',
      searxngStatus: { state: 'inactive', url: '', isFunctional: false },
      totalTokens: 0,
      slices: new Map(),
      modelName: 'test-model',
    } as any,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Abort Signal Handling', () => {
    it('should update state to SIBLING_FAILED on abort after prompt', async () => {
      const options = createMockOptions();
      const orchestrator = new DeepResearchOrchestrator(options);
      
      const controller = new AbortController();
      const aspect = { id: '1.1', query: 'test query' };
      
      const mockSession = {
        prompt: vi.fn(async () => {
          // Simulate abort happening DURING or JUST AFTER prompt
          controller.abort();
        }),
        getMessages: vi.fn(() => [{ role: 'assistant', content: 'findings' }]),
        on: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      };

      const { createResearcherSession } = await import('../../../src/orchestration/researcher');
      vi.mocked(createResearcherSession).mockResolvedValue(mockSession as any);

      // We need to mock the updateState to see what events are fired
      const updateStateSpy = vi.spyOn(orchestrator as any, 'updateState');

      // Execute the private executeSibling method
      await (orchestrator as any).executeSibling(aspect, controller.signal);

      // Verify SIBLING_FAILED with 'Aborted' error was sent
      expect(updateStateSpy).toHaveBeenCalledWith({
        type: 'SIBLING_FAILED',
        id: '1.1',
        error: 'Aborted'
      });
    });

    it('should return early on catch if already aborted', async () => {
      const options = createMockOptions();
      const orchestrator = new DeepResearchOrchestrator(options);
      
      const controller = new AbortController();
      controller.abort();
      
      const aspect = { id: '1.1', query: 'test query' };
      
      const mockSession = {
        prompt: vi.fn(async () => {
          throw new Error('Should be ignored');
        }),
        on: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      };

      const { createResearcherSession } = await import('../../../src/orchestration/researcher');
      vi.mocked(createResearcherSession).mockResolvedValue(mockSession as any);

      const updateStateSpy = vi.spyOn(orchestrator as any, 'updateState');

      await (orchestrator as any).executeSibling(aspect, controller.signal);

      // Should NOT have called updateState in the catch block because it was an abort
      expect(updateStateSpy).not.toHaveBeenCalledWith(expect.objectContaining({
        type: 'SIBLING_FAILED',
        error: 'Should be ignored'
      }));
    });
  });

  describe('Error Logging on Injection Failure', () => {
    it('should log warnings when injection fails', async () => {
      const options = createMockOptions();
      const orchestrator = new DeepResearchOrchestrator(options);

      // Setup state with finished and running siblings
      (orchestrator as any).state = {
        ...options,
        currentRound: 1,
        aspects: {
          '1.1': { id: '1.1', query: 'q1', status: 'completed', report: 'Test findings' },
          '1.2': { id: '1.2', query: 'q2', status: 'running' },
        },
      };

      // Mock session that throws on steer
      const mockSession = {
        steer: vi.fn(async () => {
          throw new Error('Session closed');
        }),
      };

      // Set the active session
      (orchestrator as any).activeSessions.set('1.2', mockSession);

      // Inject findings - should log warning
      const finished = (orchestrator as any).state.aspects['1.1'];
      await (orchestrator as any).injectFindingsIntoRunningSiblings(finished);

      // Verify warning was logged
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to inject findings from 1.1 into 1.2'),
        expect.any(Error)
      );
    });

    it('should continue gracefully when injection fails', async () => {
      const options = createMockOptions();
      const orchestrator = new DeepResearchOrchestrator(options);

      // Setup state with multiple running siblings
      (orchestrator as any).state = {
        ...options,
        currentRound: 1,
        aspects: {
          '1.1': { id: '1.1', query: 'q1', status: 'completed', report: 'Test findings' },
          '1.2': { id: '1.2', query: 'q2', status: 'running' },
          '1.3': { id: '1.3', query: 'q3', status: 'running' },
        },
      };

      // Mock sessions - first fails, second succeeds
      const mockSession1 = {
        steer: vi.fn(async () => {
          throw new Error('Session closed');
        }),
      };

      const mockSession2 = {
        steer: vi.fn(async () => {
          // Success
        }),
      };

      // Set the active sessions
      (orchestrator as any).activeSessions.set('1.2', mockSession1);
      (orchestrator as any).activeSessions.set('1.3', mockSession2);

      // Inject findings - should continue after first failure
      const finished = (orchestrator as any).state.aspects['1.1'];

      // Should not throw
      await expect(
        (orchestrator as any).injectFindingsIntoRunningSiblings(finished)
      ).resolves.not.toThrow();

      // Both sessions should have been attempted
      expect(mockSession1.steer).toHaveBeenCalled();
      expect(mockSession2.steer).toHaveBeenCalled();

      // Warning logged for failed injection
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to inject findings from 1.1 into 1.2'),
        expect.any(Error)
      );
    });

    it('should skip siblings without reports', async () => {
      const options = createMockOptions();
      const orchestrator = new DeepResearchOrchestrator(options);

      // Setup state with finished sibling having no report
      (orchestrator as any).state = {
        ...options,
        currentRound: 1,
        aspects: {
          '1.1': { id: '1.1', query: 'q1', status: 'completed', report: '' }, // Empty report
          '1.2': { id: '1.2', query: 'q2', status: 'running' },
        },
      };

      const mockSession = {
        steer: vi.fn(async () => {}),
      };

      (orchestrator as any).activeSessions.set('1.2', mockSession);

      // Inject findings - should skip silently due to empty report
      const finished = (orchestrator as any).state.aspects['1.1'];
      await (orchestrator as any).injectFindingsIntoRunningSiblings(finished);

      // No injection attempted
      expect(mockSession.steer).not.toHaveBeenCalled();
    });
  });
});
