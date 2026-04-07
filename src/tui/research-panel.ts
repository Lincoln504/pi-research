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
  tokens?: number; // Tokens for this specific agent
  cost?: number;   // Cost for this specific agent
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
 * Update researcher tokens and cost (accumulates)
 */
export function updateSliceTokens(state: ResearchPanelState, id: string, tokens: number, cost: number): void {
  const slice = state.slices.get(id);
  if (slice) {
    slice.tokens = (slice.tokens || 0) + tokens;
    slice.cost = (slice.cost || 0) + cost;
  }
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

function formatCost(cost: number): string {
  if (cost < 0.0001) return '$0.00';
  if (cost < 1) return `$${cost.toFixed(4)}`;
  if (cost < 100) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(0)}`;
}

function truncateMiddle(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  if (maxLen <= 3) return str.slice(0, maxLen);
  const keep = maxLen - 1;
  return str.slice(0, Math.floor(keep / 2)) + '…' + str.slice(-Math.ceil(keep / 2));
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

        // Ensure we never exceed terminal width
        const availableForRight = Math.max(1, width - totalLeftOffset);
        const rightInner = Math.max(1, availableForRight - 2);

        // Prep left box lines if not hidden
        let leftLines: string[];
        if (!state.hideSearxng && width >= totalLeftOffset + 10) {
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

        // Get visible slices (non-queued)
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

        // Calculate column widths for the right section
        const dividers = totalCols - 1;
        const contentTotal = Math.max(0, rightInner - dividers);
        const colBase = Math.floor(contentTotal / totalCols);
        const extra = contentTotal % totalCols;
        const colW = (i: number) => Math.max(0, colBase + (i < extra ? 1 : 0));

        // Minimum width needed per box: 3 (token) + 1 newline + 3 (cost) + 1 newline + 1 (label) = 8
        // But we need at least 1 char for content
        const MIN_BOX_WIDTH = 5;

        // Check if boxes are wide enough for the new layout
        const minColW = Math.min(...Array.from({ length: totalCols }, (_, i) => colW(i)));
        const canShowDetails = minColW >= MIN_BOX_WIDTH && numVisible > 0;

        if (numVisible === 0) {
          // Empty state - show placeholder
          const rTop = theme.fg('accent', '┌' + '─'.repeat(Math.max(1, rightInner)) + '┐');
          const rEmpty = theme.fg('accent', '│') + ' '.repeat(Math.max(1, rightInner)) + theme.fg('accent', '│');
          const rBottom = theme.fg('accent', '└' + '─'.repeat(Math.max(1, rightInner)) + '┘');
          
          return [
            leftLines[0] + ' ' + rTop,
            leftLines[1] + ' ' + rEmpty,
            leftLines[2] + ' ' + rEmpty,
            leftLines[3] + ' ' + rEmpty,
            leftLines[4] + ' ' + rBottom,
          ];
        }

        // Build each box with its own header (token count + cost) and label
        const buildBox = (sliceId: string | null, index: number): string[] => {
          const w = colW(index);
          const lines: string[] = [];

          if (sliceId === null) {
            // Indicator box for hidden slices
            const cell = `+${hiddenCount}`.padEnd(w);
            return [
              theme.fg('accent', '┌' + '─'.repeat(w) + '┐'),
              theme.fg('muted', '│' + cell + '│'),
              theme.fg('accent', '└' + '─'.repeat(w) + '┘'),
            ];
          }

          const slice = state.slices.get(sliceId)!;
          const tokens = slice.tokens || 0;
          const cost = slice.cost || 0;
          const tokenStr = formatTokens(tokens);
          const costStr = formatCost(cost);
          const labelStr = slice.completed ? `✓${slice.label}` : slice.label;

          // Determine colors based on state
          const getCellColor = () => {
            if (slice.flash === 'green') return 'success';
            if (slice.flash === 'red') return 'error';
            if (slice.completed) return 'muted';
            return 'text';
          };

          if (canShowDetails) {
            // Show full details: token count, cost, and label
            // Format: [token count] on top line, [cost] on second line, [label] on third line
            
            const tokenDisplay = truncateMiddle(tokenStr, Math.max(1, w - 2));
            const tokenPadded = tokenDisplay.padStart(Math.ceil((w) / 2)).padEnd(w);
            
            const costDisplay = truncateMiddle(costStr, Math.max(1, w - 2));
            const costPadded = costDisplay.padStart(Math.ceil((w) / 2)).padEnd(w);
            
            const labelDisplay = truncateMiddle(labelStr, Math.max(1, w - 2));
            const labelPadded = labelDisplay.padStart(Math.ceil((w) / 2)).padEnd(w);
            
            const color = getCellColor();
            
            lines.push(theme.fg('accent', '┌' + '─'.repeat(w) + '┐'));
            lines.push(theme.fg(color, '│' + tokenPadded + '│'));
            lines.push(theme.fg(color, '│' + costPadded + '│'));
            lines.push(theme.fg(color, '│' + labelPadded + '│'));
            lines.push(theme.fg('accent', '└' + '─'.repeat(w) + '┘'));
          } else {
            // Not enough space - just show label
            const labelDisplay = truncateMiddle(labelStr, Math.max(1, w - 2));
            const labelPadded = labelDisplay.padStart(Math.ceil((w) / 2)).padEnd(w);
            const color = getCellColor();
            
            lines.push(theme.fg('accent', '┌' + '─'.repeat(w) + '┐'));
            lines.push(theme.fg(color, '│' + labelPadded + '│'));
            lines.push(theme.fg('accent', '└' + '─'.repeat(w) + '┘'));
          }

          return lines;
        };

        // Build the right section - each slice is its own box with headers
        const rightLines: string[] = [];
        
        if (canShowDetails) {
          // With details: 5 lines per slice box (top, token, cost, label, bottom)
          // Top border
          const topParts: string[] = [];
          for (let i = 0; i < totalCols; i++) {
            const sliceId = showIndicator && i === 0 ? null : (showIndicator ? visibleSliceIds[i - 1] : visibleSliceIds[i]);
            const w = colW(i);
            if (i === 0) {
              topParts.push(theme.fg('accent', '┌' + '─'.repeat(w)));
            } else {
              topParts.push(theme.fg('accent', '┬' + '─'.repeat(w)));
            }
          }
          rightLines.push(theme.fg('accent', '│') + topParts.join('') + theme.fg('accent', '┐'));

          // Token rows
          const tokenRows: string[] = [];
          for (let i = 0; i < totalCols; i++) {
            const sliceId = showIndicator && i === 0 ? null : (showIndicator ? visibleSliceIds[i - 1] : visibleSliceIds[i]);
            const slice = sliceId ? state.slices.get(sliceId) : null;
            const tokens = slice?.tokens || 0;
            const tokenStr = formatTokens(tokens);
            const w = colW(i);
            const tokenDisplay = truncateMiddle(tokenStr, Math.max(1, w - 2));
            const tokenPadded = tokenDisplay.padStart(Math.ceil((w) / 2)).padEnd(w);
            const color = sliceId ? (slice.completed ? 'muted' : 'text') : 'muted';
            
            if (i === 0) {
              tokenRows.push(theme.fg(color, '│' + tokenPadded));
            } else {
              tokenRows.push(theme.fg('accent', '│') + theme.fg(color, tokenPadded));
            }
          }
          rightLines.push(tokenRows.join('') + theme.fg('accent', '│'));

          // Cost rows
          const costRows: string[] = [];
          for (let i = 0; i < totalCols; i++) {
            const sliceId = showIndicator && i === 0 ? null : (showIndicator ? visibleSliceIds[i - 1] : visibleSliceIds[i]);
            const slice = sliceId ? state.slices.get(sliceId) : null;
            const cost = slice?.cost || 0;
            const costStr = formatCost(cost);
            const w = colW(i);
            const costDisplay = truncateMiddle(costStr, Math.max(1, w - 2));
            const costPadded = costDisplay.padStart(Math.ceil((w) / 2)).padEnd(w);
            const color = sliceId ? (slice.completed ? 'muted' : 'text') : 'muted';
            
            if (i === 0) {
              costRows.push(theme.fg(color, '│' + costPadded));
            } else {
              costRows.push(theme.fg('accent', '│') + theme.fg(color, costPadded));
            }
          }
          rightLines.push(costRows.join('') + theme.fg('accent', '│'));

          // Label rows
          const labelRows: string[] = [];
          for (let i = 0; i < totalCols; i++) {
            const sliceId = showIndicator && i === 0 ? null : (showIndicator ? visibleSliceIds[i - 1] : visibleSliceIds[i]);
            const slice = sliceId ? state.slices.get(sliceId) : null;
            const labelStr = slice ? (slice.completed ? `✓${slice.label}` : slice.label) : `+${hiddenCount}`;
            const w = colW(i);
            const labelDisplay = truncateMiddle(labelStr, Math.max(1, w - 2));
            const labelPadded = labelDisplay.padStart(Math.ceil((w) / 2)).padEnd(w);
            const color = slice?.flash === 'green' ? 'success' : slice?.flash === 'red' ? 'error' : (slice?.completed ? 'muted' : 'text');
            
            if (i === 0) {
              labelRows.push(theme.fg(color, '│' + labelPadded));
            } else {
              labelRows.push(theme.fg('accent', '│') + theme.fg(color, labelPadded));
            }
          }
          rightLines.push(labelRows.join('') + theme.fg('accent', '│'));

          // Bottom border
          const bottomParts: string[] = [];
          for (let i = 0; i < totalCols; i++) {
            const w = colW(i);
            if (i === 0) {
              bottomParts.push(theme.fg('accent', '└' + '─'.repeat(w)));
            } else {
              bottomParts.push(theme.fg('accent', '┴' + '─'.repeat(w)));
            }
          }
          rightLines.push(bottomParts.join('') + theme.fg('accent', '┘'));

        } else {
          // Compact mode - just labels in boxes
          const topParts: string[] = [];
          const contentParts: string[] = [];
          const bottomParts: string[] = [];
          
          for (let i = 0; i < totalCols; i++) {
            const sliceId = showIndicator && i === 0 ? null : (showIndicator ? visibleSliceIds[i - 1] : visibleSliceIds[i]);
            const slice = sliceId ? state.slices.get(sliceId) : null;
            const w = colW(i);
            const labelStr = slice ? (slice.completed ? `✓${slice.label}` : slice.label) : `+${hiddenCount}`;
            const labelDisplay = truncateMiddle(labelStr, Math.max(1, w - 2));
            const labelPadded = labelDisplay.padStart(Math.ceil((w) / 2)).padEnd(w);
            const color = slice?.flash === 'green' ? 'success' : slice?.flash === 'red' ? 'error' : (slice?.completed ? 'muted' : 'text');
            
            if (i === 0) {
              topParts.push(theme.fg('accent', '┌' + '─'.repeat(w)));
              contentParts.push(theme.fg(color, '│' + labelPadded));
              bottomParts.push(theme.fg('accent', '└' + '─'.repeat(w)));
            } else {
              topParts.push(theme.fg('accent', '┬' + '─'.repeat(w)));
              contentParts.push(theme.fg('accent', '│') + theme.fg(color, labelPadded));
              bottomParts.push(theme.fg('accent', '┴' + '─'.repeat(w)));
            }
          }
          
          rightLines.push(theme.fg('accent', '│') + topParts.join('') + theme.fg('accent', '┐'));
          rightLines.push(contentParts.join('') + theme.fg('accent', '│'));
          rightLines.push(bottomParts.join('') + theme.fg('accent', '┘'));
        }

        // Ensure we have 5 lines total for alignment with left box
        while (rightLines.length < 5) {
          if (canShowDetails && rightLines.length < 5) {
            rightLines.unshift('');
          } else if (!canShowDetails && rightLines.length < 3) {
            rightLines.unshift('');
          }
        }
        // If we have more than 5 lines, trim (shouldn't happen)
        const trimmedRightLines = rightLines.slice(0, 5);

        const result = [
          leftLines[0] + ' ' + trimmedRightLines[0],
          leftLines[1] + ' ' + trimmedRightLines[1],
          leftLines[2] + ' ' + trimmedRightLines[2],
          leftLines[3] + ' ' + trimmedRightLines[3],
          leftLines[4] + ' ' + trimmedRightLines[4],
        ];

        // Safety: truncate any line that exceeds terminal width
        return result.map(line => {
          const w = visibleWidth(line);
          if (w > width) {
            return truncateToWidth(line, Math.max(3, width - 1));
          }
          return line;
        });
      },
      invalidate(): void {
        localTui?.requestRender?.();
      },
    };
    return component;
  };
}
