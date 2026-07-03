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

// Mock session-state to return SteeringMessage objects
vi.mock('../../../src/orchestration/session-state.ts', () => ({
  getSteeringMessages: vi.fn().mockReturnValue([]),
  getAllTrackedSessions: vi.fn().mockReturnValue([]),
}));

describe('TUI Research Panel', () => {
  const mockTheme = {
    fg: (_color: string, text: string) => text,
  };

  describe('createInitialPanelState', () => {
    it('should create initial state with correct properties', () => {
      const state = createInitialPanelState('test-session-id', 'test-research-id', 'test-query', 'test-model');
      expect(state.query).toBe('test-query');
      expect(state.modelName).toBe('test-model');
    });
  });

  describe('progress tracking', () => {
    it('should render progress percentage when progress is set', () => {
      const state = createInitialPanelState('test-session-id', 'test-research-id', 'test-query', 'test-model');
      state.progress = { expected: 10, made: 5 };

      const getActivePanelsMock = vi.fn().mockReturnValue([state]);
      const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
      const component = componentCreator({} as any, mockTheme);
      const lines = component.render(80);

      const headerLine = lines[0];
      expect(headerLine).toMatch(/Research.*50%/);
    });

    it('should NOT render status message in header if present (removed per user preference)', () => {
      const state = createInitialPanelState('test-session-id', 'test-research-id', 'test-query', 'test-model');
      state.statusMessage = 'planning';
      
      const getActivePanelsMock = vi.fn().mockReturnValue([state]);
      const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
      const component = componentCreator({} as any, mockTheme);
      const lines = component.render(80);
      
      const headerLine = lines[0];
      expect(headerLine).not.toContain('planning');
    });
  });

  describe('coordinator column identified by slice id, not label text', () => {
    it('still shows a token count for a researcher whose label contains "planning"', () => {
      // Regression: the coordinator column (which hides its token count) used to be
      // detected by matching "planning"/"complexity" in the label. In quick mode the slice
      // id/label is the query itself, so a query like "urban planning news" wrongly blanked
      // that column. It is now keyed off the stable 'coord' slice id.
      const state = createInitialPanelState('s', 'r', 'q', 'm');
      addSlice(state, 'r1', 'researching: urban planning news');
      updateSliceTokens(state, 'r1', 5000, 0);
      const tok = _formatTokens(5000);
      const getActivePanelsMock = vi.fn().mockReturnValue([state]);
      const out = createMasterResearchPanel('pi-session', getActivePanelsMock)({} as any, mockTheme).render(80).join('\n');
      expect(out).toContain(tok);
    });

    it('blanks the token count only for the coordinator column (id "coord")', () => {
      const state = createInitialPanelState('s', 'r', 'q', 'm');
      addSlice(state, 'coord', 'coordinator');
      updateSliceTokens(state, 'coord', 5000, 0);
      const tok = _formatTokens(5000);
      const getActivePanelsMock = vi.fn().mockReturnValue([state]);
      const out = createMasterResearchPanel('pi-session', getActivePanelsMock)({} as any, mockTheme).render(80).join('\n');
      expect(out).not.toContain(tok);
    });
  });

  describe('wave animation', () => {
    const renderHeader = (isSearching: boolean): string => {
      const state = createInitialPanelState('test-session-id', 'test-research-id', 'test-query', 'test-model');
      state.isSearching = isSearching;
      state.waveFrame = 0;
      const getActivePanelsMock = vi.fn().mockReturnValue([state]);
      const component = createMasterResearchPanel('pi-session', getActivePanelsMock)({} as any, mockTheme);
      // Width 120 leaves room for the wave fill (mocked visibleWidth = 80).
      return component.render(120)[0] as string;
    };

    it('replaces the idle corner with a wave fill when isSearching is true', () => {
      const searchingHeader = renderHeader(true);
      const idleHeader = renderHeader(false);

      expect(searchingHeader).toContain('Research');
      expect(idleHeader).toContain('Research');
      // The idle header is capped with the "╶╮" corner; while searching, that
      // corner is replaced by the animated wave fill (── / ╼ glyphs, never ╮).
      expect(idleHeader).toContain('╮');
      expect(searchingHeader).not.toContain('╮');
      expect(searchingHeader).not.toBe(idleHeader);
    });
  });

  describe('state management', () => {
    let state: any;

    beforeEach(() => {
      state = createInitialPanelState('s', 'r', 'q', 'm');
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
      const state = createInitialPanelState('s', 'r', 'q', 'm');
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
      const state = createInitialPanelState('s', 'r', 'q', 'm');
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
      expect(_formatCost(0.1234)).toBe('$0.123');
      expect(_formatCost(0.001)).toBe('$0.0010');
      expect(_formatCost(1.5)).toBe('$1.50');
    });

    it('should render progress percentage correctly', () => {
      expect(_renderProgressPct({ expected: 10, made: 5 })).toBe('50%');
      expect(_renderProgressPct({ expected: 0, made: 5 })).toBe('');
      expect(_renderProgressPct(undefined)).toBe('');
    });
  });

  describe('steering message rendering', () => {
    it('should render queued steering messages with QUEUED prefix', async () => {
      const { getSteeringMessages } = await import('../../../src/orchestration/session-state.ts');
      vi.mocked(getSteeringMessages).mockReturnValue([
        { id: '1', text: 'Focus on X', status: 'queued', addedAt: Date.now(), consumedAt: null, poppedAt: null },
      ]);

      const state = createInitialPanelState('pi-session', 'research-id', 'query', 'model');
      state.steeringAcceptable = true;
      const getActivePanelsMock = vi.fn().mockReturnValue([state]);
      const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
      const component = componentCreator({} as any, mockTheme as Theme);
      const lines = component.render(80);

      const steeringLine = lines.find(l => l.includes('QUEUED RESEARCH STEERING'));
      expect(steeringLine).toBeDefined();
      expect(steeringLine).toContain('Focus on X');
      
      // Hint should include alt+p
      const hintLine = lines.find(l => l.includes('alt+p'));
      expect(hintLine).toBeDefined();
      expect(hintLine).toContain('cancel research');
    });

    it('should render active steering messages with RESEARCH STEERING prefix', async () => {
      const { getSteeringMessages } = await import('../../../src/orchestration/session-state.ts');
      vi.mocked(getSteeringMessages).mockReturnValue([
        { id: '1', text: 'Focus on Y', status: 'active', addedAt: Date.now(), consumedAt: Date.now(), poppedAt: null },
      ]);

      const state = createInitialPanelState('pi-session', 'research-id', 'query', 'model');
      state.steeringAcceptable = true;
      const getActivePanelsMock = vi.fn().mockReturnValue([state]);
      const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
      const component = componentCreator({} as any, mockTheme as Theme);
      const lines = component.render(80);

      const steeringLine = lines.find(l => l.includes('RESEARCH STEERING'));
      expect(steeringLine).toBeDefined();
      expect(steeringLine).toContain('Focus on Y');
      // Should NOT show QUEUED prefix
      expect(steeringLine).not.toContain('QUEUED');
      
      // Hint should NOT include alt+p when no queued messages
      const hintLine = lines.find(l => l.includes('alt+p'));
      expect(hintLine).toBeUndefined();
    });

    it('should show basic esc hint when no steering messages', async () => {
      const { getSteeringMessages } = await import('../../../src/orchestration/session-state.ts');
      vi.mocked(getSteeringMessages).mockReturnValue([]);

      const state = createInitialPanelState('pi-session', 'research-id', 'query', 'model');
      const getActivePanelsMock = vi.fn().mockReturnValue([state]);
      const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
      const component = componentCreator({} as any, mockTheme as Theme);
      const lines = component.render(80);

      const hintLine = lines.find(l => l.includes('esc to cancel research'));
      expect(hintLine).toBeDefined();
    });

    it('should not duplicate steering messages across multiple panels', async () => {
      const { getSteeringMessages } = await import('../../../src/orchestration/session-state.ts');
      vi.mocked(getSteeringMessages).mockReturnValue([
        { id: '1', text: 'Focus on X', status: 'queued', addedAt: Date.now(), consumedAt: null, poppedAt: null },
      ]);

      const state1 = createInitialPanelState('pi-session', 'research-1', 'query1', 'model');
      state1.steeringAcceptable = true;
      const state2 = createInitialPanelState('pi-session', 'research-2', 'query2', 'model');
      state2.steeringAcceptable = true;
      const getActivePanelsMock = vi.fn().mockReturnValue([state1, state2]);
      const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
      const component = componentCreator({} as any, mockTheme as Theme);
      const lines = component.render(80);

      // Steering message should appear only once, not twice
      const steeringLines = lines.filter(l => l.includes('Focus on X'));
      expect(steeringLines).toHaveLength(1);
    });
  });
});
