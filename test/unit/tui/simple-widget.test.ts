/**
 * Simple TUI Widget Unit Tests
 *
 * Tests the simple TUI panel widget and its utility functions.
 */

import { describe, it, expect } from 'vitest';
import type { AgentDot, SimplePanelState } from '../../../src/tui/simple-widget';
import { clearAllFlashTimeouts, getCapturedTui } from '../../../src/tui/simple-widget';

describe('Simple TUI Widget', () => {
  describe('clearAllFlashTimeouts', () => {
    it('should not throw when called', () => {
      expect(() => {
        clearAllFlashTimeouts();
      }).not.toThrow();
    });

    it('should be callable multiple times', () => {
      expect(() => {
        clearAllFlashTimeouts();
        clearAllFlashTimeouts();
        clearAllFlashTimeouts();
      }).not.toThrow();
    });
  });

  describe('getCapturedTui', () => {
    it('should return null or an object', () => {
      const tui = getCapturedTui();

      expect(tui === null || typeof tui === 'object').toBe(true);
    });

    it('should be callable multiple times', () => {
      const tui1 = getCapturedTui();
      const tui2 = getCapturedTui();
      const tui3 = getCapturedTui();

      expect(typeof tui1).toBe(typeof tui2);
      expect(typeof tui2).toBe(typeof tui3);
    });
  });

  describe('SimplePanelState interface', () => {
    it('should allow creating state with valid searxng status', () => {
      const state: SimplePanelState = {
        searxngStatus: {
          state: 'active',
          connectionCount: 1,
          url: 'http://localhost:8080',
        },
        totalTokens: 0,
        agents: new Map(),
      };

      expect(state).toBeDefined();
      expect(state.searxngStatus.state).toBe('active');
      expect(state.totalTokens).toBe(0);
      expect(state.agents).toBeInstanceOf(Map);
    });

    it('should allow adding agents to state', () => {
      const state: SimplePanelState = {
        searxngStatus: {
          state: 'active',
          connectionCount: 1,
          url: 'http://localhost:8080',
        },
        totalTokens: 0,
        agents: new Map(),
      };

      const agent: AgentDot = {
        label: 'agent1',
        flash: null,
      };

      state.agents.set('agent1', agent);

      expect(state.agents.get('agent1')).toEqual(agent);
      expect(state.agents.size).toBe(1);
    });

    it('should allow modifying agent flash status', () => {
      const state: SimplePanelState = {
        searxngStatus: {
          state: 'active',
          connectionCount: 1,
          url: 'http://localhost:8080',
        },
        totalTokens: 0,
        agents: new Map(),
      };

      const agent: AgentDot = {
        label: 'agent1',
        flash: null,
      };

      state.agents.set('agent1', agent);
      state.agents.get('agent1')!.flash = 'green';

      expect(state.agents.get('agent1')?.flash).toBe('green');
    });

    it('should support different searxng states', () => {
      const states: Array<'starting_up' | 'active' | 'inactive' | 'error'> = [
        'starting_up',
        'active',
        'inactive',
        'error',
      ];

      for (const stateValue of states) {
        const state: SimplePanelState = {
          searxngStatus: {
            state: stateValue,
            connectionCount: 1,
            url: 'http://localhost:8080',
          },
          totalTokens: 0,
          agents: new Map(),
        };

        expect(state.searxngStatus.state).toBe(stateValue);
      }
    });

    it('should support different connection counts', () => {
      const counts = [0, 1, 5, 10, 100];

      for (const count of counts) {
        const state: SimplePanelState = {
          searxngStatus: {
            state: 'active',
            connectionCount: count,
            url: 'http://localhost:8080',
          },
          totalTokens: 0,
          agents: new Map(),
        };

        expect(state.searxngStatus.connectionCount).toBe(count);
      }
    });

    it('should allow updating token counts', () => {
      const state: SimplePanelState = {
        searxngStatus: {
          state: 'active',
          connectionCount: 1,
          url: 'http://localhost:8080',
        },
        totalTokens: 0,
        agents: new Map(),
      };

      state.totalTokens = 100;
      expect(state.totalTokens).toBe(100);

      state.totalTokens = 1000;
      expect(state.totalTokens).toBe(1000);

      state.totalTokens = 10000;
      expect(state.totalTokens).toBe(10000);
    });

    it('should support multiple agents', () => {
      const state: SimplePanelState = {
        searxngStatus: {
          state: 'active',
          connectionCount: 3,
          url: 'http://localhost:8080',
        },
        totalTokens: 0,
        agents: new Map(),
      };

      state.agents.set('agent1', { label: 'agent1', flash: null });
      state.agents.set('agent2', { label: 'agent2', flash: 'green' });
      state.agents.set('agent3', { label: 'agent3', flash: 'red' });

      expect(state.agents.size).toBe(3);
      expect(state.agents.get('agent1')?.flash).toBeNull();
      expect(state.agents.get('agent2')?.flash).toBe('green');
      expect(state.agents.get('agent3')?.flash).toBe('red');
    });

    it('should allow clearing agents', () => {
      const state: SimplePanelState = {
        searxngStatus: {
          state: 'active',
          connectionCount: 1,
          url: 'http://localhost:8080',
        },
        totalTokens: 0,
        agents: new Map(),
      };

      state.agents.set('agent1', { label: 'agent1', flash: null });
      expect(state.agents.size).toBe(1);

      state.agents.clear();
      expect(state.agents.size).toBe(0);
    });

    it('should support custom URL formats', () => {
      const urls = [
        'http://localhost:8080',
        'http://proxy.example.com:3128',
        'http://192.168.1.1:9090',
        'https://searxng.example.com',
      ];

      for (const url of urls) {
        const state: SimplePanelState = {
          searxngStatus: {
            state: 'active',
            connectionCount: 1,
            url,
          },
          totalTokens: 0,
          agents: new Map(),
        };

        expect(state.searxngStatus.url).toBe(url);
      }
    });

    it('should handle large token counts', () => {
      const state: SimplePanelState = {
        searxngStatus: {
          state: 'active',
          connectionCount: 1,
          url: 'http://localhost:8080',
        },
        totalTokens: Number.MAX_SAFE_INTEGER,
        agents: new Map(),
      };

      expect(state.totalTokens).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('should handle negative token counts', () => {
      const state: SimplePanelState = {
        searxngStatus: {
          state: 'active',
          connectionCount: 1,
          url: 'http://localhost:8080',
        },
        totalTokens: -100,
        agents: new Map(),
      };

      expect(state.totalTokens).toBe(-100);
    });
  });

  describe('AgentDot interface', () => {
    it('should allow creating agent with null flash', () => {
      const agent: AgentDot = {
        label: 'test-agent',
        flash: null,
      };

      expect(agent.label).toBe('test-agent');
      expect(agent.flash).toBeNull();
    });

    it('should allow creating agent with green flash', () => {
      const agent: AgentDot = {
        label: 'test-agent',
        flash: 'green',
      };

      expect(agent.label).toBe('test-agent');
      expect(agent.flash).toBe('green');
    });

    it('should allow creating agent with red flash', () => {
      const agent: AgentDot = {
        label: 'test-agent',
        flash: 'red',
      };

      expect(agent.label).toBe('test-agent');
      expect(agent.flash).toBe('red');
    });

    it('should support agent labels with special characters', () => {
      const labels = ['agent-1', 'agent_2', 'agent.3', 'agent@4', 'agent#5'];

      for (const label of labels) {
        const agent: AgentDot = {
          label,
          flash: null,
        };

        expect(agent.label).toBe(label);
      }
    });

    it('should support empty agent labels', () => {
      const agent: AgentDot = {
        label: '',
        flash: null,
      };

      expect(agent.label).toBe('');
    });

    it('should support very long agent labels', () => {
      const longLabel = 'a'.repeat(1000);
      const agent: AgentDot = {
        label: longLabel,
        flash: null,
      };

      expect(agent.label).toBe(longLabel);
      expect(agent.label.length).toBe(1000);
    });
  });

  describe('State transitions', () => {
    it('should allow transitioning between searxng states', () => {
      const state: SimplePanelState = {
        searxngStatus: {
          state: 'starting_up',
          connectionCount: 0,
          url: 'http://localhost:8080',
        },
        totalTokens: 0,
        agents: new Map(),
      };

      state.searxngStatus.state = 'active';
      expect(state.searxngStatus.state).toBe('active');

      state.searxngStatus.state = 'inactive';
      expect(state.searxngStatus.state).toBe('inactive');

      state.searxngStatus.state = 'error';
      expect(state.searxngStatus.state).toBe('error');
    });

    it('should allow increasing connection count', () => {
      const state: SimplePanelState = {
        searxngStatus: {
          state: 'active',
          connectionCount: 0,
          url: 'http://localhost:8080',
        },
        totalTokens: 0,
        agents: new Map(),
      };

      state.searxngStatus.connectionCount = 1;
      expect(state.searxngStatus.connectionCount).toBe(1);

      state.searxngStatus.connectionCount = 5;
      expect(state.searxngStatus.connectionCount).toBe(5);

      state.searxngStatus.connectionCount = 0;
      expect(state.searxngStatus.connectionCount).toBe(0);
    });

    it('should allow complex state updates', () => {
      const state: SimplePanelState = {
        searxngStatus: {
          state: 'starting_up',
          connectionCount: 0,
          url: 'http://localhost:8080',
        },
        totalTokens: 0,
        agents: new Map(),
      };

      // Simulate state changes
      state.searxngStatus.state = 'active';
      state.searxngStatus.connectionCount = 3;
      state.totalTokens = 5000;
      state.agents.set('r1', { label: 'researcher-1', flash: null });
      state.agents.set('r2', { label: 'researcher-2', flash: 'green' });

      expect(state.searxngStatus.state).toBe('active');
      expect(state.searxngStatus.connectionCount).toBe(3);
      expect(state.totalTokens).toBe(5000);
      expect(state.agents.size).toBe(2);
    });
  });
});
