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
} from '../../../src/tui/research-panel.ts';

describe('TUI Research Panel', () => {
  const searxngStatus = {
    state: 'active' as const,
    connectionCount: 0,
    url: 'http://localhost:8080',
  };

  describe('createInitialPanelState', () => {
    it('should create initial state with correct properties', () => {
      const state = createInitialPanelState('test-session-id', searxngStatus, 'test-model');
      expect(state.searxngStatus).toEqual(searxngStatus);
      expect(state.totalTokens).toBe(0);
      expect(state.modelName).toBe('test-model');
      expect(state.slices).toBeInstanceOf(Map);
    });
  });

  describe('addSlice', () => {
    it('should add a slice to the state', () => {
      const state = createInitialPanelState('test-session-id', searxngStatus, 'test-model');
      addSlice(state, 'slice1', '1:1');
      expect(state.slices.has('slice1')).toBe(true);
      expect(state.slices.get('slice1')?.label).toBe('1:1');
    });

    it('should add a queued slice', () => {
      const state = createInitialPanelState('test-session-id', searxngStatus, 'test-model');
      addSlice(state, 'slice1', '1:1', true);
      expect(state.slices.get('slice1')?.queued).toBe(true);
    });
  });

  describe('activateSlice', () => {
    it('should unqueue a slice', () => {
      const state = createInitialPanelState('test-session-id', searxngStatus, 'test-model');
      addSlice(state, 'slice1', '1:1', true);
      activateSlice(state, 'slice1');
      expect(state.slices.get('slice1')?.queued).toBe(false);
    });
  });

  describe('completeSlice', () => {
    it('should mark a slice as completed', () => {
      const state = createInitialPanelState('test-session-id', searxngStatus, 'test-model');
      addSlice(state, 'slice1', '1:1');
      completeSlice(state, 'slice1');
      expect(state.slices.get('slice1')?.completed).toBe(true);
    });
  });

  describe('flashSlice', () => {
    it('should set flash on a slice', () => {
      vi.useFakeTimers();
      const state = createInitialPanelState('test-session-id', searxngStatus, 'test-model');
      addSlice(state, 'slice1', '1:1');
      
      flashSlice(state, 'slice1', 'green', 1000);
      expect(state.slices.get('slice1')?.flash).toBe('green');
      
      vi.advanceTimersByTime(1000);
      expect(state.slices.get('slice1')?.flash).toBe(null);
      vi.useRealTimers();
    });
  });
});
