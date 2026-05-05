
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  createInitialPanelState, 
  addSlice, 
  activateSlice, 
  completeSlice,
  createMasterResearchPanel,
  type Theme
} from '../../../src/tui/research-panel.ts';

// Mock pi-tui
vi.mock('@mariozechner/pi-tui', () => ({
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
      expect(headerLine).toMatch(/Research.*planning/);
    });

    it('should not render progress percentage when progress is undefined', () => {
      const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');

      const getActivePanelsMock = vi.fn().mockReturnValue([state]);
      const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
      const component = componentCreator(undefined, mockTheme);
      const lines = component.render(80);

      const headerLine = lines[0];
      expect(headerLine).toMatch(/Research/);
      expect(headerLine).not.toMatch(/\d+%/);
    });
  });

  describe('render', () => {
    it('should output content when research is active', async () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        const getActivePanelsMock = vi.fn().mockReturnValue([state]);

        const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
        const component = componentCreator(undefined, mockTheme);
        const lines = component.render();

        expect(lines.length).toBeGreaterThan(0);
        expect(lines.some(l => l.includes('Research'))).toBe(true);
    });
  });

  describe('Wave Animation', () => {
    const mockTheme: Theme = {
      fg: (color: string, text: string) => {
        if (color === 'accent') {
          return `\x1b[38;5;39m${text}\x1b[39m`;
        }
        return text;
      },
    };

    describe('waveFrame state', () => {
      it('should have waveFrame property in panel state', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        expect(state.waveFrame).toBeUndefined();
      });

      it('should allow setting waveFrame', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        state.waveFrame = 0;
        expect(state.waveFrame).toBe(0);

        state.waveFrame = 10;
        expect(state.waveFrame).toBe(10);
      });
    });

    describe('wave rendering', () => {
      it('should render wave when isSearching and waveFrame are set', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        state.isSearching = true;
        state.waveFrame = 5;

        const getActivePanelsMock = vi.fn().mockReturnValue([state]);
        const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
        const component = componentCreator(undefined, mockTheme);
        const lines = component.render(80);

        const headerLine = lines[0];
        // Should contain wave characters (─) when animation is active
        expect(headerLine).toContain('─');
      });

      it('should render static fill when isSearching but no waveFrame', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        state.isSearching = true;
        // waveFrame is undefined

        const getActivePanelsMock = vi.fn().mockReturnValue([state]);
        const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
        const component = componentCreator(undefined, mockTheme);
        const lines = component.render(120); // Use wider width to ensure space for fill


        const headerLine = lines[0];
        // Should contain static pattern when waveFrame is not set
        // The pattern is ˍ＿, so we check that at least one of those characters appears
        // (not counting the decoration characters)
        const hasStaticPattern = headerLine.includes('ˍ') || headerLine.includes('＿');
        expect(hasStaticPattern).toBe(true);
      });

      it('should not render wave fill when not isSearching', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        state.isSearching = false;
        state.waveFrame = 5;

        const getActivePanelsMock = vi.fn().mockReturnValue([state]);
        const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
        const component = componentCreator(undefined, mockTheme);
        const lines = component.render(80);

        const headerLine = lines[0];
        // When not searching, we should not have the wave fill
        // The wave fill appears as a sequence of ANSI codes + ─ after ' Research'
        // So we check that after ' Research' there's no space + ANSI sequence + wave char
        const researchIndex = headerLine.indexOf(' Research');
        const afterResearch = headerLine.slice(researchIndex + 10);
        // Should not have the wave fill pattern (ANSI codes + ─)
        expect(afterResearch).not.toMatch(/\x1b\[38;5;\d+m─+/);
      });

      it('should handle narrow terminal width gracefully', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        state.isSearching = true;
        state.waveFrame = 5;

        const getActivePanelsMock = vi.fn().mockReturnValue([state]);
        const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
        const component = componentCreator(undefined, mockTheme);
        const lines = component.render(20);

        // Should not throw and should produce some output
        expect(lines.length).toBeGreaterThan(0);
      });

      it('should increment wave frame correctly', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        state.waveFrame = 0;

        // Simulate multiple animation frames
        for (let i = 0; i < 10; i++) {
          state.waveFrame = (state.waveFrame ?? 0) + 1;
        }

        expect(state.waveFrame).toBe(10);
      });
    });
  });
});

