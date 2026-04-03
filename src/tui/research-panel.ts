/**
 * Research TUI Panel
 *
 * Two-box layout for research status:
 * - Left box (11 cols): SearXNG status — line1: "SearXNG:55732", line2: "12 conn"
 * - Right box (fills remaining width): Up to 6 visible slice columns, consolidates with "+N" indicator
 *
 * Layout (example, 5 slices):
 * ┌───────────┐ ┌────┬────┬────┬────┬────┐
 * │SearXNG:5  │ │    │    │    │    │    │
 * │12 conn    │ │ 1  │ 2  │ 3  │ 4  │ 5  │
 * │           │ │    │    │    │    │    │
 * │           │ │    │    │    │    │    │
 * └───────────┘ └────┴────┴────┴────┴────┘
 *
 * Consolidation (example, 8 slices, max 6 visible):
 * ┌───────────┐ ┌────┬────┬────┬────┬────┐
 * │SearXNG:5  │ │    │    │    │    │    │
 * │12 conn    │ │ 1  │ 2  │ 3  │ 4  │+3  │
 * │           │ │    │    │    │    │    │
 * │           │ │    │    │    │    │    │
 * └───────────┘ └────┴────┴────┴────┴────┘
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

let capturedTui: { requestRender?(): void } | null = null;

/** Request an immediate render for per-slice updates (no debounce) */
function scheduleRender(): void {
  capturedTui?.requestRender?.();
}

export function getCapturedTui(): { requestRender?(): void } | null {
  return capturedTui;
}

export function clearAllFlashTimeouts(): void {
  for (const timeout of activeTimeouts) {
    clearTimeout(timeout);
  }
  activeTimeouts.clear();
}

/** Add a new slice column */
export function addSlice(state: ResearchPanelState, sliceId: string, label: string, queued: boolean = false): void {
  state.slices.set(sliceId, { id: sliceId, label, completed: false, queued, flash: null });
  scheduleRender();
}

/** Update slice label (e.g., "1:1" → "1:2" → "1:3") */
export function updateSliceLabel(state: ResearchPanelState, sliceId: string, newLabel: string): void {
  const slice = state.slices.get(sliceId);
  if (slice && !slice.completed && !slice.queued) {  // Guard: don't update completed or queued slices
    slice.label = newLabel;
    scheduleRender();
  }
}

/** Mark slice as complete — shows ✓ prefix, no flash */
export function completeSlice(state: ResearchPanelState, sliceId: string): void {
  const slice = state.slices.get(sliceId);
  if (slice) {
    slice.completed = true;
    slice.queued = false;
    scheduleRender();
  }
}

/** Flash a slice green or red for durationMs, independent of completion state */
export function flashSlice(
  state: ResearchPanelState,
  sliceId: string,
  color: 'green' | 'red',
  durationMs: number = 1000
): void {
  const slice = state.slices.get(sliceId);
  if (!slice || slice.completed || slice.queued) return;  // Guard: don't flash completed or queued slices
  slice.flash = color;
  scheduleRender();
  const timeout = setTimeout(() => {
    slice.flash = null;
    scheduleRender();
    activeTimeouts.delete(timeout);
  }, durationMs);
  activeTimeouts.add(timeout);
}

/** Remove a slice column */
export function removeSlice(state: ResearchPanelState, sliceId: string): void {
  state.slices.delete(sliceId);
  scheduleRender();
}

/** Mark slice as active (start from queued state) */
export function activateSlice(state: ResearchPanelState, sliceId: string): void {
  const slice = state.slices.get(sliceId);
  if (slice) {
    slice.queued = false;
    scheduleRender();
  }
}

/** Count active (non-queued, non-completed) slices */
export function countActiveSlices(state: ResearchPanelState): number {
  return Array.from(state.slices.values()).filter(s => !s.completed && !s.queued).length;
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
  return (tui: unknown, theme: Theme) => {
    capturedTui = tui as { requestRender?(): void };

    const component: Component = {
      render(width: number): string[] {
        // ── Left box geometry ──────────────────────────────────────────────────
        // Inner content is 9 chars: "SearXNG:557" (status+port trimmed to fit)
        const LEFT_INNER = 9;
        const LEFT_BOX_W = LEFT_INNER + 2; // 11 (borders, ~20% thinner)
        const GAP = 1;

        // ── Right box geometry ────────────────────────────────────────────────
        const rightBoxWidth = Math.max(20, width - LEFT_BOX_W - GAP);
        const rightInner = rightBoxWidth - 2; // inside the outer │ … │

        // ── Left box content ──────────────────────────────────────────────────
        const status = state.searxngStatus;
        const statusText = getStatusText(status.state);
        const portStr = extractPort(status.url);
        const statusColor = status.state === 'error'
          ? 'error'
          : (status.state === 'active' || status.state === 'starting_up')
            ? 'success'
            : 'muted';

        // Line 1: "SearXNG:557" (status+port trimmed to LEFT_INNER)
        const portShort = portStr.length > 3 ? portStr.slice(0, 3) : portStr; // ":557" from ":55732"
        const line1raw = statusText + portShort; // e.g. "SearXNG:557"
        const pad1 = LEFT_INNER - line1raw.length;
        const leftRow2 = `│${theme.fg(statusColor, statusText)}${theme.fg('accent', portShort)}${' '.repeat(Math.max(0, pad1))}│`;

        // Line 2: active connection count with "conn" label
        const connStr = `${state.activeConnections} conn`;
        const connColor = state.activeConnections > 0 ? 'text' : 'muted';
        const padL2 = Math.floor((LEFT_INNER - connStr.length) / 2);
        const padR2 = LEFT_INNER - connStr.length - padL2;
        const leftRow3 = `│${' '.repeat(padL2)}${theme.fg(connColor, connStr)}${' '.repeat(Math.max(0, padR2))}│`;

        const leftBorder = `┌${'─'.repeat(LEFT_INNER)}┐`;
        const leftEmpty  = `│${' '.repeat(LEFT_INNER)}│`;
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
          visibleSliceIds = sliceIds.slice(0, MAX_VISIBLE_SLICES - 1);
          hiddenCount = numSlices - (MAX_VISIBLE_SLICES - 1);
          showIndicator = true;
        }
        const numVisible = showIndicator ? MAX_VISIBLE_SLICES : numSlices;

        if (numVisible === 0) {
          const rEmpty  = `│${' '.repeat(rightInner)}│`;
          const rBottom = `└${'─'.repeat(rightInner)}┘`;

          return [
            theme.fg('accent', leftBorder) + ' ' + rTopWithTitle,
            leftRow2                        + ' ' + theme.fg('accent', rEmpty),
            leftRow3                        + ' ' + theme.fg('accent', rEmpty),
            theme.fg('accent', leftEmpty)   + ' ' + theme.fg('accent', rEmpty),
            theme.fg('accent', leftBottom)  + ' ' + theme.fg('accent', rBottom),
          ];
        }

        // ── Right box: column layout ──────────────────────────────────────────
        // rightInner = sum of column widths + (numVisible-1) dividers
        const dividers = numVisible - 1;
        const contentTotal = rightInner - dividers;
        const colBase = Math.floor(contentTotal / numVisible);
        const extra   = contentTotal % numVisible; // first `extra` columns get +1

        const colW = (i: number) => colBase + (i < extra ? 1 : 0);

        // Top border: title fills the first section, then ┬ dividers for column breaks
        // Build raw dash+divider string, then splice title into the front
        const rawTopInner = Array.from({ length: numVisible }, (_, i) =>
          '─'.repeat(colW(i)) + (i < numVisible - 1 ? '┬' : '')
        ).join('');
        const titleLen = titleText.length;
        const rTop =
          '┌' + '─'.repeat(titlePrefixDashes) +
          theme.fg('muted', titleText) +
          theme.fg('accent', rawTopInner.slice(titlePrefixDashes + titleLen) + '┐');

        // Empty row
        const rEmpty = '│' + Array.from({ length: numVisible }, (_, i) =>
          ' '.repeat(colW(i)) + (i < numVisible - 1 ? '│' : '')
        ).join('') + '│';

        // Content row (row 3 = middle of 5)
        const cols = visibleSliceIds.map((id, i) => {
          const slice = state.slices.get(id)!;
          const content = slice.completed ? `✓${slice.label}` : slice.label;
          const w = colW(i);
          const pL = Math.max(0, Math.floor((w - content.length) / 2));
          const pR = Math.max(0, w - content.length - pL);
          const cell = ' '.repeat(pL) + content + ' '.repeat(pR);
          const colored =
            slice.flash === 'green' ? theme.fg('success', cell) :
            slice.flash === 'red'   ? theme.fg('error',   cell) :
                                      theme.fg('text',    cell);
          // Only add divider if not the last slice column
          return colored + (i < visibleSliceIds.length - 1 ? '│' : '');
        });
        // Add indicator column if showing hidden count
        if (showIndicator) {
          const indicatorContent = `+${hiddenCount}`;
          const w = colW(numVisible - 1);
          const pL = Math.max(0, Math.floor((w - indicatorContent.length) / 2));
          const pR = Math.max(0, w - indicatorContent.length - pL);
          const cell = ' '.repeat(pL) + indicatorContent + ' '.repeat(pR);
          // No divider after indicator column (it's the last column)
          cols.push(theme.fg('muted', cell));
        }

        const rContent = '│' + cols.join('') + '│';

        // Bottom border with ┴ dividers
        const rBottom = '└' + Array.from({ length: numVisible }, (_, i) =>
          '─'.repeat(colW(i)) + (i < numVisible - 1 ? '┴' : '')
        ).join('') + '┘';

        return [
          theme.fg('accent', leftBorder) + ' ' + rTop,
          leftRow2                        + ' ' + theme.fg('accent', rEmpty),
          leftRow3                        + ' ' + rContent,
          theme.fg('accent', leftEmpty)   + ' ' + theme.fg('accent', rEmpty),
          theme.fg('accent', leftBottom)  + ' ' + theme.fg('accent', rBottom),
        ];
      },

      invalidate(): void {
        // No-op — state mutations call requestRender directly
      },
    };

    return component;
  };
}
