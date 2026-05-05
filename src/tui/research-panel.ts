/**
 * Research TUI Panel
 *
 * Side-by-side researcher column layout with progress tracking.
 * Adapted from the original design (pre-search-redesign) to work with
 * the current browser-based architecture (no SearXNG).
 */

import { type Component, visibleWidth, truncateToWidth } from '@mariozechner/pi-tui';

/**
 * Local Theme interface — mirrors pi-tui Theme.fg()
 */
export interface Theme {
  fg: (color: string, text: string) => string;
}

export interface SliceState {
  id: string;
  label: string; // Displayed label: "1", "2", "3", etc.
  completed: boolean;
  queued: boolean;
  tokens?: number; // Tokens for this specific agent
  cost?: number;   // Cost for this specific agent
  status?: string; // Optional status message like "Searching..."
}

export interface ResearchProgress {
  /** Total tool calls expected across all researchers in the initial plan. */
  expected: number;
  /** Actual tool calls completed so far. */
  made: number;
}

export interface ResearchPanelState {
  sessionId: string;
  /** Alias for sessionId — used by the orchestrator */
  researchId: string;
  query: string;
  totalTokens: number;
  totalCost: number;
  slices: Map<string, SliceState>;
  modelName: string;
  /** True when the research is actively searching (queueing/executing search tool) */
  isSearching?: boolean;
  /** Optional progress bar data. Set after planning completes. */
  progress?: ResearchProgress;
  /** Temporary status message displayed in the header (e.g. 'planning...') */
  statusMessage?: string;
  /** Animation frame counter for traveling wave effect during search */
  waveFrame?: number;
}

/**
 * Add a new researcher column
 */
export function addSlice(state: ResearchPanelState, id: string, label: string, queued: boolean = false): void {
  state.slices.set(id, { id, label, completed: false, queued });
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
 * Update researcher tokens and cost.
 * Tokens are treated as current context size (latest value), while cost is accumulated.
 */
export function updateSliceTokens(state: ResearchPanelState, id: string, tokens: number, cost: number): void {
  const slice = state.slices.get(id);
  if (slice) {
    // Non-decreasing guard: never update with a lower token count (stale estimates)
    if (tokens > (slice.tokens || 0)) {
        slice.tokens = tokens;
    }
    // Cost is accumulated by adding the new cost to the existing cost
    slice.cost = (slice.cost || 0) + cost;
  }
}

/**
 * Update researcher status message (e.g. "Searching...")
 */
export function updateSliceStatus(state: ResearchPanelState, id: string, status: string | undefined): void {
  const slice = state.slices.get(id);
  if (slice) {
    slice.status = status;
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
 * Re-mark a researcher as active (used when promoting a completed researcher to lead evaluator)
 */
export function reactivateSlice(state: ResearchPanelState, id: string): void {
  const slice = state.slices.get(id);
  if (slice) {
    slice.completed = false;
  }
}

/**
 * Clear all completed slices from the TUI panel.
 * This includes researchers, coordinator, and evaluator once completed.
 */
export function clearCompletedResearchers(state: ResearchPanelState): void {
  const toRemove: string[] = [];
  for (const [id, slice] of state.slices.entries()) {
    if (slice.completed) {
      toRemove.push(id);
    }
  }
  for (const id of toRemove) {
    state.slices.delete(id);
  }
}

/**
 * Create initial panel state (without SearXNG status)
 */
export function createInitialPanelState(sessionId: string, query: string, modelName: string): ResearchPanelState {
  return {
    sessionId,
    researchId: sessionId,
    query,
    totalTokens: 0,
    totalCost: 0,
    slices: new Map(),
    modelName,
  };
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * Render a percentage string for the header.
 * Returns empty string when progress data is absent or not yet initialised.
 * Rounds to nearest 10% increment (10, 20, 30, ..., 90, 100).
 */
function renderProgressPct(progress: ResearchProgress | undefined): string {
  if (!progress || progress.expected <= 0) return '';
  const pct = Math.min(1, progress.made / progress.expected) * 100;
  const rounded = Math.round(pct / 10) * 10;
  return `${Math.min(100, rounded)}%`;
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.0001) return '<$0.01';
  if (cost < 1) {
    const s = cost.toFixed(4);
    return `$${parseFloat(s)}`;
  }
  if (cost < 100) return `$${cost.toFixed(2)}`;
  return `$${Math.round(cost)}`;
}

// ============================================================================
// Wave Animation - Color Utilities and Gradient Building
// ============================================================================

/**
 * Parse ANSI foreground color escape code to extract color index or RGB values.
 *
 * Returns:
 *   - { type: '256', index: N } for \x1b[38;5;Nm
 *   - { type: 'rgb', r, g, b } for \x1b[38;2;r;g;bm
 *   - { type: 'basic', index: N } for \x1b[30-37m
 *   - null if parse fails
 */
function parseAnsiFgColor(
  ansiCode: string
): { type: '256' | 'rgb' | 'basic'; index?: number; r?: number; g?: number; b?: number } | null {
  // ESC character for ANSI escape sequences
  const ESC = '\x1b';

  // Match \x1b[38;5;Nm (256-color)
  // eslint-disable-next-line no-useless-escape
  const pattern256 = ESC + '\\[38;5;(\\d+)m';
  const match256 = ansiCode.match(pattern256);
  if (match256 && match256[1] !== undefined) {
    return { type: '256', index: parseInt(match256[1], 10) };
  }

  // Match \x1b[38;2;r;g;bm (truecolor)
  // eslint-disable-next-line no-useless-escape
  const patternRgb = ESC + '\\[38;2;(\\d+);(\\d+);(\\d+)m';
  const matchRgb = ansiCode.match(patternRgb);
  if (matchRgb && matchRgb[1] !== undefined && matchRgb[2] !== undefined && matchRgb[3] !== undefined) {
    return {
      type: 'rgb',
      r: parseInt(matchRgb[1], 10),
      g: parseInt(matchRgb[2], 10),
      b: parseInt(matchRgb[3], 10),
    };
  }

  // Match basic colors \x1b[30-37m
  // eslint-disable-next-line no-useless-escape
  const patternBasic = ESC + '\\[3([0-7])m';
  const matchBasic = ansiCode.match(patternBasic);
  if (matchBasic && matchBasic[1] !== undefined) {
    return { type: 'basic', index: parseInt(matchBasic[1], 10) };
  }

  return null;
}

/**
 * Convert RGB to nearest 256-color cube or grayscale index.
 *
 * Algorithm:
 * 1. Convert RGB to 6×6×6 cube coordinates (0-5 each)
 * 2. Find closest grayscale (232-255)
 * 3. Return whichever is closer (with preference for cube if saturation > threshold)
 */
function rgbTo256(r: number, g: number, b: number): number {
  // 6×6×6 cube values
  const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

  // Find closest cube index
  const findClosest = (value: number) => {
    let minDist = Infinity;
    let minIdx = 0;
    for (let i = 0; i < CUBE_VALUES.length; i++) {
      const cubeValue = CUBE_VALUES[i];
      if (cubeValue === undefined) continue;
      const dist = Math.abs(value - cubeValue);
      if (dist < minDist) {
        minDist = dist;
        minIdx = i;
      }
    }
    return minIdx;
  };

  const rIdx = findClosest(r);
  const gIdx = findClosest(g);
  const bIdx = findClosest(b);

  // Cube color
  const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
  const cubeR = CUBE_VALUES[rIdx] ?? 0;
  const cubeG = CUBE_VALUES[gIdx] ?? 0;
  const cubeB = CUBE_VALUES[bIdx] ?? 0;

  // Calculate distances
  const colorDistance = (r1: number, g1: number, b1: number, r2: number, g2: number, b2: number) => {
    const dr = r1 - r2;
    const dg = g1 - g2;
    const db = b1 - b2;
    // Weighted Euclidean distance (human eye more sensitive to green)
    return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
  };

  const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);

  // Find closest grayscale (232-255)
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);
  let minGrayDist = Infinity;
  let minGrayIdx = 0;

  for (let i = 0; i < GRAY_VALUES.length; i++) {
    const dist = Math.abs(gray - (GRAY_VALUES[i] ?? 0));
    if (dist < minGrayDist) {
      minGrayDist = dist;
      minGrayIdx = i;
    }
  }

  const grayIndex = 232 + minGrayIdx;
  const grayDist = colorDistance(r, g, b, gray, gray, gray);

  // Check color saturation (spread between max and min channel)
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const spread = maxC - minC;

  // Prefer cube if color has noticeable saturation AND cube is closer
  if (spread > 10 && cubeDist < grayDist) {
    return cubeIndex;
  }

  // Return whichever is closer
  return cubeDist < grayDist ? cubeIndex : grayIndex;
}

/**
 * Derive gradient colors from a base 256-color index.
 *
 * For 256-color cube (16-231):
 *   n = index - 16
 *   r = floor(n/36), g = floor((n%36)/6), b = n%6 (each 0-5)
 *   Scale each component toward 0 for each gradient step
 *
 * For grayscale (232-255):
 *   Scale (index - 232) toward 0
 *
 * Returns array of ANSI escape codes for foreground colors.
 */
function derive256Gradient(baseIndex: number, steps: number): string[] {
  const gradient: string[] = [];

  if (baseIndex >= 16 && baseIndex <= 231) {
    // 6×6×6 color cube
    const n = baseIndex - 16;
    const r0 = Math.floor(n / 36);
    const g0 = Math.floor((n % 36) / 6);
    const b0 = n % 6;

    for (let step = 0; step < steps; step++) {
      const factor = 1 - step / steps; // 1.0 to 0.0

      // Scale cube coordinates toward 0
      const r = Math.round(r0 * factor);
      const g = Math.round(g0 * factor);
      const b = Math.round(b0 * factor);

      // Convert back to index
      const newIndex = 16 + 36 * r + 6 * g + b;
      gradient.push(`\x1b[38;5;${newIndex}m`);
    }
  } else if (baseIndex >= 232 && baseIndex <= 255) {
    // Grayscale ramp
    const gray = baseIndex - 232; // 0-23

    for (let step = 0; step < steps; step++) {
      const factor = 1 - step / steps; // 1.0 to 0.0
      const scaled = Math.round(gray * factor);
      gradient.push(`\x1b[38;5;${232 + scaled}m`);
    }
  } else {
    // Basic colors or out of range - fallback to gray gradient
    const GRAY_START = 244;
    const GRAY_END = 234;

    for (let step = 0; step < steps; step++) {
      const factor = step / (steps - 1); // 0.0 to 1.0
      const gray = Math.round(GRAY_START - factor * (GRAY_START - GRAY_END));
      gradient.push(`\x1b[38;5;${Math.max(GRAY_END, gray)}m`);
    }
  }

  return gradient;
}

/**
 * Derive gradient colors from RGB values.
 *
 * Scales each channel toward 0 and converts to nearest 256-color.
 */
function deriveRgbGradient(r: number, g: number, b: number, steps: number): string[] {
  const gradient: string[] = [];

  for (let step = 0; step < steps; step++) {
    const factor = 1 - step / steps; // 1.0 to 0.0
    const scaledR = Math.round(r * factor);
    const scaledG = Math.round(g * factor);
    const scaledB = Math.round(b * factor);
    const index = rgbTo256(scaledR, scaledG, scaledB);
    gradient.push(`\x1b[38;5;${index}m`);
  }

  return gradient;
}

/**
 * Build wave gradient colors from theme accent color.
 *
 * Parameters:
 *   theme - Theme interface with fg() method
 *   steps - Number of gradient steps (brightest to dimmest)
 *
 * Returns:
 *   Array of ANSI foreground escape codes, where:
 *   - index 0 = brightest color (peak of wave)
 *   - last index = dimmest color (tail of wave)
 *
 * Fallback:
 *   Returns gray gradient (244 down to 234) if accent color cannot be parsed.
 */
function buildWaveGradient(theme: Theme, steps: number): string[] {
  // Get raw ANSI code for accent color
  const accentText = theme.fg('accent', '');

  // Parse ANSI code to extract color information
  const parsed = parseAnsiFgColor(accentText);

  if (!parsed) {
    // Fallback: gray gradient
    return Array.from({ length: steps }, (_, i) => {
      const gray = Math.round(244 - (i / (steps - 1)) * 10);
      return `\x1b[38;5;${Math.max(234, gray)}m`;
    });
  }

  switch (parsed.type) {
    case '256':
      return derive256Gradient(parsed.index!, steps);

    case 'rgb':
      return deriveRgbGradient(parsed.r!, parsed.g!, parsed.b!, steps);

    case 'basic': {
      // Basic ANSI colors - map to approximate 256-color indices
      const basicTo256: Record<number, number> = {
        0: 16, // black
        1: 196, // red
        2: 46, // green
        3: 226, // yellow
        4: 21, // blue
        5: 201, // magenta
        6: 51, // cyan
        7: 231, // white
      };
      const mappedIndex = basicTo256[parsed.index!] ?? 244;
      return derive256Gradient(mappedIndex, steps);
    }

    default:
      // Fallback
      return Array.from({ length: steps }, (_, i) => {
        const gray = Math.round(244 - (i / (steps - 1)) * 10);
        return `\x1b[38;5;${Math.max(234, gray)}m`;
      });
  }
}

/**
 * Internal rendering logic for a single research panel block.
 * Returns lines of TUI content with side-by-side researcher columns.
 */
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
    // Completed slices stay visible (rendered as grey) until cleared
    return true;
  });

  const numSlices = sliceIds.length;
  const MAX_VISIBLE_SLICES = 6;
  
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
        // Eval box: box-drawing dashes (─) at edges, regular hyphens (-) in middle
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
      } else {
        topPart = '─'.repeat(w);
      }

      const topRightCorner = isEval ? '╮' : (nextIsEval ? '╭' : (isLast ? '┐' : '┬'));
      rightRawRows[0]!.push(topPart + topRightCorner);
      rightColors[0]!.push('accent');

      // Token Row (row 1)
      let tokenStr: string;
      if (isEval) {
        // Eval label display: ╷ eval ╷ with decorative borders
        const innerWidth = Math.max(0, w - 2);
        const evalLabel = 'eval';
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
        // Eval cost row: ╵ (empty space) ╵ with decorative borders
        const innerWidth = Math.max(0, w - 2);
        costStr = '╵' + ' '.repeat(innerWidth) + '╵';
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
        // Eval box: box-drawing dashes (─) at edges, regular hyphens (-) in middle
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
): (tui: unknown, theme: Theme) => Component {
  const getPanels = getActivePanelsFn;

  return (_tui: unknown, theme: Theme) => {
    const component: Component = {
      render(width: number): string[] {
        const panels: ResearchPanelState[] = getPanels ? getPanels(piSessionId) : [];
        if (panels.length === 0) return [];

        const allLines: string[] = [];
        for (let i = 0; i < panels.length; i++) {
          const panel = panels[i]!;

          // Header line for each block (fixed width, rounded corners)
          const pctStr = renderProgressPct(panel.progress);
          const status = panel.statusMessage ? `[${panel.statusMessage}]` : '';
          let headerText: string;
          if (pctStr) {
            headerText = status ? ` Research: ${pctStr} (${status})` : ` Research: ${pctStr}`;
          } else {
            headerText = status ? ` Research (${status})` : ` Research`;
          }

          const maxWidth = Math.max(20, width - 4);
          if (headerText.length > maxWidth) {
            if (pctStr) {
              const remainingLen = maxWidth - ` Research: ${pctStr} `.length;
              if (remainingLen > 6) {
                headerText = ` Research: ${pctStr} ${status.slice(0, remainingLen - 4)}..`;
              } else {
                headerText = ` Research: ${pctStr}`;
              }
            } else {
              const remainingLen = maxWidth - ` Research `.length;
              if (remainingLen > 6) {
                headerText = ` Research ${status.slice(0, remainingLen - 4)}..`;
              } else {
                headerText = ` Research`;
              }
            }
          }

          // Render header: ── text ─╮ (straight left, rounded right to connect to box below)
          const leftDecor = theme.fg('accent', '──');
          const rightDecor = theme.fg('accent', ' ─╮');

          let headerLine = leftDecor + theme.fg('muted', headerText) + rightDecor;

          if (panel.isSearching) {
            const currentWidth = visibleWidth(headerLine);
            const targetWidth = width - 1;
            const available = targetWidth - (currentWidth + 2); // Two spaces of padding

            if (available > 0 && panel.waveFrame !== undefined) {
              // Traveling wave animation
              const TRAIL_LEN = 8;
              const BG_COLOR_INDEX = 237;
              const WAVE_CHAR = '─';

              // Build gradient colors from theme accent
              const gradient = buildWaveGradient(theme, TRAIL_LEN);
              const bgAnsi = `\x1b[38;5;${BG_COLOR_INDEX}m`;
              const resetFg = '\x1b[39m';

              // Calculate peak position
              // peakPos ranges from -TRAIL_LEN to available+TRAIL_LEN
              const peakPos = (panel.waveFrame % (available + TRAIL_LEN)) - TRAIL_LEN;

              // Build wave fill string character by character
              let fill = '';
              for (let i = 0; i < available; i++) {
                const distFromPeak = peakPos - i;

                if (distFromPeak >= 0 && distFromPeak < TRAIL_LEN) {
                  // Within wave trail - use gradient color
                  const color = gradient[Math.min(distFromPeak, gradient.length - 1)];
                  fill += `${color}${WAVE_CHAR}${resetFg}`;
                } else {
                  // Background - use dim gray
                  fill += `${bgAnsi}${WAVE_CHAR}${resetFg}`;
                }
              }

              headerLine += '  ' + fill;
            } else if (available > 0) {
              // Fallback to static pattern (no animation running)
              const pattern = 'ˍ＿';
              const pWidth = visibleWidth(pattern);
              const count = Math.floor(available / pWidth);
              let fill = pattern.repeat(count);

              // Fill remaining small gap with partial pattern if needed
              const remaining = available % pWidth;
              if (remaining >= 1) fill += 'ˍ';

              headerLine += '  ' + theme.fg('accent', fill);
            }
          }

          allLines.push(headerLine);

          const blockLines = renderPanelBlock(panel, theme, width);
          allLines.push(...blockLines);
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
        // Master widget is refreshed explicitly via masterUpdateRegistry
      }
    };
    return component;
  };
}
