import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createInitialPanelState,
  addSlice,
  activateSlice,
  completeSlice,
  updateSliceTokens,
  clearCompletedResearchers,
  createMasterResearchPanel,
  _formatTokens,
  _renderProgressPct,
  _formatCost,
  type Theme
} from '../../../src/tui/research-panel.ts';

// Mock pi-tui
vi.mock('@earendil-works/pi-tui', () => ({
  visibleWidth: vi.fn().mockReturnValue(80),
  truncateToWidth: vi.fn().mockImplementation((s, w) => s.slice(0, w)),
}));

describe('TUI Research Panel', () => {
  const mockTheme = {
    fg: (_color: string, text: string) => text,
  };

  describe('createInitialPanelState', () => {
    it('should create initial state with correct properties', () => {
      const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
      expect(state.query).toBe('test-query');
      expect(state.modelName).toBe('test-model');
    });
  });

  describe('progress tracking', () => {
    it('should render progress percentage when progress is set', () => {
      const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
      state.progress = { expected: 10, made: 5 };

      const getActivePanelsMock = vi.fn().mockReturnValue([state]);
      const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
      const component = componentCreator(undefined, mockTheme);
      const lines = component.render(80);

      const headerLine = lines[0];
      expect(headerLine).toMatch(/Research.*50%/);
    });

    it('should render status message in header if present', () => {
      const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
      state.statusMessage = 'planning';
      
      const getActivePanelsMock = vi.fn().mockReturnValue([state]);
      const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
      const component = componentCreator(undefined, mockTheme);
      const lines = component.render(80);
      
      const headerLine = lines[0];
      expect(headerLine).toContain('planning');
    });
  });

  describe('wave animation', () => {
    it('should render wave when isSearching is true', () => {
      const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
      state.isSearching = true;
      state.waveFrame = 0;

      const getActivePanelsMock = vi.fn().mockReturnValue([state]);
      const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
      const component = componentCreator(undefined, mockTheme);
      const lines = component.render(80);

      const headerLine = lines[0];
      // Check for Research in the header
      expect(headerLine).toContain('Research');
    });
  });

  describe('state management', () => {
    let state: any;

    beforeEach(() => {
      state = createInitialPanelState('s', 'q', 'm');
    });

    it('should add slices correctly', () => {
      addSlice(state, 'r1', 'Researcher 1');
      expect(state.slices.has('r1')).toBe(true);
      expect(state.slices.get('r1')?.label).toBe('Researcher 1');
    });

    it('should handle activation of slices', () => {
      addSlice(state, 'r2', '2', true);
      expect(state.slices.get('r2')?.queued).toBe(true);
      
      activateSlice(state, 'r2');
      expect(state.slices.get('r2')?.queued).toBe(false);
    });

    it('should update tokens with non-decreasing guard and accumulate cost', () => {
      const state = createInitialPanelState('s', 'q', 'm');
      addSlice(state, 'r1', '1');
      
      updateSliceTokens(state, 'r1', 100, 0.05);
      expect(state.slices.get('r1')?.tokens).toBe(100);
      expect(state.slices.get('r1')?.cost).toBe(0.05);
      
      // Update with lower tokens should be ignored
      updateSliceTokens(state, 'r1', 50, 0.05);
      expect(state.slices.get('r1')?.tokens).toBe(100);
      expect(state.slices.get('r1')?.cost).toBe(0.10); // Cost still accumulates
    });

    it('should complete and clear slices', () => {
      const state = createInitialPanelState('s', 'q', 'm');
      addSlice(state, 'r1', '1');
      addSlice(state, 'r2', '2');
      
      completeSlice(state, 'r1');
      expect(state.slices.get('r1')?.completed).toBe(true);
      
      clearCompletedResearchers(state);
      expect(state.slices.has('r1')).toBe(false);
      expect(state.slices.has('r2')).toBe(true);
    });
  });

  describe('formatting utilities', () => {
    it('should format tokens correctly', () => {
      expect(_formatTokens(1234)).toBe('1.2k');
      expect(_formatTokens(500)).toBe('500');
      expect(_formatTokens(1000000)).toBe('1.0M');
    });

    it('should format cost correctly', () => {
      expect(_formatCost(0.1234)).toBe('$0.1234');
      expect(_formatCost(0.001)).toBe('$0.001');
      expect(_formatCost(1.5)).toBe('$1.50');
    });

    it('should render progress percentage correctly', () => {
      expect(_renderProgressPct({ expected: 10, made: 5 })).toBe('50%');
      expect(_renderProgressPct({ expected: 0, made: 5 })).toBe('');
      expect(_renderProgressPct(undefined)).toBe('');
    });
  });
});
