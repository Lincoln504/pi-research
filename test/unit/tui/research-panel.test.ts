
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  createInitialPanelState, 
  addSlice, 
  activateSlice, 
  completeSlice,
  createMasterResearchPanel
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
});
