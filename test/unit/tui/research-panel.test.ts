/**
 * Research Panel Unit Tests
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createInitialPanelState,
  addSlice,
  activateSlice,
  completeSlice,
  flashSlice,
  updateSliceTokens,
  createResearchPanel,
} from '../../../src/tui/research-panel.ts';

const mockTheme = {
  fg: (_color: string, text: string) => `\u001b[31m${text}\u001b[0m`,
};

describe('TUI Research Panel', () => {
  const searxngStatus = {
    state: 'active' as const,
    url: 'http://localhost:8080',
    isFunctional: false,
  };

  describe('createInitialPanelState', () => {
    it('should create initial state with correct properties', () => {
      const state = createInitialPanelState('test-session-id', 'test-query', searxngStatus, 'test-model');
      expect(state.searxngStatus).toEqual(searxngStatus);
      expect(state.totalTokens).toBe(0);
      expect(state.modelName).toBe('test-model');
      expect(state.slices).toBeInstanceOf(Map);
    });
  });

  describe('addSlice', () => {
    it('should add a slice to the state', () => {
      const state = createInitialPanelState('test-session-id', 'test-query', searxngStatus, 'test-model');
      addSlice(state, 'slice1', '1:1');
      expect(state.slices.has('slice1')).toBe(true);
      expect(state.slices.get('slice1')?.label).toBe('1:1');
    });

    it('should add a queued slice', () => {
      const state = createInitialPanelState('test-session-id', 'test-query', searxngStatus, 'test-model');
      addSlice(state, 'slice1', '1:1', true);
      expect(state.slices.get('slice1')?.queued).toBe(true);
    });
  });

  describe('activateSlice', () => {
    it('should unqueue a slice', () => {
      const state = createInitialPanelState('test-session-id', 'test-query', searxngStatus, 'test-model');
      addSlice(state, 'slice1', '1:1', true);
      activateSlice(state, 'slice1');
      expect(state.slices.get('slice1')?.queued).toBe(false);
    });
  });

  describe('completeSlice', () => {
    it('should mark a slice as completed', () => {
      const state = createInitialPanelState('test-session-id', 'test-query', searxngStatus, 'test-model');
      addSlice(state, 'slice1', '1:1');
      completeSlice(state, 'slice1');
      expect(state.slices.get('slice1')?.completed).toBe(true);
    });
  });

  describe('flashSlice', () => {
    it('should set flash on a slice', () => {
      vi.useFakeTimers();
      const state = createInitialPanelState('test-session-id', 'test-query', searxngStatus, 'test-model');
      addSlice(state, 'slice1', '1:1');
      
      flashSlice(state, 'slice1', 'green', 1000);
      expect(state.slices.get('slice1')?.flash).toBe('green');
      
      vi.advanceTimersByTime(1000);
      expect(state.slices.get('slice1')?.flash).toBe(null);
      vi.useRealTimers();
    });
  });

  describe('render', () => {
    it('should output exactly 4 lines when empty', () => {
      const state = createInitialPanelState('test-session-id', 'test-query', searxngStatus, 'test-model');
      const componentCreator = createResearchPanel(state);
      const component = componentCreator({}, mockTheme as any);
      
      const lines = component.render(80);
      expect(lines.length).toBe(4);
    });

    it('should output exactly 4 lines with a researcher slice', () => {
      const state = createInitialPanelState('test-session-id', 'test-query', searxngStatus, 'test-model');
      addSlice(state, 'slice1', '1');
      updateSliceTokens(state, 'slice1', 12000, 0.05);
      
      const componentCreator = createResearchPanel(state);
      const component = componentCreator({}, mockTheme as any);
      
      const lines = component.render(80);
      expect(lines.length).toBe(4);
      
      // Check if tokens and cost are present in the output
      const output = lines.join('\n');
      expect(output).toContain('12k');
      expect(output).toContain('$0.05');
    });

    it('should render eval box with rounded corners and double borders', () => {
      const state = createInitialPanelState('test-session-id', 'test-query', searxngStatus, 'test-model');
      addSlice(state, 'slice1', '1');
      updateSliceTokens(state, 'slice1', 18000, 0.0056);
      addSlice(state, 'slice2', '2');
      updateSliceTokens(state, 'slice2', 36000, 0.0055);
      addSlice(state, 'eval1', 'Eval');
      activateSlice(state, 'eval1');
      
      const componentCreator = createResearchPanel(state);
      const component = componentCreator({}, mockTheme as any);
      
      const lines = component.render(80);
      expect(lines.length).toBe(4);
      
      const output = lines.join('\n');
      // Eval box uses shared-border design: ╭ from prev col, ╮/╯/╰ on eval's own corners
      expect(output).toContain('╭');
      expect(output).toContain('╮');
      expect(output).toContain('╰');
      expect(output).toContain('╯');
      // Single-border design: no double ││ on eval sides
      expect(output).not.toContain('││');
      // Check for eval label
      expect(output).toContain('Eval');
    });

    it('should output exactly 4 lines when SearXNG is hidden', () => {
      const state = createInitialPanelState('test-session-id', 'test-query', searxngStatus, 'test-model');
      state.hideSearxng = true;
      addSlice(state, 'slice1', '1');
      
      const componentCreator = createResearchPanel(state);
      const component = componentCreator({}, mockTheme as any);
      
      const lines = component.render(80);
      expect(lines.length).toBe(4);
    });
  });
});
