
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createInitialPanelState,
  addSlice,
  activateSlice,
  completeSlice,
  createMasterResearchPanel,
  _formatTokens,
  _renderProgressPct,
  _formatCost,
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
      it('should have waveFrame property undefined in initial state', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        expect(state.waveFrame).toBeUndefined();
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
        expect(headerLine).toContain('┄');
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
        const hasStaticPattern = headerLine.includes('─');
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
        expect(lines[0]).toContain('┄'); // Should have wave chars
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
        // With wave position mod (available + 10), frame 40 ensures wave moves past
        state.waveFrame = 40;
        const lines2 = component.render(120);
        expect(lines2.length).toBeGreaterThan(0);
        const colorsAfterFrame40 = [...(state.waveColors || [])];

        // Colors should be different after wave passed through
        expect(colorsAfterFrame40).not.toEqual(colorsAfterFrame0);

        // Colors should persist (not reset to a single uniform value)
        // The wave leaves behind varied color trail, so the array must contain at least 2 distinct values
        const distinctColors = new Set(colorsAfterFrame40);
        expect(distinctColors.size).toBeGreaterThan(1);
      });

      it('render should populate waveColors array when isSearching is active', () => {
        const state = createInitialPanelState('test-session-id', 'test-query', 'test-model');
        state.isSearching = true;
        state.waveFrame = 10;

        const getActivePanelsMock = vi.fn().mockReturnValue([state]);
        const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
        const component = componentCreator(undefined, mockTheme);

        component.render(120);

        expect(state.waveColors).toBeDefined();
        expect(state.waveColors?.length).toBeGreaterThan(0);
      });
    });
  });

  describe('slice management', () => {
    it('should add and activate slices', () => {
      const state = createInitialPanelState('s', 'q', 'm');
      addSlice(state, 'r1', '1');
      expect(state.slices.has('r1')).toBe(true);
      expect(state.slices.get('r1')?.queued).toBe(false);
      
      addSlice(state, 'r2', '2', true);
      expect(state.slices.get('r2')?.queued).toBe(true);
      
      activateSlice(state, 'r2');
      expect(state.slices.get('r2')?.queued).toBe(false);
    });

    it('should update tokens with non-decreasing guard and accumulate cost', () => {
      const { updateSliceTokens } = require('../../../src/tui/research-panel.ts');
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
      const { clearCompletedResearchers } = require('../../../src/tui/research-panel.ts');
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

  describe('layout and sorting', () => {
    it('should sort slices correctly: Planning -> Numerical -> Eval', () => {
      const state = createInitialPanelState('s', 'q', 'm');
      addSlice(state, 'eval', 'eval');
      addSlice(state, 'plan', 'planning');
      addSlice(state, 'r2', '2');
      addSlice(state, 'r1', '1');

      const getActivePanelsMock = vi.fn().mockReturnValue([state]);
      const componentCreator = createMasterResearchPanel('pi-session', getActivePanelsMock);
      const component = componentCreator(undefined, mockTheme);
      
      // We'll check the top border line to verify order
      const lines = component.render(100);
      const topBorder = lines[1]; // Index 0 is header, 1 is top border of block
      
      // The labels should appear in order: planning, 1, 2, eval
      const planIdx = topBorder.indexOf('planning');
      const r1Idx = topBorder.indexOf(' 1 ');
      const r2Idx = topBorder.indexOf(' 2 ');
      const evalIdx = topBorder.indexOf('╮'); // Eval box is decorative, header is different
      
      // Eval box top part is '─-─' or '─--─' and corner '╮'
      // We can check positions
      expect(planIdx).toBeLessThan(r1Idx);
      expect(r1Idx).toBeLessThan(r2Idx);
      // Eval is always last in sliceIds.sort
    });
  });

  describe('_formatTokens', () => {
    it('returns raw number below 1000', () => {
      expect(_formatTokens(0)).toBe('0');
      expect(_formatTokens(999)).toBe('999');
    });

    it('uses 1 decimal place for 1000-9999', () => {
      expect(_formatTokens(1000)).toBe('1.0k');
      expect(_formatTokens(1500)).toBe('1.5k');
      expect(_formatTokens(9999)).toBe('10.0k');
    });

    it('rounds to nearest k for 10k-999k', () => {
      expect(_formatTokens(10000)).toBe('10k');
      expect(_formatTokens(25400)).toBe('25k');
    });

    it('uses M suffix above 1 million', () => {
      expect(_formatTokens(1_000_000)).toBe('1.0M');
      expect(_formatTokens(2_500_000)).toBe('2.5M');
    });
  });

  describe('_renderProgressPct', () => {
    it('returns empty string for undefined', () => {
      expect(_renderProgressPct(undefined)).toBe('');
    });

    it('returns empty string when expected is 0', () => {
      expect(_renderProgressPct({ expected: 0, made: 0 })).toBe('');
    });

    it('rounds to nearest 10%', () => {
      expect(_renderProgressPct({ expected: 10, made: 5 })).toBe('50%');
      expect(_renderProgressPct({ expected: 10, made: 1 })).toBe('10%');
      expect(_renderProgressPct({ expected: 10, made: 3 })).toBe('30%');
    });

    it('clamps at 100%', () => {
      expect(_renderProgressPct({ expected: 10, made: 15 })).toBe('100%');
    });

    it('returns 100% at completion', () => {
      expect(_renderProgressPct({ expected: 5, made: 5 })).toBe('100%');
    });
  });

  describe('_formatCost', () => {
    it('formats zero as $0.00', () => {
      expect(_formatCost(0)).toBe('$0.00');
    });

    it('formats very small amount as <$0.01', () => {
      expect(_formatCost(0.000001)).toBe('<$0.01');
    });

    it('formats sub-dollar amounts with 4 decimal places', () => {
      expect(_formatCost(0.0023)).toBe('$0.0023');
    });

    it('formats dollar amounts with 2 decimal places', () => {
      expect(_formatCost(1.5)).toBe('$1.50');
      expect(_formatCost(99.99)).toBe('$99.99');
    });

    it('rounds large amounts to nearest dollar', () => {
      expect(_formatCost(150.7)).toBe('$151');
    });
  });
});

