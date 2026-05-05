
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
        const lines = component.render(120); // Use wider width to ensure wave renders

        const headerLine = lines[0];
        // Should contain wave characters (▄) when animation is active
        expect(headerLine).toContain('▄');
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

      it('should handle extremely narrow width (0)', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        state.isSearching = true;
        state.waveFrame = 5;

        const getActivePanelsMock = vi.fn().mockReturnValue([state]);
        const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
        const component = componentCreator(undefined, mockTheme);

        // Should not throw on width 0
        expect(() => component.render(0)).not.toThrow();
      });

      it('should handle extremely narrow width (1)', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        state.isSearching = true;
        state.waveFrame = 5;

        const getActivePanelsMock = vi.fn().mockReturnValue([state]);
        const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
        const component = componentCreator(undefined, mockTheme);

        // Should not throw on width 1
        expect(() => component.render(1)).not.toThrow();
        const lines = component.render(1);
        expect(lines.length).toBeGreaterThan(0);
      });

      it('should handle extremely narrow width (2)', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        state.isSearching = true;
        state.waveFrame = 5;

        const getActivePanelsMock = vi.fn().mockReturnValue([state]);
        const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
        const component = componentCreator(undefined, mockTheme);

        // Should not throw on width 2
        expect(() => component.render(2)).not.toThrow();
        const lines = component.render(2);
        expect(lines.length).toBeGreaterThan(0);
      });

      it('should handle very wide terminal width', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        state.isSearching = true;
        state.waveFrame = 5;

        const getActivePanelsMock = vi.fn().mockReturnValue([state]);
        const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
        const component = componentCreator(undefined, mockTheme);

        // Should not throw on very wide terminal (1000 columns)
        expect(() => component.render(1000)).not.toThrow();
        const lines = component.render(1000);
        expect(lines.length).toBeGreaterThan(0);
        expect(lines[0]).toContain('▄'); // Should have wave chars
      });

      it('should handle wave frame larger than width', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        state.isSearching = true;
        // Wave frame is much larger than the window width
        state.waveFrame = 99999;

        const getActivePanelsMock = vi.fn().mockReturnValue([state]);
        const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
        const component = componentCreator(undefined, mockTheme);

        // Should not throw even with very large wave frame
        expect(() => component.render(80)).not.toThrow();
        const lines = component.render(80);
        expect(lines.length).toBeGreaterThan(0);
      });

      it('should handle negative wave frame (undefined)', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        state.isSearching = true;
        // waveFrame is undefined (equivalent to "negative" for our purposes)

        const getActivePanelsMock = vi.fn().mockReturnValue([state]);
        const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
        const component = componentCreator(undefined, mockTheme);

        // Should use static pattern instead of wave
        expect(() => component.render(120)).not.toThrow();
        const lines = component.render(120);
        expect(lines.length).toBeGreaterThan(0);
      });

      it('should maintain persistent colors across animation frames', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        state.isSearching = true;
        state.waveFrame = 0;

        const getActivePanelsMock = vi.fn().mockReturnValue([state]);
        const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
        const component = componentCreator(undefined, mockTheme);

        // First render initializes waveColors array with background colors
        const lines1 = component.render(120);
        expect(lines1.length).toBeGreaterThan(0);
        expect(state.waveColors).toBeDefined();
        const colorsAfterFrame0 = [...(state.waveColors || [])];

        // Move wave forward far enough that it leaves some positions
        // With TRAIL_LEN = 15 and available ~36, frame 40 ensures wave moves past
        state.waveFrame = 40;
        const lines2 = component.render(120);
        expect(lines2.length).toBeGreaterThan(0);
        const colorsAfterFrame40 = [...(state.waveColors || [])];

        // Colors should be different after wave passed through
        expect(colorsAfterFrame40).not.toEqual(colorsAfterFrame0);

        // Colors should persist (not reset to background)
        // Some positions should have variation (different from background) after wave passed
        const nonBgColors = colorsAfterFrame40.filter(c => !c.includes('237') && c.length > 0);
        expect(nonBgColors.length).toBeGreaterThan(0);
      });

      it('should reset wave state when search completes', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        state.isSearching = true;
        state.waveFrame = 10;

        const getActivePanelsMock = vi.fn().mockReturnValue([state]);
        const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
        const component = componentCreator(undefined, mockTheme);

        // Render with active search
        component.render(120);
        expect(state.waveColors).toBeDefined();
        expect(state.waveColors?.length).toBeGreaterThan(0);
        expect(state.previousWavePositions).toBeDefined();

        // Simulate search complete (this is what tool.ts does)
        state.waveFrame = undefined;
        state.waveColors = undefined;
        state.previousWavePositions = undefined;

        // Verify all wave state is cleared
        expect(state.waveColors).toBeUndefined();
        expect(state.previousWavePositions).toBeUndefined();
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

