/**
 * Research TUI Panel
 *
 * Two-box layout for research status:
 * - Left box (9 cols): SearXNG status — line1: "SearXNG", line2: ":55732", line3: "12"
 * - Right box (fills remaining width): Up to 6 visible slice columns, consolidates with "+N" indicator on LEFT
 *
 * Layout (example, 5 slices):
 * ┌───────┐ ┌────┬────┬────┬────┬────┐
 * │SearXNG│ │    │    │    │    │    │
 * │:55732 │ │ 1  │ 2  │ 3  │ 4  │ 5  │
 * │   12  │ │    │    │    │    │    │
 * └───────┘ └────┴────┴────┴────┴────┘
 *
 * Consolidation (example, 8 slices, max 6 visible, +N on LEFT):
 * ┌───────┐ ┌────┬────┬────┬────┬────┬────┐
 * │SearXNG│ │    │    │    │    │    │    │
 * │:55732 │ │ 3  │ 4  │ 5  │ 6  │ 7  │ 8  │
 * │   12  │ │    │    │    │    │    │    │
 * └───────┘ └────┴────┴────┴────┴────┴────┘
 * (Note: +2 would show in left column area indicating slices 1-2 hidden)
 */

import { type Component } from '@mariozechner/pi-tui';
import type { Theme } from '@mariozechner/pi-coding-agent';
import type { SearxngStatus } from '../searxng-lifecycle.js';

export interface SliceState {
  id: string;
  label: string; // Displayed label: "1:1", "1:2", "2:1", "3:1", etc. (X = slice number, Y = iteration number)
  completed: boolean;
  queued: boolean; // True if waiting in backlog (not yet started)
  flash: 'green' | 'red' | null;
}

export interface ResearchPanelState {
  searxngStatus: SearxngStatus;
  totalTokens: number;
  activeConnections: number;
  slices: Map<string, SliceState>; // slice ID → state
  modelName: string;
}

const activeTimeouts = new Set<NodeJS.Timeout>();

export function clearAllFlashTimeouts(): void {
  for (const timeout of activeTimeouts) {
    clearTimeout(timeout);
  }
  activeTimeouts.clear();
}

/** Add a new slice column */
export function addSlice(state: ResearchPanelState, sliceId: string, label: string, queued: boolean = false): void {
  state.slices.set(sliceId, { id: sliceId, label, completed: false, queued, flash: null });
}

/** Mark slice as complete — shows ✓ prefix, no flash */
export function completeSlice(state: ResearchPanelState, sliceId: string): void {
  const slice = state.slices.get(sliceId);
  if (slice) {
    slice.completed = true;
    slice.queued = false;
  }
}

/** Flash a slice green or red for durationMs, independent of completion state */
export function flashSlice(
  state: ResearchPanelState,
  sliceId: string,
  color: 'green' | 'red',
  durationMs: number = 1000,
  onUpdate?: () => void
): void {
  const slice = state.slices.get(sliceId);
  if (!slice || slice.completed || slice.queued) return;  // Guard: don't flash completed or queued slices
  slice.flash = color;
  onUpdate?.();
  const timeout = setTimeout(() => {
    slice.flash = null;
    onUpdate?.();
    activeTimeouts.delete(timeout);
  }, durationMs);
  activeTimeouts.add(timeout);
}

/** Mark slice as active (start from queued state) */
export function activateSlice(state: ResearchPanelState, sliceId: string): void {
  const slice = state.slices.get(sliceId);
  if (slice) {
    slice.queued = false;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

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

/** Extract ":PORT" from a URL string, e.g. "http://localhost:55732" → ":55732" */
function extractPort(url: string): string {
  if (!url) return '';
  const m = url.match(/:(\d+)(?:\/|$)/);
  return m ? `:${m[1]}` : '';
}

// ─── component factory ─────────────────────────────────────────────────────────

/**
 * Create research panel component.
 * Left box is exactly LEFT_BOX_W columns wide (borders included).
 * Right box fills rest.
 */
export function createResearchPanel(
  state: ResearchPanelState
): (tui: unknown, theme: Theme) => Component & { dispose?(): void } {
  return (_tui: unknown, theme: Theme) => {
    const component: Component = {
      render(width: number): string[] {
        // ── Left box geometry ──────────────────────────────────────────────────
        // Inner content is 7 chars: 3 lines of content
        // Line 1: "SearXNG" (7 chars)
        // Line 2: ":55732" (6 chars, padded to 7)
        // Line 3: "12" (connection count, padded to 7)
        const LEFT_INNER = 7;
        const LEFT_BOX_W = LEFT_INNER + 2; // 9 (borders, ~20% thinner)
        const GAP = 1;

        // ── Right box geometry ────────────────────────────────────────────────
        const rightBoxWidth = Math.max(20, width - LEFT_BOX_W - GAP);
        const rightInner = rightBoxWidth - 2; // inside outer │ … │

        // ── Left box content ──────────────────────────────────────────────────
        const status = state.searxngStatus;
        const statusText = getStatusText(status.state);
        const portStr = extractPort(status.url);
        const statusColor = status.state === 'error'
          ? 'error'
          : (status.state === 'active' || status.state === 'starting_up')
            ? 'success'
            : 'muted';

        // Line 1: "SearXNG" or "Offline" or "Error"
        const pad1 = LEFT_INNER - statusText.length;
        const leftRow1 = `│${theme.fg(statusColor, statusText)}${' '.repeat(Math.max(0, pad1))}│`;

        // Line 2: ":55732" (port)
        const pad2 = LEFT_INNER - portStr.length;
        const leftRow2 = `│${theme.fg('accent', portStr)}${' '.repeat(Math.max(0, pad2))}│`;

        // Line 3: connection count (no "conn" label)
        const connStr = state.activeConnections.toString();
        const connColor = state.activeConnections > 0 ? 'text' : 'muted';
        const pad3 = LEFT_INNER - connStr.length;
        const leftRow3 = `│${theme.fg(connColor, connStr)}${' '.repeat(Math.max(0, pad3))}│`;

        const leftBorder = `┌${'─'.repeat(LEFT_INNER)}┐`;
        const leftBottom = `└${'─'.repeat(LEFT_INNER)}┘`;

        // ── Right box top border with title ──────────────────────────────────
        // Format: ┌── Research | glm-4.7  42.3k ──────┐
        const titleText = ` Research | ${state.modelName}  ${formatTokens(state.totalTokens)} `;
        const titlePrefixDashes = 2;
        const titleFillDashes = Math.max(0, rightInner - titlePrefixDashes - titleText.length);
        const rTopWithTitle =
          '┌' + '─'.repeat(titlePrefixDashes) +
          theme.fg('muted', titleText) +
          theme.fg('accent', '─'.repeat(titleFillDashes) + '┐');

        // ── Right box: 0-slice empty state ────────────────────────────────────
        // IMPORTANT: Only show non-queued slices (active or completed)
        // Queued slices are hidden until they become active
        const MAX_VISIBLE_SLICES = 6;
        const sliceIds = Array.from(state.slices.keys()).filter(id => {
          const slice = state.slices.get(id);
          return slice && !slice.queued;
        });
        const numSlices = sliceIds.length;

        // Apply max visible slices limit with consolidation
        let visibleSliceIds = sliceIds;
        let showIndicator = false;
        let hiddenCount = 0;
        if (numSlices > MAX_VISIBLE_SLICES) {
          visibleSliceIds = sliceIds.slice(numSlices - MAX_VISIBLE_SLICES); // Show last N slices
          hiddenCount = numSlices - MAX_VISIBLE_SLICES;
          showIndicator = true;
        }
        const numVisible = showIndicator ? MAX_VISIBLE_SLICES : numSlices;
        const totalCols = showIndicator ? numVisible + 1 : numVisible; // +1 for indicator column when consolidating

        if (numVisible === 0) {
          const rEmpty  = `│${' '.repeat(rightInner)}│`;
          const rBottom = `└${'─'.repeat(rightInner)}┘`;

          return [
            theme.fg('accent', leftBorder) + ' ' + rTopWithTitle,
            leftRow1                        + ' ' + theme.fg('accent', rEmpty),
            leftRow2                        + ' ' + theme.fg('accent', rEmpty),
            leftRow3                        + ' ' + theme.fg('accent', rEmpty),
            theme.fg('accent', leftBottom)  + ' ' + theme.fg('accent', rBottom),
          ];
        }

        // ── Right box: column layout ──────────────────────────────────────────
        // rightInner = sum of column widths + (totalCols-1) dividers
        const dividers = totalCols - 1;
        const contentTotal = rightInner - dividers;
        const colBase = Math.floor(contentTotal / totalCols);
        const extra   = contentTotal % totalCols; // first `extra` columns get +1

        const colW = (i: number) => colBase + (i < extra ? 1 : 0);

        // Top border: title fills first section, then ┬ dividers for column breaks
        // Build raw dash+divider string, then splice title into the front
        const rawTopInner = Array.from({ length: totalCols }, (_, i) =>
          '─'.repeat(colW(i)) + (i < totalCols - 1 ? '┬' : '')
        ).join('');
        
        // Skip the portion of rawTopInner consumed by: titlePrefixDashes (explicit dashes) + titleText.
        // Both are placed before rawTopInner.slice(skipChars), so rawTopInner must advance by both.
        // rawTopInner.slice(skipChars).length == rightInner - titlePrefixDashes - titleText.length
        // which is exactly the remaining border width needed — no second .slice() required.
        const skipChars = titlePrefixDashes + titleText.length;

        const rTop =
          '┌' + '─'.repeat(titlePrefixDashes) +
          theme.fg('muted', titleText) +
          theme.fg('accent', rawTopInner.slice(skipChars) + '┐');

        // Empty rows (above and below content)
        const rEmpty = '│' + Array.from({ length: totalCols }, (_, i) =>
          ' '.repeat(colW(i)) + (i < totalCols - 1 ? '│' : '')
        ).join('') + '│';

        // Content row (row 2 = middle of 4)
        const cols = visibleSliceIds.map((id, i) => {
          const slice = state.slices.get(id)!;
          const w = colW(showIndicator ? i + 1 : i);
          const raw = slice.completed ? `✓${slice.label}` : slice.label;
          const content = raw.length > w ? raw.slice(0, w) : raw;
          const pL = Math.max(0, Math.floor((w - content.length) / 2));
          const pR = Math.max(0, w - content.length - pL);
          const cell = ' '.repeat(pL) + content + ' '.repeat(pR);
          const colored =
            slice.flash === 'green' ? theme.fg('success', cell) :
            slice.flash === 'red'   ? theme.fg('error',   cell) :
                                      theme.fg('text',    cell);
          // Only add divider if not last slice column
          // Add divider for all except last column (use absolute index)
          const absIndex = i + (showIndicator ? 1 : 0);
          return colored + (absIndex < totalCols - 1 ? '│' : '');
        });

        // Add indicator column on LEFT (before slice columns)
        if (showIndicator) {
          const indicatorContent = `+${hiddenCount}`;
          const w = colW(0);
          const pL = Math.max(0, Math.floor((w - indicatorContent.length) / 2));
          const pR = Math.max(0, w - indicatorContent.length - pL);
          const cell = ' '.repeat(pL) + indicatorContent + ' '.repeat(pR);
          // Add divider after indicator (since it's followed by slice columns)
          cols.unshift(theme.fg('muted', cell + '│'));
        }

        const rContent = '│' + cols.join('') + '│';

        // Bottom border with ┴ dividers
        const rBottom = '└' + Array.from({ length: totalCols }, (_, i) =>
          '─'.repeat(colW(i)) + (i < totalCols - 1 ? '┴' : '')
        ).join('') + '┘';

        return [
          theme.fg('accent', leftBorder) + ' ' + rTop,
          leftRow1                        + ' ' + rEmpty,
          leftRow2                        + ' ' + rContent,
          leftRow3                        + ' ' + rEmpty,
          theme.fg('accent', leftBottom)  + ' ' + theme.fg('accent', rBottom),
        ];
      },

      invalidate(): void {
        // No-op — re-renders are driven by onUpdate() callback
      },
    };

    return component;
  };
}
