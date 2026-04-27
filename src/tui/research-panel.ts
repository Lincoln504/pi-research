/**
 * Research TUI Panel
 *
 * Streamlined multi-session research progress tracker.
 */

import { type Component, truncateToWidth } from '@mariozechner/pi-tui';

/**
 * Local Theme interface mirroring pi-tui
 */
export interface Theme {
  fg: (color: string, text: string) => string;
}

export interface SliceState {
  id: string;
  label: string;
  isActive: boolean;
  isComplete: boolean;
  tokens: number;
  cost: number;
  flashColor?: 'red' | 'green';
  flashEnd?: number;
}

export interface ResearchPanelState {
  researchId: string;
  query: string;
  modelId: string;
  totalTokens: number;
  totalCost: number;
  statusMessage?: string;
  progress?: {
    made: number;
    expected: number;
    extended: boolean;
  };
  slices: Map<string, SliceState>;
}

const flashTimeouts = new Map<string, any>();

export function createInitialPanelState(researchId: string, query: string, modelId: string): ResearchPanelState {
  return {
    researchId,
    query,
    modelId,
    totalTokens: 0,
    totalCost: 0,
    slices: new Map(),
  };
}

export function addSlice(state: ResearchPanelState, id: string, label: string, isActive = false) {
  state.slices.set(id, { id, label, isActive, isComplete: false, tokens: 0, cost: 0 });
}

export function activateSlice(state: ResearchPanelState, id: string) {
  const slice = state.slices.get(id);
  if (slice) slice.isActive = true;
}

export function completeSlice(state: ResearchPanelState, id: string) {
  const slice = state.slices.get(id);
  if (slice) {
    slice.isActive = false;
    slice.isComplete = true;
  }
}

export function removeSlice(state: ResearchPanelState, id: string) {
  state.slices.delete(id);
}

export function updateSliceTokens(state: ResearchPanelState, id: string, tokens: number, cost: number) {
  const slice = state.slices.get(id);
  if (slice) {
    slice.tokens = tokens;
    slice.cost = cost;
  }
}

export function flashSlice(state: ResearchPanelState, id: string, color: 'red' | 'green', duration: number, onUpdate: () => void) {
  const slice = state.slices.get(id);
  if (!slice) return;

  slice.flashColor = color;
  slice.flashEnd = Date.now() + duration;
  onUpdate();

  const timeoutId = `${state.researchId}-${id}`;
  if (flashTimeouts.has(timeoutId)) clearTimeout(flashTimeouts.get(timeoutId));

  const timeout = setTimeout(() => {
    slice.flashColor = undefined;
    slice.flashEnd = undefined;
    flashTimeouts.delete(timeoutId);
    onUpdate();
  }, duration);
  
  flashTimeouts.set(timeoutId, timeout);
}

export function clearAllFlashTimeouts(researchId: string) {
  for (const [key, timeout] of flashTimeouts.entries()) {
    if (key.startsWith(researchId)) {
      clearTimeout(timeout);
      flashTimeouts.delete(key);
    }
  }
}

export function createMasterResearchPanel(piSessionId: string, getActivePanelsFn?: (piSessionId: string) => ResearchPanelState[]) {
  return (theme: Theme): Component => {
    const component: Component = {
      render(width: number): string[] {
        // Use provided function or attempt dynamic require (only for runtime)
        let getPanels = getActivePanelsFn;
        if (!getPanels) {
           try {
             const { getPiActivePanels } = require('../utils/session-state.ts');
             getPanels = getPiActivePanels;
           } catch (_e) {
             return [];
           }
        }

        const activePanels: ResearchPanelState[] = getPanels ? getPanels(piSessionId) : [];

        if (!activePanels || activePanels.length === 0) return [];

        const divider = theme.fg('accent', '─'.repeat(width));
        const lines: string[] = [];

        activePanels.forEach((state, index) => {
          if (index > 0) lines.push('');

          lines.push(divider);
          lines.push(theme.fg('text', ` 🔎 RESEARCH: ${state.query} `));
          lines.push(theme.fg('muted', `    Model: ${state.modelId} | Tokens: ${state.totalTokens}`));
          lines.push(divider);

          if (state.statusMessage) {
            lines.push(theme.fg('info', ` > ${state.statusMessage}`));
          }

          if (state.progress) {
            const percent = Math.min(100, Math.floor((state.progress.made / state.progress.expected) * 100));
            const barWidth = Math.floor((width - 10) * (percent / 100));
            const bar = theme.fg('success', '█'.repeat(barWidth)) + theme.fg('muted', '░'.repeat(width - 10 - barWidth));
            lines.push(` [${bar}] ${percent}%`);
          }

          const slices = Array.from(state.slices.values());
          if (slices.length > 0) {
            lines.push('');
            slices.forEach(s => {
              let label = s.label;
              if (s.flashColor === 'red') label = theme.fg('error', label);
              else if (s.flashColor === 'green') label = theme.fg('success', label);
              else if (s.isActive) label = theme.fg('info', label);
              else if (s.isComplete) label = theme.fg('muted', label);

              lines.push(`  ${s.isActive ? '▶' : s.isComplete ? '✓' : '○'} ${label}`);
            });
          }
        });

        return lines.map(l => truncateToWidth(l, width));
      },
      invalidate(): void {}
    };
    return component;
  };
}
