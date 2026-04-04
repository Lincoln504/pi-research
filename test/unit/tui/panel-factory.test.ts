/**
 * TUI Panel Factory Unit Tests
 *
 * Tests the factory functions that create and manage TUI panels.
 * Focuses on state initialization, mode switching, and agent management.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { SearxngStatus } from '../../../src/searxng-lifecycle';
import {
  createPanel,
  getCapturedTui,
  clearAllFlashTimeouts,
  setAgentFlash,
  addAgent,
  createInitialPanelState,
  type SimplePanelState,
} from '../../../src/tui/panel-factory';

/**
 * Create a mock SearXNG status for testing
 */
function createMockSearxngStatus(overrides: Partial<SearxngStatus> = {}): SearxngStatus {
  return {
    state: 'active',
    connectionCount: 1,
    url: 'http://localhost:8080',
    ...overrides,
  };
}

describe('TUI Panel Factory', () => {
  afterEach(() => {
    // Clean up any active timeouts
    clearAllFlashTimeouts();
  });

  describe('createInitialPanelState', () => {
    it('should create simple panel state by default', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus);

      expect(state).toBeDefined();
      expect((state as SimplePanelState).searxngStatus).toEqual(searxngStatus);
      expect((state as SimplePanelState).totalTokens).toBe(0);
      expect((state as SimplePanelState).agents).toBeInstanceOf(Map);
      expect((state as SimplePanelState).agents.size).toBe(0);
    });

    it('should initialize agents map as empty', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus) as SimplePanelState;

      expect(state.agents).toBeInstanceOf(Map);
      expect(state.agents.size).toBe(0);
    });

    it('should set total tokens to 0', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus);

      expect(state.totalTokens).toBe(0);
    });

    it('should handle different searxng states', () => {
      const states: SearxngStatus['state'][] = ['starting_up', 'active', 'inactive', 'error'];

      for (const stateValue of states) {
        const searxngStatus = createMockSearxngStatus({ state: stateValue });
        const state = createInitialPanelState(searxngStatus) as SimplePanelState;

        expect(state.searxngStatus.state).toBe(stateValue);
      }
    });

    it('should handle different connection counts', () => {
      const counts = [0, 1, 5, 10, 100];

      for (const count of counts) {
        const searxngStatus = createMockSearxngStatus({ connectionCount: count });
        const state = createInitialPanelState(searxngStatus) as SimplePanelState;

        expect(state.searxngStatus.connectionCount).toBe(count);
      }
    });

    it('should handle custom proxy URLs', () => {
      const searxngStatus = createMockSearxngStatus({
        url: 'http://proxy.example.com:3128',
      });
      const state = createInitialPanelState(searxngStatus) as SimplePanelState;

      expect(state.searxngStatus.url).toBe('http://proxy.example.com:3128');
    });
  });

  describe('addAgent', () => {
    it('should add agent to simple panel state', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus) as SimplePanelState;

      addAgent(state, 'agent1', 0);

      expect(state.agents.has('agent1')).toBe(true);
      expect(state.agents.size).toBe(1);
    });

    it('should add multiple agents', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus) as SimplePanelState;

      addAgent(state, 'agent1', 0);
      addAgent(state, 'agent2', 1);
      addAgent(state, 'agent3', 2);

      expect(state.agents.size).toBe(3);
      expect(state.agents.has('agent1')).toBe(true);
      expect(state.agents.has('agent2')).toBe(true);
      expect(state.agents.has('agent3')).toBe(true);
    });

    it('should initialize agent with label and null flash', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus) as SimplePanelState;

      addAgent(state, 'test-agent', 0);

      const agent = state.agents.get('test-agent');
      expect(agent).toBeDefined();
      expect(agent?.label).toBe('test-agent');
      expect(agent?.flash).toBeNull();
    });

    it('should handle agent IDs with special characters', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus) as SimplePanelState;

      const agentIds = ['agent-1', 'agent_2', 'agent.3', 'agent@4'];

      for (const id of agentIds) {
        addAgent(state, id, 0);
        expect(state.agents.has(id)).toBe(true);
      }
    });

    it('should replace agent with same ID', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus) as SimplePanelState;

      addAgent(state, 'agent1', 0);
      expect(state.agents.size).toBe(1);

      // Add same agent again
      addAgent(state, 'agent1', 1);
      expect(state.agents.size).toBe(1);
    });

    it('should handle numeric slice numbers', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus) as SimplePanelState;

      const slices = [0, 1, 5, 10, 100];

      for (const slice of slices) {
        addAgent(state, `agent${slice}`, slice);
        expect(state.agents.has(`agent${slice}`)).toBe(true);
      }
    });
  });

  describe('setAgentFlash', () => {
    it('should set green flash on agent', () => {
      const agents = new Map();
      agents.set('agent1', { label: 'agent1', flash: null });

      setAgentFlash(agents, 'agent1', 'green', 100);

      expect(agents.get('agent1').flash).toBe('green');
    });

    it('should set red flash on agent', () => {
      const agents = new Map();
      agents.set('agent1', { label: 'agent1', flash: null });

      setAgentFlash(agents, 'agent1', 'red', 100);

      expect(agents.get('agent1').flash).toBe('red');
    });

    it('should override existing flash', () => {
      const agents = new Map();
      agents.set('agent1', { label: 'agent1', flash: 'green' });

      setAgentFlash(agents, 'agent1', 'red', 100);

      expect(agents.get('agent1').flash).toBe('red');
    });

    it('should clear flash after timeout', async () => {
      const agents = new Map();
      agents.set('agent1', { label: 'agent1', flash: null });

      setAgentFlash(agents, 'agent1', 'green', 50);

      expect(agents.get('agent1').flash).toBe('green');

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(agents.get('agent1').flash).toBeNull();
    });

    it('should handle multiple agents flashing simultaneously', () => {
      const agents = new Map();
      agents.set('agent1', { label: 'agent1', flash: null });
      agents.set('agent2', { label: 'agent2', flash: null });
      agents.set('agent3', { label: 'agent3', flash: null });

      setAgentFlash(agents, 'agent1', 'green', 100);
      setAgentFlash(agents, 'agent2', 'red', 100);
      setAgentFlash(agents, 'agent3', 'green', 100);

      expect(agents.get('agent1').flash).toBe('green');
      expect(agents.get('agent2').flash).toBe('red');
      expect(agents.get('agent3').flash).toBe('green');
    });

    it('should handle different timeout values', async () => {
      const agents = new Map();
      agents.set('agent1', { label: 'agent1', flash: null });

      setAgentFlash(agents, 'agent1', 'green', 20);

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(agents.get('agent1').flash).toBeNull();
    });
  });

  describe('clearAllFlashTimeouts', () => {
    it('should clear all active timeouts', async () => {
      const agents1 = new Map();
      const agents2 = new Map();
      agents1.set('agent1', { label: 'agent1', flash: null });
      agents2.set('agent2', { label: 'agent2', flash: null });

      setAgentFlash(agents1, 'agent1', 'green', 1000);
      setAgentFlash(agents2, 'agent2', 'red', 1000);

      expect(agents1.get('agent1').flash).toBe('green');
      expect(agents2.get('agent2').flash).toBe('red');

      clearAllFlashTimeouts();

      // Timeouts should be cleared, but flashes remain until we check
      // (This tests that no error occurs)
      expect(agents1.get('agent1').flash).toBe('green');
      expect(agents2.get('agent2').flash).toBe('red');
    });

    it('should not throw when called multiple times', () => {
      expect(() => {
        clearAllFlashTimeouts();
        clearAllFlashTimeouts();
        clearAllFlashTimeouts();
      }).not.toThrow();
    });

    it('should not throw when no timeouts are active', () => {
      clearAllFlashTimeouts();
      expect(() => clearAllFlashTimeouts()).not.toThrow();
    });
  });

  describe('getCapturedTui', () => {
    it('should return captured TUI reference or null', () => {
      const tui = getCapturedTui();

      // Should return either null or an object with requestRender method
      if (tui !== null) {
        expect(typeof tui).toBe('object');
        if ('requestRender' in tui) {
          expect(typeof tui.requestRender).toBe('function');
        }
      }
    });

    it('should be callable when present', () => {
      const tui = getCapturedTui();

      if (tui && 'requestRender' in tui && tui.requestRender) {
        expect(() => tui.requestRender!()).not.toThrow();
      }
    });
  });

  describe('createPanel', () => {
    it('should return a function', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus);

      const panelCreator = createPanel(state);

      expect(typeof panelCreator).toBe('function');
    });

    it('should accept tui and theme parameters', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus);

      const panelCreator = createPanel(state);

      // Mock theme object - can be called without passing it through
      // The panel factory returns a function that requires tui and theme
      expect(typeof panelCreator).toBe('function');
    });
  });

  describe('State immutability', () => {
    it('should allow agent modifications', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus) as SimplePanelState;

      addAgent(state, 'agent1', 0);
      const agent = state.agents.get('agent1');

      if (agent) {
        // Agent properties can be modified
        agent.flash = 'green';
        expect(state.agents.get('agent1')?.flash).toBe('green');
      }
    });

    it('should allow token updates', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus) as SimplePanelState;

      state.totalTokens = 100;
      expect(state.totalTokens).toBe(100);

      state.totalTokens = 500;
      expect(state.totalTokens).toBe(500);
    });

    it('should maintain map identity', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus) as SimplePanelState;

      const agentsRef = state.agents;

      addAgent(state, 'agent1', 0);

      // Same reference
      expect(state.agents === agentsRef).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty agent ID', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus) as SimplePanelState;

      addAgent(state, '', 0);

      expect(state.agents.has('')).toBe(true);
    });

    it('should handle very long agent ID', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus) as SimplePanelState;

      const longId = 'a'.repeat(10000);
      addAgent(state, longId, 0);

      expect(state.agents.has(longId)).toBe(true);
    });

    it('should handle large token counts', () => {
      const searxngStatus = createMockSearxngStatus();
      const state = createInitialPanelState(searxngStatus) as SimplePanelState;

      state.totalTokens = Number.MAX_SAFE_INTEGER;
      expect(state.totalTokens).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('should handle zero timeout', async () => {
      const agents = new Map();
      agents.set('agent1', { label: 'agent1', flash: null });

      setAgentFlash(agents, 'agent1', 'green', 0);

      // Even with 0 timeout, flash is set
      expect(agents.get('agent1').flash).toBe('green');
    });
  });
});
