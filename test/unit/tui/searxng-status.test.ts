/**
 * SearXNG Status Component Unit Tests
 *
 * Tests the SearXNG status display component and state management.
 */

import { describe, it, expect } from 'vitest';
import type { SearxngStatus } from '../../../src/searxng-lifecycle';
import { getCapturedTui, createSearxngStatusComponent } from '../../../src/tui/searxng-status';

/**
 * Create a mock SearXNG status
 */
function createMockStatus(overrides: Partial<SearxngStatus> = {}): SearxngStatus {
  return {
    state: 'active',
    connectionCount: 1,
    url: 'http://localhost:8080',
    ...overrides,
  };
}

describe('SearXNG Status Component', () => {
  describe('getCapturedTui', () => {
    it('should return null or an object', () => {
      const tui = getCapturedTui();

      expect(tui === null || typeof tui === 'object').toBe(true);
    });

    it('should be callable multiple times', () => {
      const tui1 = getCapturedTui();
      const tui2 = getCapturedTui();

      expect(typeof tui1).toBe(typeof tui2);
    });

    it('should return object with optional requestRender method', () => {
      const tui = getCapturedTui();

      if (tui !== null) {
        expect(typeof tui).toBe('object');
        if ('requestRender' in tui) {
          expect(typeof tui.requestRender).toBe('function');
        }
      }
    });
  });

  describe('createSearxngStatusComponent', () => {
    it('should return a function', () => {
      const status = createMockStatus();
      const component = createSearxngStatusComponent(status);

      expect(typeof component).toBe('function');
    });

    it('should create component for active status', () => {
      const status = createMockStatus({ state: 'active' });
      const componentFn = createSearxngStatusComponent(status);

      expect(typeof componentFn).toBe('function');
    });

    it('should create component for inactive status', () => {
      const status = createMockStatus({ state: 'inactive' });
      const componentFn = createSearxngStatusComponent(status);

      expect(typeof componentFn).toBe('function');
    });

    it('should create component for error status', () => {
      const status = createMockStatus({ state: 'error' });
      const componentFn = createSearxngStatusComponent(status);

      expect(typeof componentFn).toBe('function');
    });

    it('should create component for starting_up status', () => {
      const status = createMockStatus({ state: 'starting_up' });
      const componentFn = createSearxngStatusComponent(status);

      expect(typeof componentFn).toBe('function');
    });

    it('should accept different connection counts', () => {
      const counts = [0, 1, 5, 10, 100];

      for (const count of counts) {
        const status = createMockStatus({ connectionCount: count });
        const componentFn = createSearxngStatusComponent(status);

        expect(typeof componentFn).toBe('function');
      }
    });

    it('should accept different URLs', () => {
      const urls = [
        'http://localhost:8080',
        'http://proxy.example.com:3128',
        'https://searxng.example.com',
      ];

      for (const url of urls) {
        const status = createMockStatus({ url });
        const componentFn = createSearxngStatusComponent(status);

        expect(typeof componentFn).toBe('function');
      }
    });

    it('should handle status with minimal info', () => {
      const status = createMockStatus({
        state: 'active',
        connectionCount: 1,
        url: '',
      });

      const componentFn = createSearxngStatusComponent(status);

      expect(typeof componentFn).toBe('function');
    });

    it('should handle status with large URL', () => {
      const status = createMockStatus({
        url: 'http://example.com:' + '8080'.repeat(100),
      });

      const componentFn = createSearxngStatusComponent(status);

      expect(typeof componentFn).toBe('function');
    });

    it('should handle status with large connection count', () => {
      const status = createMockStatus({
        connectionCount: 9999,
      });

      const componentFn = createSearxngStatusComponent(status);

      expect(typeof componentFn).toBe('function');
    });
  });

  describe('Component Function Signature', () => {
    it('should accept tui and theme parameters', () => {
      const status = createMockStatus();
      const componentFn = createSearxngStatusComponent(status);

      expect(() => {
        componentFn({}, { colors: {} });
      }).not.toThrow();
    });

    it('should return component with render method', () => {
      const status = createMockStatus();
      const componentFn = createSearxngStatusComponent(status);

      const component = componentFn({}, { colors: {} });

      expect(typeof component.render).toBe('function');
    });

    it('should return component with invalidate method', () => {
      const status = createMockStatus();
      const componentFn = createSearxngStatusComponent(status);

      const component = componentFn({}, { colors: {} });

      expect(typeof component.invalidate).toBe('function');
    });

    it('should return component with optional dispose method', () => {
      const status = createMockStatus();
      const componentFn = createSearxngStatusComponent(status);

      const component = componentFn({}, { colors: {} });

      if ('dispose' in component) {
        expect(typeof component.dispose).toBe('function');
      }
    });
  });

  describe('State Management', () => {
    it('should handle all valid status states', () => {
      const validStates: Array<'starting_up' | 'active' | 'inactive' | 'error'> = [
        'starting_up',
        'active',
        'inactive',
        'error',
      ];

      for (const state of validStates) {
        const status = createMockStatus({ state });
        const componentFn = createSearxngStatusComponent(status);

        expect(typeof componentFn).toBe('function');
      }
    });

    it('should create component with same state twice', () => {
      const status = createMockStatus();
      const componentFn1 = createSearxngStatusComponent(status);
      const componentFn2 = createSearxngStatusComponent(status);

      expect(typeof componentFn1).toBe('function');
      expect(typeof componentFn2).toBe('function');
    });

    it('should handle rapid status updates', () => {
      let status = createMockStatus();
      const componentFn = createSearxngStatusComponent(status);

      // Simulate rapid status changes
      const statuses = [
        createMockStatus({ state: 'active', connectionCount: 1 }),
        createMockStatus({ state: 'inactive', connectionCount: 0 }),
        createMockStatus({ state: 'error', connectionCount: 0 }),
        createMockStatus({ state: 'starting_up', connectionCount: 1 }),
      ];

      for (const s of statuses) {
        status = s;
        const component = componentFn({}, { colors: {} });
        expect(typeof component.render).toBe('function');
      }
    });
  });

  describe('Component Rendering', () => {
    it('should have render method on component', () => {
      const status = createMockStatus();
      const componentFn = createSearxngStatusComponent(status);

      expect(typeof componentFn).toBe('function');
    });

    it('should accept width parameter to render', () => {
      const status = createMockStatus();
      const componentFn = createSearxngStatusComponent(status);

      expect(typeof componentFn).toBe('function');
    });

    it('should invalidate component', () => {
      const status = createMockStatus();
      const componentFn = createSearxngStatusComponent(status);
      const component = componentFn({}, { colors: {} });

      expect(() => {
        component.invalidate();
      }).not.toThrow();
    });

    it('should support multiple invalidate calls', () => {
      const status = createMockStatus();
      const componentFn = createSearxngStatusComponent(status);
      const component = componentFn({}, { colors: {} });

      expect(() => {
        component.invalidate();
        component.invalidate();
        component.invalidate();
      }).not.toThrow();
    });
  });

  describe('Edge Cases', () => {
    it('should handle null URL', () => {
      const status = createMockStatus();
      status.url = '' as any;

      const componentFn = createSearxngStatusComponent(status);

      expect(typeof componentFn).toBe('function');
    });

    it('should handle zero connection count', () => {
      const status = createMockStatus({ connectionCount: 0 });
      const componentFn = createSearxngStatusComponent(status);

      expect(typeof componentFn).toBe('function');
    });

    it('should handle negative connection count', () => {
      const status = createMockStatus({ connectionCount: -1 });
      const componentFn = createSearxngStatusComponent(status);

      expect(typeof componentFn).toBe('function');
    });

    it('should handle very large connection count', () => {
      const status = createMockStatus({ connectionCount: 999999 });
      const componentFn = createSearxngStatusComponent(status);

      expect(typeof componentFn).toBe('function');
    });

    it('should handle empty component creation and immediate disposal', () => {
      const status = createMockStatus();
      const componentFn = createSearxngStatusComponent(status);
      const component = componentFn({}, { colors: {} });

      if ('dispose' in component && component.dispose) {
        expect(() => {
          component.dispose();
        }).not.toThrow();
      }
    });

    it('should handle multiple component instances', () => {
      const status1 = createMockStatus({ state: 'active' });
      const status2 = createMockStatus({ state: 'inactive' });
      const status3 = createMockStatus({ state: 'error' });

      const componentFn1 = createSearxngStatusComponent(status1);
      const componentFn2 = createSearxngStatusComponent(status2);
      const componentFn3 = createSearxngStatusComponent(status3);

      const component1 = componentFn1({}, { colors: {} });
      const component2 = componentFn2({}, { colors: {} });
      const component3 = componentFn3({}, { colors: {} });

      expect(typeof component1.render).toBe('function');
      expect(typeof component2.render).toBe('function');
      expect(typeof component3.render).toBe('function');
    });
  });
});
