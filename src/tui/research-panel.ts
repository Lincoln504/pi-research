/**
 * Research TUI Panel
 *
 * Side-by-side layout for SearXNG status and researcher progress.
 */

import { type Component, visibleWidth, truncateToWidth } from '@mariozechner/pi-tui';
import type { Theme } from '@mariozechner/pi-coding-agent';
import type { SearxngStatus } from '../infrastructure/searxng-lifecycle.ts';

export interface SliceState {
  id: string;
  label: string; // Displayed label: "1", "2", "3", etc.
  completed: boolean;
  queued: boolean;
  flash: 'green' | 'red' | null;
}

export interface ResearchPanelState {
  sessionId: string;
  searxngStatus: SearxngStatus;
  totalTokens: number;
  activeConnections: number;
  slices: Map<string, SliceState>;
  modelName: string;
  hideSearxng?: boolean;
}

// Store timeouts per session ID to prevent cross-session conflicts
const sessionTimeouts = new Map<string, Set<NodeJS.Timeout>>();

/**
 * Default duration for researcher cell flash indicators
 */
export const DEFAULT_FLASH_DURATION_MS = 1000;

/**
 * Clear all active flash timeouts for a specific session
 */
export function clearAllFlashTimeouts(sessionId?: string): void {
  if (sessionId) {
    // Clear timeouts for specific session
    const timeouts = sessionTimeouts.get(sessionId);
    if (timeouts) {
      for (const timeout of timeouts) {
        clearTimeout(timeout);
      }
      timeouts.clear();
      sessionTimeouts.delete(sessionId);
    }
  } else {
    // Clear all timeouts across all sessions
    for (const timeouts of sessionTimeouts.values()) {
      for (const timeout of timeouts) {
        clearTimeout(timeout);
      }
      timeouts.clear();
    }
    sessionTimeouts.clear();
  }
}

/**
 * Add a new researcher column
 */
export function addSlice(state: ResearchPanelState, id: string, label: string, queued: boolean = false): void {
  state.slices.set(id, { id, label, completed: false, queued, flash: null });
}

/**
 * Remove a researcher column
 */
export function removeSlice(state: ResearchPanelState, id: string): void {
  state.slices.delete(id);
}

/**
 * Mark researcher as active (start from queued state)
 */
export function activateSlice(state: ResearchPanelState, id: string): void {
  const slice = state.slices.get(id);
  if (slice) slice.queued = false;
}

/**
 * Mark researcher as complete
 */
export function completeSlice(state: ResearchPanelState, id: string): void {
  const slice = state.slices.get(id);
  if (slice) {
    slice.completed = true;
    slice.queued = false;
  }
}

/**
 * Flash a researcher green or red
 */
export function flashSlice(
  state: ResearchPanelState,
  researcherId: string,
  color: 'green' | 'red',
  durationMs: number = DEFAULT_FLASH_DURATION_MS,
  onUpdate?: () => void
): void {
  const slice = state.slices.get(researcherId);
  if (!slice || slice.completed || slice.queued) return;
  
  slice.flash = color;
  onUpdate?.();

  const timeout = setTimeout(() => {
    slice.flash = null;
    onUpdate?.();
    // Remove timeout from session-specific set
    const timeouts = sessionTimeouts.get(state.sessionId);
    if (timeouts) {
      timeouts.delete(timeout);
    }
  }, durationMs);

  // Add timeout to session-specific set
  if (!sessionTimeouts.has(state.sessionId)) {
    sessionTimeouts.set(state.sessionId, new Set());
  }
  sessionTimeouts.get(state.sessionId)!.add(timeout);
}

/**
 * Create initial panel state
 */
export function createInitialPanelState(sessionId: string, searxngStatus: SearxngStatus, modelName: string): ResearchPanelState {
  return {
    sessionId,
    searxngStatus,
    totalTokens: 0,
    activeConnections: 0,
    slices: new Map(),
    modelName,
  };
}

// Remove global capturedTui - each component should manage its own references
// This prevents stale references when multiple sessions run

function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function getStatusText(state: string): string {
  switch (state) {
    case 'starting_up': return 'SearXNG';
    case 'active':      return 'SearXNG';
    case 'inactive':    return 'Offline';
    case 'error':       return 'Error';
    default:            return '?';
  }
}

function extractPort(url: string): string {
  if (!url) return '';
  const m = url.match(/:(\d+)(?:\/|$)/);
  return m ? `:${m[1]}` : '';
}

/**
 * Create research panel component
 * Each component instance maintains its own state and tui reference
 */
export function createResearchPanel(
  state: ResearchPanelState
): (tui: unknown, theme: Theme) => Component & { dispose?(): void } {
  return (tui: unknown, theme: Theme) => {
    // Store tui reference locally for this component instance only
    const localTui = tui as { requestRender?(): void };

    const component: Component = {
      render(width: number): string[] {
        const LEFT_INNER = 7;
        const LEFT_BOX_W = LEFT_INNER + 2;
        const GAP = 1;
        
        // Use consistent total offset regardless of whether SearXNG box is shown
        // This ensures stacked panels align correctly vertically.
        const totalLeftOffset = LEFT_BOX_W + GAP;
        
        // If width is very narrow, we might need to prioritize the right box
        const MIN_RIGHT_WIDTH = 20;
        const rightBoxWidth = Math.max(MIN_RIGHT_WIDTH, width - totalLeftOffset);
        const rightInner = Math.max(1, rightBoxWidth - 2);

        // Prep left box lines if not hidden
        let leftLines: string[];
        if (!state.hideSearxng && width >= totalLeftOffset + MIN_RIGHT_WIDTH) {
          const status = state.searxngStatus;
          const statusText = getStatusText(status.state);
          const portStr = extractPort(status.url);
          const statusColor = status.state === 'error' ? 'error' : (status.state === 'active' || status.state === 'starting_up') ? 'success' : 'muted';

          const leftRow1 = theme.fg('accent', '│') + theme.fg(statusColor, statusText) + theme.fg('accent', ' '.repeat(Math.max(0, LEFT_INNER - statusText.length)) + '│');
          const leftRow2 = theme.fg('accent', '│') + theme.fg('accent', portStr) + theme.fg('accent', ' '.repeat(Math.max(0, LEFT_INNER - portStr.length)) + '│');
          const connStr = state.activeConnections.toString();
          const connColor = state.activeConnections > 0 ? 'text' : 'muted';
          const leftRow3 = theme.fg('accent', '│') + theme.fg(connColor, connStr) + theme.fg('accent', ' '.repeat(Math.max(0, LEFT_INNER - connStr.length)) + '│');

          const leftBorder = theme.fg('accent', '┌' + '─'.repeat(LEFT_INNER) + '┐');
          const leftBottom = theme.fg('accent', '└' + '─'.repeat(LEFT_INNER) + '┘');
          leftLines = [leftBorder, leftRow1, leftRow2, leftRow3, leftBottom];
        } else {
          // If SearXNG is hidden OR terminal is too narrow, just indent
          leftLines = Array(5).fill(' '.repeat(totalLeftOffset));
        }

        let titleText = ` Research | ${state.modelName}  ${formatTokens(state.totalTokens)} `;
        const titlePrefixDashes = 2;
        const maxTitleWidth = rightInner - titlePrefixDashes;
        if (visibleWidth(titleText) > maxTitleWidth) {
          titleText = truncateToWidth(titleText, Math.max(3, maxTitleWidth - 1)) + ' ';
        }

        const titleFillDashes = Math.max(0, rightInner - titlePrefixDashes - visibleWidth(titleText));
        const rTopWithTitle = theme.fg('accent', '┌' + '─'.repeat(titlePrefixDashes)) + theme.fg('muted', titleText) + theme.fg('accent', '─'.repeat(titleFillDashes) + '┐');

        const sliceIds = Array.from(state.slices.keys()).filter(id => !state.slices.get(id)!.queued);
        const numSlices = sliceIds.length;
        const MAX_VISIBLE_SLICES = 6;
        let visibleSliceIds = sliceIds;
        let showIndicator = false;
        let hiddenCount = 0;
        if (numSlices > MAX_VISIBLE_SLICES) {
          visibleSliceIds = sliceIds.slice(numSlices - MAX_VISIBLE_SLICES);
          hiddenCount = numSlices - MAX_VISIBLE_SLICES;
          showIndicator = true;
        }
        const numVisible = showIndicator ? MAX_VISIBLE_SLICES : numSlices;
        const totalCols = showIndicator ? numVisible + 1 : numVisible;

        if (numVisible === 0) {
          const rEmpty = theme.fg('accent', '│') + ' '.repeat(Math.max(1, rightInner)) + theme.fg('accent', '│');
          const rBottom = theme.fg('accent', '└' + '─'.repeat(Math.max(1, rightInner)) + '┘');
          
          return [
            leftLines[0] + ' ' + rTopWithTitle,
            leftLines[1] + ' ' + rEmpty,
            leftLines[2] + ' ' + rEmpty,
            leftLines[3] + ' ' + rEmpty,
            leftLines[4] + ' ' + rBottom,
          ];
        }

        const dividers = totalCols - 1;
        const contentTotal = Math.max(0, rightInner - dividers);
        const colBase = Math.floor(contentTotal / totalCols);
        const extra = contentTotal % totalCols;
        const colW = (i: number) => Math.max(0, colBase + (i < extra ? 1 : 0));

        const rawTopInner = Array.from({ length: totalCols }, (_, i) => '─'.repeat(colW(i)) + (i < totalCols - 1 ? '┬' : '')).join('');
        const skipChars = titlePrefixDashes + titleText.length;
        const rTop = theme.fg('accent', '┌' + '─'.repeat(titlePrefixDashes)) + theme.fg('muted', titleText) + theme.fg('accent', rawTopInner.slice(skipChars) + '┐');

        const rEmpty = theme.fg('accent', '│') + Array.from({ length: totalCols }, (_, i) => ' '.repeat(colW(i)) + (i < totalCols - 1 ? theme.fg('accent', '│') : '')).join('') + theme.fg('accent', '│');

        const cols = visibleSliceIds.map((id, i) => {
          const slice = state.slices.get(id)!;
          const w = colW(showIndicator ? i + 1 : i);
          const raw = slice.completed ? `✓${slice.label}` : slice.label;
          const content = raw.length > w ? raw.slice(0, w) : raw;
          const pL = Math.max(0, Math.floor((w - content.length) / 2));
          const pR = Math.max(0, w - content.length - pL);
          const cell = ' '.repeat(pL) + content + ' '.repeat(pR);
          const colored = slice.flash === 'green' ? theme.fg('success', cell) : slice.flash === 'red' ? theme.fg('error', cell) : theme.fg('text', cell);
          return colored + (i + (showIndicator ? 1 : 0) < totalCols - 1 ? theme.fg('accent', '│') : '');
        });

        if (showIndicator) {
          const w = colW(0);
          const cell = `+${hiddenCount}`.padStart(Math.ceil((w + 2) / 2)).padEnd(w);
          cols.unshift(theme.fg('muted', cell) + theme.fg('accent', '│'));
        }

        const rContent = theme.fg('accent', '│') + cols.join('') + theme.fg('accent', '│');
        const rBottom = theme.fg('accent', '└') + Array.from({ length: totalCols }, (_, i) => theme.fg('accent', '─'.repeat(colW(i)) + (i < totalCols - 1 ? '┴' : ''))).join('') + theme.fg('accent', '┘');

        const rightLines = [rTop, rEmpty, rContent, rEmpty, rBottom];

        return [
          leftLines[0] + ' ' + rightLines[0],
          leftLines[1] + ' ' + rightLines[1],
          leftLines[2] + ' ' + rightLines[2],
          leftLines[3] + ' ' + rightLines[3],
          leftLines[4] + ' ' + rightLines[4],
        ];
      },
      invalidate(): void {
        localTui?.requestRender?.();
      },
    };
    return component;
  };
}
