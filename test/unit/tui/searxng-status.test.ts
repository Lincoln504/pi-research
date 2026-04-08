/**
 * SearXNG Status Component Unit Tests
 *
 * Tests the SearXNG status display component.
 */

import { describe, it, expect } from 'vitest';
import { createSearxngStatusComponent } from '../../../src/tui/searxng-status.ts';
import type { SearxngStatus } from '../../../src/infrastructure/searxng-lifecycle.ts';

const mockTheme = {
  fg: (_color: string, text: string) => text,
};

/**
 * Create a mock SearXNG status
 */
function createMockStatus(overrides: Partial<SearxngStatus> = {}): SearxngStatus {
  return {
    state: 'active',
    url: 'http://localhost:8080',
    isFunctional: false,
    ...overrides,
  };
}

describe('SearXNG Status Component', () => {
  describe('createSearxngStatusComponent', () => {
    it('should return a function', () => {
      const status = createMockStatus();
      const componentFn = createSearxngStatusComponent(status);

      expect(typeof componentFn).toBe('function');
    });
  });

  describe('render', () => {
    it('should return 4 lines of text', () => {
      const status = createMockStatus();
      const componentFn = createSearxngStatusComponent(status);
      const component = componentFn({}, mockTheme as any);

      const lines = component.render(14);

      expect(lines.length).toBe(4);
    });

    it('should include status text in output', () => {
      const status = createMockStatus({ state: 'active' });
      const componentFn = createSearxngStatusComponent(status);
      const component = componentFn({}, mockTheme as any);

      const lines = component.render(14);
      const output = lines.join('\n');

      expect(output).toContain('[active]');
    });

    it('should reflect different states', () => {
      const states: Array<SearxngStatus['state']> = ['active', 'inactive', 'starting_up', 'error'];

      for (const state of states) {
        const status = createMockStatus({ state });
        const componentFn = createSearxngStatusComponent(status);
        const component = componentFn({}, mockTheme as any);

        const lines = component.render(14);
        const output = lines.join('\n');

        const expectedText = state === 'starting_up' ? '[starting]' : `[${state}]`;
        expect(output).toContain(expectedText);
      }
    });
  });
});
