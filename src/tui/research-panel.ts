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
  slices: Map<string, SliceState>;
  modelName: string;
  hideSearxng?: boolean;
}

// Store timeouts per session ID to prevent cross-session conflicts
const sessionTimeouts = new Map<string, Set<NodeJS.Timeout>>();
// Store active flash timeouts per researcher ID within each session
const sessionResearcherTimeouts = new Map<string, Map<string, NodeJS.Timeout>>();

/**
 * Default duration for researcher cell flash indicators
 */
export const DEFAULT_FLASH_DURATION_MS = 80;

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
    }
    sessionTimeouts.delete(sessionId);
    
    // Clear researcher mapping for this session
    sessionResearcherTimeouts.delete(sessionId);
  } else {
    // Clear all timeouts across all sessions
    for (const timeouts of sessionTimeouts.values()) {
      for (const timeout of timeouts) {
        clearTimeout(timeout);
      }
      timeouts.clear();
    }
    sessionTimeouts.clear();
    sessionResearcherTimeouts.clear();
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
    
    // Explicitly clear any active flash when completing
    const researcherTimeouts = sessionResearcherTimeouts.get(state.sessionId);
    if (researcherTimeouts) {
      const timeout = researcherTimeouts.get(id);
      if (timeout) {
        clearTimeout(timeout);
        researcherTimeouts.delete(id);
        
        // Also remove from session set
        const timeouts = sessionTimeouts.get(state.sessionId);
        if (timeouts) {
          timeouts.delete(timeout);
        }
      }
    }
    slice.flash = null;
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
  
  // Ensure session map exists
  if (!sessionResearcherTimeouts.has(state.sessionId)) {
    sessionResearcherTimeouts.set(state.sessionId, new Map());
  }
  const researcherTimeouts = sessionResearcherTimeouts.get(state.sessionId)!;

  // Clear any existing timeout for THIS researcher in THIS session to prevent overlapping resets
  const existingTimeout = researcherTimeouts.get(researcherId);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
    researcherTimeouts.delete(researcherId);
    
    // Also remove from session set
    const timeouts = sessionTimeouts.get(state.sessionId);
    if (timeouts) {
      timeouts.delete(existingTimeout);
    }
  }

  slice.flash = color;
  onUpdate?.();

  const timeout = setTimeout(() => {
    slice.flash = null;
    onUpdate?.();
    
    // Cleanup
    researcherTimeouts.delete(researcherId);
    const timeouts = sessionTimeouts.get(state.sessionId);
    if (timeouts) {
      timeouts.delete(timeout);
    }
  }, durationMs);

  // Track the new timeout
  researcherTimeouts.set(researcherId, timeout);
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

    const component: any = {
      render(width: number): string[] {
        const LEFT_INNER = 7;
        const LEFT_BOX_W = LEFT_INNER + 2;
        const GAP = 1;

        // Use consistent total offset regardless of whether SearXNG box is shown
        // This ensures stacked panels align correctly vertically.
        const totalLeftOffset = LEFT_BOX_W + GAP;

        // Ensure we never exceed terminal width
        // availableForRight is the space remaining after left section
        const availableForRight = Math.max(1, width - totalLeftOffset);
        const rightBoxWidth = availableForRight;
        const rightInner = Math.max(1, rightBoxWidth - 2);

        // Prep left box raw parts (no colors yet)
        interface RawLeftBox {
          top: string;
          row1: string;
          row2: string;
          bottom: string;
          statusColor: 'success' | 'error' | 'muted';
        }

        let leftRaw: RawLeftBox | null = null;

        if (!state.hideSearxng && width >= totalLeftOffset + 10) {
          const status = state.searxngStatus;
          const statusText = getStatusText(status.state).padEnd(LEFT_INNER);
          const portStr = extractPort(status.url).padEnd(LEFT_INNER);
          
          leftRaw = {
            top: '┌' + '─'.repeat(LEFT_INNER),
            row1: '│' + statusText,
            row2: '│' + portStr,
            bottom: '└' + '─'.repeat(LEFT_INNER),
            statusColor: status.state === 'error' ? 'error' : (status.state === 'active' || status.state === 'starting_up') ? 'success' : 'muted',
          };
        }

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

        // Build right box raw parts
        const rightRawRows: string[][] = [[], [], [], []]; // top, tokens, cost, bottom
        const rightColors: Array<Array<'success' | 'error' | 'muted' | 'text' | 'accent'>> = [[], [], [], []];

        if (numVisible === 0) {
          const w = Math.max(1, rightInner);
          rightRawRows[0]!.push('─'.repeat(w) + '┐');
          rightRawRows[1]!.push(' '.repeat(w) + '│');
          rightRawRows[2]!.push(' '.repeat(w) + '│');
          rightRawRows[3]!.push('─'.repeat(w) + '┘');
          for(let i=0; i<4; i++) rightColors[i]!.push('accent');
        } else {
          for (let i = 0; i < totalCols; i++) {
            const sliceId = showIndicator && i === 0 ? null : (showIndicator ? visibleSliceIds[i - 1] : visibleSliceIds[i]);
            const slice = sliceId ? state.slices.get(sliceId) : null;
            const w = colW(i);
            const isLast = i === totalCols - 1;
            
            // Top Border with Label
            const labelStr = slice ? slice.label : `+${hiddenCount}`;
            // We need space for "┐ " and " ┌" (4 chars) plus label length
            // Using standard box drawing characters U+2510 (┐) and U+250C (┌) for perfect roof line alignment
            const cornerLabel = `┐ ${labelStr} ┌`;
            const canShowCornerLabel = w >= cornerLabel.length;
            const canShowBasicLabel = w >= labelStr.length + 2;
            
            let topPart;
            if (canShowCornerLabel) {
              const sideWidth = w - cornerLabel.length;
              const leftPad = Math.floor(sideWidth / 2);
              const rightPad = sideWidth - leftPad;
              topPart = '─'.repeat(leftPad) + cornerLabel + '─'.repeat(rightPad);
            } else if (canShowBasicLabel) {
              const sideWidth = w - labelStr.length;
              const leftPad = Math.floor(sideWidth / 2);
              const rightPad = sideWidth - leftPad;
              topPart = '─'.repeat(leftPad) + labelStr + '─'.repeat(rightPad);
            } else {
              topPart = '─'.repeat(w);
            }
            rightRawRows[0]!.push(topPart + (isLast ? '┐' : '┬'));
            rightColors[0]!.push('accent'); // Partition/Border is accent

            // Token Row
            const isPlanning = labelStr.includes('planning');
            const tokens = slice?.tokens || 0;
            const tokenStr = (isPlanning || tokens === 0) ? '' : formatTokens(tokens);
            const tokenDisplay = tokenStr.length > w ? tokenStr.slice(0, w) : tokenStr;
            const tokenPadded = tokenDisplay.padStart(Math.floor((w + tokenDisplay.length) / 2)).padEnd(w);
            rightRawRows[1]!.push(tokenPadded + '│');
            const flashColor = slice?.flash === 'green' ? 'success' : slice?.flash === 'red' ? 'error' : null;
            rightColors[1]!.push(flashColor || (slice?.completed ? 'muted' : 'text'));

            // Cost Row
            const cost = slice?.cost || 0;
            const costStr = (isPlanning || cost === 0) ? '' : formatCost(cost);
            const costDisplay = costStr.length > w ? costStr.slice(0, w) : costStr;
            const costPadded = costDisplay.padStart(Math.floor((w + costDisplay.length) / 2)).padEnd(w);
            rightRawRows[2]!.push(costPadded + '│');
            rightColors[2]!.push(flashColor || (slice?.completed ? 'muted' : 'text'));

            // Bottom Border
            rightRawRows[3]!.push('─'.repeat(w) + (isLast ? '┘' : '┴'));
            rightColors[3]!.push('accent');
          }
        }

        // Final Assembly
        const result: string[] = [];
        const jointChars = ['┬', '│', '│', '┴'];
        
        for (let rowIdx = 0; rowIdx < 4; rowIdx++) {
          let line = '';
          
          if (leftRaw) {
            // Left Box: Accent walls, colored content
            const leftBorderColor = 'accent';
            let leftContent: string;
            let leftContentColor: 'success' | 'error' | 'muted' | 'text' | 'accent';
            
            switch(rowIdx) {
              case 0: leftContent = leftRaw.top; leftContentColor = leftBorderColor; break;
              case 1: leftContent = leftRaw.row1; leftContentColor = leftRaw.statusColor; break;
              case 2: leftContent = leftRaw.row2; leftContentColor = leftBorderColor; break;
              case 3: leftContent = leftRaw.bottom; leftContentColor = leftBorderColor; break;
              default: leftContent = ''; leftContentColor = 'text';
            }
            
            // Color the leftmost wall character as accent, and the rest as content color
            line += theme.fg(leftBorderColor, leftContent.slice(0, 1));
            line += theme.fg(leftContentColor, leftContent.slice(1));
            
            // Add joint (always accent)
            line += theme.fg('accent', jointChars[rowIdx]!);
          } else {
            // Indent instead of left box
            line += ' '.repeat(totalLeftOffset);
          }
          
          // Right Box segments: Accent walls, colored content
          const rightRowParts = rightRawRows[rowIdx]!;
          const rightRowColors = rightColors[rowIdx]!;
          
          for (let colIdx = 0; colIdx < rightRowParts.length; colIdx++) {
            const part = rightRowParts[colIdx]!;
            const content = part.slice(0, -1);
            const wall = part.slice(-1);
            
            if (rowIdx === 0) {
              // Special handling for top border: Accent lines, Muted framed label text, Accent corners
              // Using standard box drawing characters U+2510 (┐) and U+250C (┌)
              const cornerStart = content.indexOf('┐');
              if (cornerStart !== -1) {
                const cornerEnd = content.lastIndexOf('┌') + 1;
                const before = content.slice(0, cornerStart);
                const cornerOpen = content.slice(cornerStart, cornerStart + 1);
                const labelText = content.slice(cornerStart + 1, cornerEnd - 1);
                const cornerClose = content.slice(cornerEnd - 1, cornerEnd);
                const after = content.slice(cornerEnd);
                
                line += theme.fg('accent', before);
                line += theme.fg('accent', cornerOpen);
                line += theme.fg('muted', labelText);
                line += theme.fg('accent', cornerClose);
                line += theme.fg('accent', after);
              } else {
                line += theme.fg('accent', content);
              }
            } else {
              // Standard row: Content color for inner part, Accent for wall
              // If researcher is completed, use muted color for all inner content
              const color = rightRowColors[colIdx]!;
              line += theme.fg(color, content);
            }
            
            // Trailing wall/partition character is always accent
            line += theme.fg('accent', wall);
          }
          
          result.push(line);
        }

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
      dispose(): void {
        clearAllFlashTimeouts(state.sessionId);
      }
    };
    return component;
  };
}
