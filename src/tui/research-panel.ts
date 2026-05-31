/**
 * Research TUI Panel
 *
 * Side-by-side researcher column layout with progress tracking.
 * Adapted from the original design to work with the current browser-based
 * architecture using DuckDuckGo Lite (Playwright).
 */

import { type Component, visibleWidth, truncateToWidth, type TUI } from '@earendil-works/pi-tui';
import type { Theme, ResearchPanelState } from '../types/research-panel-types.ts';
import {
  formatTokens,
  renderProgressPct,
  formatCost,
  _formatTokens,
  _renderProgressPct,
  _formatCost,
} from './research-panel-format.ts';
import { generateWaveFill } from './research-panel-wave.ts';

/**
 * Re-export types for convenience
 */
export type { Theme, SliceState, ResearchPanelState, ResearchProgress } from '../types/research-panel-types.ts';

/**
 * Re-export state management functions
 */
export {
  addSlice,
  removeSlice,
  activateSlice,
  updateSliceTokens,
  updateSliceStatus,
  completeSlice,
  reactivateSlice,
  clearCompletedResearchers,
  createInitialPanelState,
} from './research-panel-state.ts';

/**
 * Re-export formatting utilities (internal test exports)
 */
export { _formatTokens, _renderProgressPct, _formatCost } from './research-panel-format.ts';

/**
 * Re-export color utilities
 */
export {
  derive256Gradient as _derive256Gradient,
  deriveRgbGradient as _deriveRgbGradient,
  rgbTo256 as _rgbTo256,
  indexToRgb as _indexToRgb,
  rgbToHsl as _rgbToHsl,
  hslToRgb as _hslToRgb,
  parseAnsiFgColor as _parseAnsiFgColor,
} from './research-panel-color-utils.ts';

function renderPanelBlock(
  state: ResearchPanelState,
  theme: Theme,
  width: number,
): string[] {
  const rightInner = Math.max(1, width - 2);
  const numRows = 4;

  const sliceIds = Array.from(state.slices.keys()).filter(id => {
    const s = state.slices.get(id);
    if (!s || s.queued) return false;
    return true;
  });

  // Stable sort: Planning/Coordinator first, Researchers numerically, Eval last
  sliceIds.sort((a, b) => {
    const sa = state.slices.get(a)!;
    const sb = state.slices.get(b)!;
    const la = sa.label.toLowerCase();
    const lb = sb.label.toLowerCase();

    // Priority 1: Planning/Coordinator
    const isPlanA = la.includes('plan') || la.includes('coord');
    const isPlanB = lb.includes('plan') || lb.includes('coord');
    if (isPlanA && !isPlanB) return -1;
    if (!isPlanA && isPlanB) return 1;

    // Priority 3: Eval (Last)
    const isEvalA = la === 'eval';
    const isEvalB = lb === 'eval';
    if (isEvalA && !isEvalB) return 1;
    if (!isEvalA && isEvalB) return -1;

    // Priority 2: Numerical researchers
    const numA = parseInt(la, 10);
    const numB = parseInt(lb, 10);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    if (!isNaN(numA)) return -1;
    if (!isNaN(numB)) return 1;

    return la.localeCompare(lb);
  });

  const numSlices = sliceIds.length;
  
  // Dynamically calculate MAX_VISIBLE_SLICES based on width
  // Each column needs at least 3 chars (1 wall + 2 content) for minimal visibility
  const minColWidth = 3;
  const maxPossibleSlices = Math.max(1, Math.floor(rightInner / (minColWidth + 1)));
  const MAX_VISIBLE_SLICES = Math.min(6, maxPossibleSlices);

  const showIndicator = numSlices > MAX_VISIBLE_SLICES;
  const hiddenCount = showIndicator ? numSlices - MAX_VISIBLE_SLICES : 0;
  const visibleSliceIds = showIndicator
    ? sliceIds.slice(numSlices - MAX_VISIBLE_SLICES)
    : sliceIds;

  const numVisible = showIndicator ? MAX_VISIBLE_SLICES : numSlices;
  const totalCols = showIndicator ? numVisible + 1 : numVisible;

  // Calculate column widths for the right section
  const dividers = totalCols - 1;
  const contentTotal = Math.max(0, rightInner - dividers);
  const colBase = Math.floor(contentTotal / totalCols);
  const extra = contentTotal % totalCols;
  const colW = (i: number) => Math.max(0, colBase + (i < extra ? 1 : 0));

  // Build right box raw parts
  const rightRawRows: string[][] = Array.from({ length: numRows }, () => []);
  const rightColors: Array<Array<'success' | 'error' | 'muted' | 'text' | 'accent'>> = Array.from({ length: numRows }, () => []);

  if (numVisible === 0) {
    const w = Math.max(1, rightInner);
    rightRawRows[0]!.push('─'.repeat(w) + '┐');
    rightRawRows[1]!.push(' '.repeat(w) + '│');
    rightRawRows[2]!.push(' '.repeat(w) + '│');
    rightRawRows[3]!.push('─'.repeat(w) + '┘');
    for(let i=0; i<numRows; i++) rightColors[i]!.push('accent');
  } else {
    for (let i = 0; i < totalCols; i++) {
      const sliceId = showIndicator && i === 0 ? null : (showIndicator ? visibleSliceIds[i - 1] : visibleSliceIds[i]);
      const slice = sliceId ? state.slices.get(sliceId) : null;
      const w = colW(i);
      const isLast = i === totalCols - 1;

      const isIndicator = showIndicator && i === 0;
      const labelStr = slice ? slice.label : `+${hiddenCount}`;
      const isEval = labelStr.toLowerCase() === 'eval';

      // Determine right border character based on if next column is eval
      const nextSliceId = i + 1 < totalCols ? (showIndicator && i + 1 === 0 ? null : (showIndicator ? visibleSliceIds[i] : visibleSliceIds[i + 1])) : null;
      const nextSlice = nextSliceId ? state.slices.get(nextSliceId) : null;
      const nextIsEval = nextSlice?.label.toLowerCase() === 'eval';

      // Top Border with Label
      const labelPadding = 2; // Spaces around label
      const totalLabelWidth = labelStr.length + labelPadding;

      let topPart;
      if (isEval) {
        // Eval box: box-drawing dashes (─) at edges, en dashes (–) in middle
        if (w >= 2) {
          topPart = '─' + '-'.repeat(Math.max(0, w - 2)) + '─';
        } else {
          topPart = '─'.repeat(w);
        }
      } else if (w >= totalLabelWidth) {
        const sideWidth = w - totalLabelWidth;
        const leftPad = Math.floor(sideWidth / 2);
        const rightPad = sideWidth - leftPad;
        topPart = '─'.repeat(leftPad) + ' ' + labelStr + ' ' + '─'.repeat(rightPad);
      } else if (w >= 1 && labelStr.length > 0) {
        // Tight space: show first char of label if possible
        topPart = labelStr[0]!.slice(0, w).padEnd(w, '─');
      } else {
        topPart = '─'.repeat(w);
      }

      const topRightCorner = isEval ? '╮' : (nextIsEval ? '╭' : (isLast ? '┐' : '┬'));
      rightRawRows[0]!.push(topPart + topRightCorner);
      rightColors[0]!.push('accent');

      // Token Row (row 1)
      let tokenStr: string;
      if (isEval) {
        // Eval label display: ╷ eval ╷ or ╷ status ╷ with decorative borders
        const innerWidth = Math.max(0, w - 2);
        // Prioritize status if it exists, otherwise use 'eval'
        const evalLabel = slice?.status || 'eval';
        const labelDisplay = evalLabel.length > innerWidth ? evalLabel.slice(0, innerWidth) : evalLabel;
        const padding = innerWidth - labelDisplay.length;
        const leftPad = Math.floor(padding / 2);
        const rightPad = padding - leftPad;
        tokenStr = '╷' + ' '.repeat(leftPad) + labelDisplay + ' '.repeat(rightPad) + '╷';
      } else if (isIndicator) {
        tokenStr = '...'.padStart(Math.floor((w + 3) / 2)).padEnd(w);
      } else {
        const isPlanning = labelStr.includes('planning') || labelStr.includes('complexity');
        const tokens = slice?.tokens || 0;
        let raw = '';

        // For non-eval columns: show token count or status, never eval's decorative text
        if (slice?.status && !slice.completed && !slice.queued && !isPlanning) {
            raw = slice.status;
        } else if (!isPlanning && tokens > 0) {
            raw = formatTokens(tokens);
        }

        const display = raw.length > w ? raw.slice(0, w) : raw;
        tokenStr = display.padStart(Math.floor((w + display.length) / 2)).padEnd(w);
      }

      const rightWall12 = isEval ? '┊' : (nextIsEval ? '┊' : '│');
      rightRawRows[1]!.push(tokenStr + rightWall12);
      rightColors[1]!.push(slice?.completed ? 'muted' : 'text');

      // Cost Row (row 2)
      let costStr: string;
      if (isEval) {
        // Eval cost row: ╵ (empty space) or ╵ cost ╵ with decorative borders
        const innerWidth = Math.max(0, w - 2);
        const cost = slice?.cost || 0;
        const raw = cost === 0 ? '' : formatCost(cost);
        const labelDisplay = raw.length > innerWidth ? raw.slice(0, innerWidth) : raw;
        const padding = innerWidth - labelDisplay.length;
        const leftPad = Math.floor(padding / 2);
        const rightPad = padding - leftPad;
        costStr = '╵' + ' '.repeat(leftPad) + labelDisplay + ' '.repeat(rightPad) + '╵';
      } else if (isIndicator) {
        const display = '...'.length > w ? '...'.slice(0, w) : '...';
        costStr = display.padStart(Math.floor((w + display.length) / 2)).padEnd(w);
      } else {
        const isPlanning = labelStr.includes('planning') || labelStr.includes('complexity');
        const cost = slice?.cost || 0;
        const raw = (isPlanning || cost === 0) ? '' : formatCost(cost);
        const display = raw.length > w ? raw.slice(0, w) : raw;
        costStr = display.padStart(Math.floor((w + display.length) / 2)).padEnd(w);
      }
      rightRawRows[2]!.push(costStr + rightWall12);
      rightColors[2]!.push(slice?.completed ? 'muted' : 'text');

      // Bottom Border
      let bottomContent;
      if (isEval) {
        // Eval box: box-drawing dashes (─) at edges, en dashes (–) in middle
        if (w >= 2) {
          bottomContent = '─' + '-'.repeat(Math.max(0, w - 2)) + '─';
        } else {
          bottomContent = '─'.repeat(w);
        }
      } else {
        bottomContent = '─'.repeat(w);
      }
      const bottomRightCorner = isEval ? '╯' : (nextIsEval ? '╰' : (isLast ? '┘' : '┴'));
      rightRawRows[3]!.push(bottomContent + bottomRightCorner);
      rightColors[3]!.push('accent');
    }
  }

  // Final Assembly
  const blockResult: string[] = [];
  const firstSliceId = visibleSliceIds[0];
  const firstSlice = firstSliceId ? state.slices.get(firstSliceId) : null;
  const startsWithEval = firstSlice?.label.toLowerCase() === 'eval';

  const leftChars = startsWithEval ? ['╭', '┊', '┊', '╰'] : ['┌', '│', '│', '└'];

  for (let rowIdx = 0; rowIdx < 4; rowIdx++) {
    let line = theme.fg('accent', leftChars[rowIdx]!);

    const rightRowParts = rightRawRows[rowIdx]!;
    const rightRowColors = rightColors[rowIdx]!;

    for (let colIdx = 0; colIdx < rightRowParts.length; colIdx++) {
      const part = rightRowParts[colIdx]!;
      const content = part.slice(0, -1);
      const wall = part.slice(-1);

      if (rowIdx === 0 || rowIdx === 3) {
        // Top and bottom borders: all accent color
        line += theme.fg('accent', content);
      } else {
        // Body rows (1-2)
        const color = rightRowColors[colIdx]!;
        const firstChar = content[0];
        const lastChar = content[content.length - 1];

        // Check if this is an eval decorative box (╷...╷ or ╵...╵)
        if (content.length >= 2 && ((firstChar === '╷' && lastChar === '╷') || (firstChar === '╵' && lastChar === '╵'))) {
          // Eval box: render decorative chars as accent, inner content as text
          line += theme.fg('accent', firstChar as string);
          line += theme.fg(color, content.slice(1, -1));
          line += theme.fg('accent', lastChar as string);
        } else {
          line += theme.fg(color, content);
        }
      }

      // Walls: accent color
      line += theme.fg('accent', wall);
    }
    blockResult.push(line);
  }
  return blockResult;
}

/**
 * Create master research panel component for a Pi session.
 * Renders ALL active research runs in that session into a single widget.
 */
export function createMasterResearchPanel(
  piSessionId: string,
  getActivePanelsFn?: (piSessionId: string) => ResearchPanelState[]
): (tui: TUI, theme: Theme) => Component {
  const getPanels = getActivePanelsFn;

  return (_tui: TUI, theme: Theme) => {
    const component: Component = {
      render(width: number): string[] {
        // Safety guard for extremely narrow terminals
        if (width < 4) return [];

        const panels: ResearchPanelState[] = getPanels ? getPanels(piSessionId) : [];
        if (panels.length === 0) return [];

        const allLines: string[] = [];
        for (let i = 0; i < panels.length; i++) {
          const panel = panels[i]!;

          // Header line for each block (fixed width, rounded corners)
          const pctStr = renderProgressPct(panel.progress);
          const status = panel.statusMessage ? `[${panel.statusMessage}]` : '';
          const label = panel.title ?? 'Research';
          let headerText: string;
          if (pctStr) {
            headerText = status ? ` ${label}: ${pctStr} (${status})` : ` ${label}: ${pctStr}`;
          } else {
            headerText = status ? ` ${label} (${status})` : ` ${label}`;
          }

          const maxWidth = Math.max(20, width - 4);
          if (headerText.length > maxWidth) {
            if (pctStr) {
              const remainingLen = maxWidth - ` ${label}: ${pctStr} `.length;
              if (remainingLen > 6) {
                headerText = ` ${label}: ${pctStr} ${status.slice(0, remainingLen - 4)}..`;
              } else {
                headerText = ` ${label}: ${pctStr}`;
              }
            } else {
              const remainingLen = maxWidth - ` ${label} `.length;
              if (remainingLen > 6) {
                headerText = ` ${label} ${status.slice(0, remainingLen - 4)}..`;
              } else {
                headerText = ` ${label}`;
              }
            }
          }

          // Render header: ─╴ text ╶╮ (half-endpoint chars give breathing room around text)
          // During active search the right side becomes a wave: ─╴ text ╶╼──────
          const leftDecor = theme.fg('accent', '─╴');
          const rightDecor = theme.fg('accent', ' ╶╮');

          let headerLine = leftDecor + theme.fg('muted', headerText);

          if (panel.isSearching) {
            headerLine += ' '; // space between header text and wave
            const currentWidth = visibleWidth(headerLine);
            const targetWidth = Math.max(0, width - 1);
            const available = Math.max(0, targetWidth - currentWidth);

            if (available > 0 && panel.waveFrame !== undefined) {
              const waveResult = generateWaveFill(theme, panel.waveFrame, panel.waveColors, available);
              panel.waveColors = waveResult.updatedColors;
              headerLine += waveResult.fill;
            } else if (available > 0) {
              // Fallback: fill with ─ before animation starts
              headerLine += theme.fg('accent', '─'.repeat(available));
            }
          } else {
            headerLine += rightDecor;
          }

          allLines.push(headerLine);

          const blockLines = renderPanelBlock(panel, theme, width);
          allLines.push(...blockLines);
        }

        if (panels.length > 0) {
          allLines.push(theme.fg('muted', ' esc to cancel'));
        }

        return allLines.map(line => {
          const w = visibleWidth(line);
          if (w > width) {
            return truncateToWidth(line, Math.max(1, width));
          }
          return line;
        });
      },
      invalidate(): void {
        // Propagate up the component tree so the framework's render pipeline
        // is triggered. 
        const comp = component as Component & { parent?: { invalidate: () => void } };
        if (comp.parent && typeof comp.parent.invalidate === 'function') {
          comp.parent.invalidate();
        }
      }
    };
    return component;
  };
}
