/**
 * Delegate Research Tool Unit Tests
 *
 * Tests the delegate research tool configuration and behavior.
 * The tool allows coordinators to spawn researcher agents in parallel or sequential mode.
 */

import { describe, it, expect } from 'vitest';
import type { DelegateToolOptions } from '../../../src/orchestration/delegate-tool';

describe('Delegate Research Tool', () => {
  describe('DelegateToolOptions interface', () => {
    it('should accept valid options with all required fields', () => {
      const options: DelegateToolOptions = {
        sessionId: 'session-123',
        breadthCounter: { value: 0 },
        panelState: {} as any,
        onTokens: (n: number) => {},
        onUpdate: () => {},
        researcherOptions: {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You are a researcher',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: {},
        },
        timeoutMs: 30000,
        flashTimeoutMs: 500,
      };

      expect(options.sessionId).toBe('session-123');
      expect(options.timeoutMs).toBe(30000);
      expect(options.flashTimeoutMs).toBe(500);
    });

    it('should accept different session IDs', () => {
      const sessionIds = ['session-1', 'research-abc123', 'ctx-xyz', ''];

      for (const sessionId of sessionIds) {
        const options: DelegateToolOptions = {
          sessionId,
          breadthCounter: { value: 0 },
          panelState: {} as any,
          onTokens: (n: number) => {},
          onUpdate: () => {},
          researcherOptions: {
            cwd: '/home/user/project',
            ctxModel: { name: 'gpt-4' },
            modelRegistry: {} as any,
            sessionManager: {} as any,
            settingsManager: {} as any,
            systemPrompt: 'You are a researcher',
            searxngUrl: 'http://localhost:8080',
            extensionCtx: {},
          },
          timeoutMs: 30000,
          flashTimeoutMs: 500,
        };

        expect(options.sessionId).toBe(sessionId);
      }
    });

    it('should track breadth counter', () => {
      const counter = { value: 0 };
      const options: DelegateToolOptions = {
        sessionId: 'session-123',
        breadthCounter: counter,
        panelState: {} as any,
        onTokens: (n: number) => {},
        onUpdate: () => {},
        researcherOptions: {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You are a researcher',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: {},
        },
        timeoutMs: 30000,
        flashTimeoutMs: 500,
      };

      // Test counter mutation
      options.breadthCounter.value = 5;
      expect(options.breadthCounter.value).toBe(5);
    });

    it('should accept token callback function', () => {
      let tokenCount = 0;
      const onTokens = (n: number) => {
        tokenCount += n;
      };

      const options: DelegateToolOptions = {
        sessionId: 'session-123',
        breadthCounter: { value: 0 },
        panelState: {} as any,
        onTokens,
        onUpdate: () => {},
        researcherOptions: {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You are a researcher',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: {},
        },
        timeoutMs: 30000,
        flashTimeoutMs: 500,
      };

      options.onTokens(100);
      expect(tokenCount).toBe(100);
    });

    it('should accept update callback function', () => {
      let updateCount = 0;
      const onUpdate = () => {
        updateCount++;
      };

      const options: DelegateToolOptions = {
        sessionId: 'session-123',
        breadthCounter: { value: 0 },
        panelState: {} as any,
        onTokens: () => {},
        onUpdate,
        researcherOptions: {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You are a researcher',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: {},
        },
        timeoutMs: 30000,
        flashTimeoutMs: 500,
      };

      options.onUpdate();
      expect(updateCount).toBe(1);
    });
  });

  describe('Timeout configuration', () => {
    it('should accept different timeout values', () => {
      const timeouts = [1000, 5000, 30000, 60000, 300000];

      for (const timeoutMs of timeouts) {
        const options: DelegateToolOptions = {
          sessionId: 'session-123',
          breadthCounter: { value: 0 },
          panelState: {} as any,
          onTokens: () => {},
          onUpdate: () => {},
          researcherOptions: {
            cwd: '/home/user/project',
            ctxModel: { name: 'gpt-4' },
            modelRegistry: {} as any,
            sessionManager: {} as any,
            settingsManager: {} as any,
            systemPrompt: 'You are a researcher',
            searxngUrl: 'http://localhost:8080',
            extensionCtx: {},
          },
          timeoutMs,
          flashTimeoutMs: 500,
        };

        expect(options.timeoutMs).toBe(timeoutMs);
      }
    });

    it('should accept zero timeout', () => {
      const options: DelegateToolOptions = {
        sessionId: 'session-123',
        breadthCounter: { value: 0 },
        panelState: {} as any,
        onTokens: () => {},
        onUpdate: () => {},
        researcherOptions: {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You are a researcher',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: {},
        },
        timeoutMs: 0,
        flashTimeoutMs: 0,
      };

      expect(options.timeoutMs).toBe(0);
      expect(options.flashTimeoutMs).toBe(0);
    });
  });

  describe('Panel state management', () => {
    it('should accept panel state object', () => {
      const panelState = {
        activeResearchers: new Set(['researcher-1']),
        tokensUsed: 1000,
        failures: new Map(),
      };

      const options: DelegateToolOptions = {
        sessionId: 'session-123',
        breadthCounter: { value: 0 },
        panelState: panelState as any,
        onTokens: () => {},
        onUpdate: () => {},
        researcherOptions: {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You are a researcher',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: {},
        },
        timeoutMs: 30000,
        flashTimeoutMs: 500,
      };

      expect(options.panelState).toEqual(panelState);
    });

    it('should accept different panel state configurations', () => {
      const states = [
        {} as any,
        { researchers: [] } as any,
        { activeSlices: new Map() } as any,
        { tokens: 0, status: 'idle' } as any,
      ];

      for (const state of states) {
        const options: DelegateToolOptions = {
          sessionId: 'session-123',
          breadthCounter: { value: 0 },
          panelState: state,
          onTokens: () => {},
          onUpdate: () => {},
          researcherOptions: {
            cwd: '/home/user/project',
            ctxModel: { name: 'gpt-4' },
            modelRegistry: {} as any,
            sessionManager: {} as any,
            settingsManager: {} as any,
            systemPrompt: 'You are a researcher',
            searxngUrl: 'http://localhost:8080',
            extensionCtx: {},
          },
          timeoutMs: 30000,
          flashTimeoutMs: 500,
        };

        expect(options.panelState).toEqual(state);
      }
    });
  });

  describe('Researcher options propagation', () => {
    it('should propagate all researcher options', () => {
      const researcherOptions = {
        cwd: '/home/user/project',
        ctxModel: { name: 'gpt-4' },
        modelRegistry: { get: () => {} } as any,
        sessionManager: { create: () => {} } as any,
        settingsManager: { get: () => {} } as any,
        systemPrompt: 'You are a researcher',
        searxngUrl: 'http://localhost:8080',
        extensionCtx: { id: 'ext-1' },
      };

      const options: DelegateToolOptions = {
        sessionId: 'session-123',
        breadthCounter: { value: 0 },
        panelState: {} as any,
        onTokens: () => {},
        onUpdate: () => {},
        researcherOptions,
        timeoutMs: 30000,
        flashTimeoutMs: 500,
      };

      expect(options.researcherOptions.cwd).toBe('/home/user/project');
      expect(options.researcherOptions.searxngUrl).toBe('http://localhost:8080');
      expect(options.researcherOptions.systemPrompt).toBe('You are a researcher');
    });

    it('should accept different researcher configurations', () => {
      const configs = [
        {
          cwd: '/project1',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'Research project 1',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: {},
        },
        {
          cwd: '/project2',
          ctxModel: { name: 'claude-3' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'Research project 2',
          searxngUrl: 'http://proxy.example.com:3128',
          extensionCtx: {},
        },
      ];

      for (const researcherOptions of configs) {
        const options: DelegateToolOptions = {
          sessionId: 'session-123',
          breadthCounter: { value: 0 },
          panelState: {} as any,
          onTokens: () => {},
          onUpdate: () => {},
          researcherOptions,
          timeoutMs: 30000,
          flashTimeoutMs: 500,
        };

        expect(options.researcherOptions).toEqual(researcherOptions);
      }
    });
  });

  describe('Optional abort signal', () => {
    it('should accept undefined signal', () => {
      const options: DelegateToolOptions = {
        sessionId: 'session-123',
        breadthCounter: { value: 0 },
        panelState: {} as any,
        onTokens: () => {},
        onUpdate: () => {},
        researcherOptions: {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You are a researcher',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: {},
        },
        timeoutMs: 30000,
        flashTimeoutMs: 500,
      };

      expect(options.signal).toBeUndefined();
    });

    it('should accept abort signal', () => {
      const controller = new AbortController();
      const options: DelegateToolOptions = {
        sessionId: 'session-123',
        breadthCounter: { value: 0 },
        panelState: {} as any,
        onTokens: () => {},
        onUpdate: () => {},
        researcherOptions: {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You are a researcher',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: {},
        },
        signal: controller.signal,
        timeoutMs: 30000,
        flashTimeoutMs: 500,
      };

      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal?.aborted).toBe(false);
    });

    it('should work with aborted signal', () => {
      const controller = new AbortController();
      controller.abort();

      const options: DelegateToolOptions = {
        sessionId: 'session-123',
        breadthCounter: { value: 0 },
        panelState: {} as any,
        onTokens: () => {},
        onUpdate: () => {},
        researcherOptions: {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You are a researcher',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: {},
        },
        signal: controller.signal,
        timeoutMs: 30000,
        flashTimeoutMs: 500,
      };

      expect(options.signal?.aborted).toBe(true);
    });
  });

  describe('Complete option sets', () => {
    it('should support minimal configuration', () => {
      const options: DelegateToolOptions = {
        sessionId: 's1',
        breadthCounter: { value: 0 },
        panelState: {} as any,
        onTokens: () => {},
        onUpdate: () => {},
        researcherOptions: {
          cwd: '.',
          ctxModel: undefined,
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: '',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: null,
        },
        timeoutMs: 1000,
        flashTimeoutMs: 100,
      };

      expect(options).toBeDefined();
      expect(options.sessionId).toBe('s1');
    });

    it('should support full configuration', () => {
      const controller = new AbortController();
      const options: DelegateToolOptions = {
        sessionId: 'session-research-2024-001',
        breadthCounter: { value: 5 },
        panelState: {
          activeResearchers: new Set(['r1', 'r2']),
          tokensUsed: 50000,
        } as any,
        onTokens: (n: number) => {
          console.log(`Added ${n} tokens`);
        },
        onUpdate: () => {
          console.log('Updated');
        },
        researcherOptions: {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4', version: '1.0' },
          modelRegistry: { models: [] } as any,
          sessionManager: { start: () => {} } as any,
          settingsManager: { config: {} } as any,
          systemPrompt: 'Research this thoroughly',
          searxngUrl: 'https://searxng.example.com',
          extensionCtx: { id: 'my-ext', version: '1.0' },
        },
        signal: controller.signal,
        timeoutMs: 300000,
        flashTimeoutMs: 1000,
      };

      expect(options.sessionId).toBe('session-research-2024-001');
      expect(options.timeoutMs).toBe(300000);
    });
  });

  describe('Callback invocations', () => {
    it('should support multiple token updates', () => {
      let totalTokens = 0;
      const onTokens = (n: number) => {
        totalTokens += n;
      };

      const options: DelegateToolOptions = {
        sessionId: 'session-123',
        breadthCounter: { value: 0 },
        panelState: {} as any,
        onTokens,
        onUpdate: () => {},
        researcherOptions: {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You are a researcher',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: {},
        },
        timeoutMs: 30000,
        flashTimeoutMs: 500,
      };

      options.onTokens(1000);
      options.onTokens(2000);
      options.onTokens(3000);

      expect(totalTokens).toBe(6000);
    });

    it('should support multiple update calls', () => {
      let updateCount = 0;
      const onUpdate = () => {
        updateCount++;
      };

      const options: DelegateToolOptions = {
        sessionId: 'session-123',
        breadthCounter: { value: 0 },
        panelState: {} as any,
        onTokens: () => {},
        onUpdate,
        researcherOptions: {
          cwd: '/home/user/project',
          ctxModel: { name: 'gpt-4' },
          modelRegistry: {} as any,
          sessionManager: {} as any,
          settingsManager: {} as any,
          systemPrompt: 'You are a researcher',
          searxngUrl: 'http://localhost:8080',
          extensionCtx: {},
        },
        timeoutMs: 30000,
        flashTimeoutMs: 500,
      };

      options.onUpdate();
      options.onUpdate();
      options.onUpdate();

      expect(updateCount).toBe(3);
    });
  });
});
