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
  /** Persistent color codes for wave animation (one per position) */
  waveColors?: string[];
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
   
  const pattern256 = ESC + '\\[38;5;(\\d+)m';
  const match256 = ansiCode.match(pattern256);
  if (match256 && match256[1] !== undefined) {
    return { type: '256', index: parseInt(match256[1], 10) };
  }

  // Match \x1b[38;2;r;g;bm (truecolor)
   
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
 * 256-color cube level values
 */
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

/**
 * Get RGB values for a 256-color cube index
 */
function indexToRgb(index: number): { r: number; g: number; b: number } | null {
  if (index >= 16 && index <= 231) {
    const n = index - 16;
    const rIdx = Math.floor(n / 36);
    const gIdx = Math.floor((n % 36) / 6);
    const bIdx = n % 6;
    return {
      r: CUBE_VALUES[rIdx] ?? 0,
      g: CUBE_VALUES[gIdx] ?? 0,
      b: CUBE_VALUES[bIdx] ?? 0,
    };
  }
  return null;
}

/**
 * RGB to HSL conversion
 * H: 0-360, S: 0-1, L: 0-1
 */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;

  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const delta = max - min;

  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);

    if (max === rNorm) {
      h = ((gNorm - bNorm) / delta + (gNorm < bNorm ? 6 : 0)) / 6;
    } else if (max === gNorm) {
      h = ((bNorm - rNorm) / delta + 2) / 6;
    } else {
      h = ((rNorm - gNorm) / delta + 4) / 6;
    }
  }

  return { h: h * 360, s, l };
}

/**
 * HSL to RGB conversion
 */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  // eslint-disable-next-line no-useless-assignment
  let r = 0;
  // eslint-disable-next-line no-useless-assignment
  let g = 0;
  // eslint-disable-next-line no-useless-assignment
  let b = 0;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hueToRgb = (p: number, q: number, t: number) => {
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;

    const hNorm = h / 360;
    r = hueToRgb(p, q, hNorm + 1 / 3);
    g = hueToRgb(p, q, hNorm);
    b = hueToRgb(p, q, hNorm - 1 / 3);
  }

  return {
    r: Math.max(0, Math.min(255, Math.round(r * 255))),
    g: Math.max(0, Math.min(255, Math.round(g * 255))),
    b: Math.max(0, Math.min(255, Math.round(b * 255))),
  };
}

/**
 * Cycle HSL S and L channels - hue stays constant
 * Sawtooth wave: smooth DOWN then snap back UP
 */
/**
 * Apply power curve easing to control decrease shape
 * curve = 1.0 → linear
 * curve < 1.0 → slow start, fast end (easeOut)
 * curve > 1.0 → fast start, slow end (easeIn)
 */
function applyCurve(t: number, curve: number): number {
  return Math.pow(t, curve);
}

function cycleHslSaturationLightness(baseR: number, baseG: number, baseB: number, stepIndex: number, totalSteps: number): { r: number; g: number; b: number } {
  // Convert to HSL
  const hsl = rgbToHsl(baseR, baseG, baseB);

  // Progress through cycle (0.0 to 1.0)
  const cycleIndex = stepIndex % totalSteps;
  const progress = cycleIndex / totalSteps;

  // Single sawtooth wave: START HIGH (1.0) → smoothly to LOW (0.0) → snap back HIGH (1.0)
  // This doubles the frames per cycle compared to the dual sawtooth
  const linearCycleFactor = 1 - progress;

  // Apply non-linear curve: 2.2 gives easeIn (fast start, slow end)
  // This spreads frames perceptually evenly: bright drops away fast, mid-dark range gets more frames.
  const curvedFactor = applyCurve(linearCycleFactor, 2.2);

  // Gentle oscillation: same shade range, slightly shallower dip
  const newSaturation = hsl.s * (0.98 + 0.02 * curvedFactor);
  const newLightness = hsl.l * (0.65 + 0.35 * curvedFactor);

  // Hue stays constant from original accent color
  const newHue = hsl.h;

  // Convert back to RGB
  const newRgb = hslToRgb(newHue, newSaturation, newLightness);

  // Return full-resolution RGB — caller emits truecolor ANSI
  return { r: newRgb.r, g: newRgb.g, b: newRgb.b };
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
/**
 * Smooth exponential falloff function for gradient.
 * Creates non-linear falloff that stays bright longer.
 * power = 0.5 gives square root, 0.7 gives slower falloff
 */
function smoothFalloff(t: number, power: number = 0.7): number {
  return Math.pow(1 - t, power);
}

/**
 * Add small random variation to a color index.
 * Used for subtle variation in the tail of the gradient.
 */
function addVariation(index: number, maxVariation: number = 1): number {
  const variation = Math.floor(Math.random() * (maxVariation + 1));
  return Math.max(0, index - variation);
}

/**
 * Add slight variation to an ANSI color code.
 */
 
// @ts-ignore
function _addVariationToColor(ansiCode: string | undefined, maxVariation: number = 1): string {
  // Return background if undefined
  if (!ansiCode) {
    return '\x1b[38;5;237m';
  }

  // Extract color index from \x1b[38;5;{N}m pattern
  const match = ansiCode.match(/\\x1b\[38;5;(\\d+)m/);
  if (!match || !match[1]) {
    return ansiCode; // Return original if pattern doesn't match
  }

  const currentIndex = parseInt(match[1], 10);
  // Add slight variation: -1, 0, or +1
  const variation = Math.floor(Math.random() * (maxVariation * 2 + 1)) - maxVariation;
  const newIndex = Math.max(16, Math.min(255, currentIndex + variation));
  // Clamp variation for grayscale range (232-255)
  const clampedIndex = newIndex >= 232 ? Math.min(255, newIndex) : newIndex;

  return `\\x1b[38;5;${clampedIndex}m`;
}

export function _derive256Gradient(baseIndex: number, steps: number): string[] {
  const gradient: string[] = [];

  if (baseIndex >= 16 && baseIndex <= 231) {
    // 6×6×6 color cube - scale toward dimmer version of same color
    const n = baseIndex - 16;
    const r0 = Math.floor(n / 36);
    const g0 = Math.floor((n % 36) / 6);
    const b0 = n % 6;

    // Scale toward 25% of original (keeps hue, reduces brightness)
    const DIM_FACTOR = 0.25;
    const TARGET_R = Math.round(r0 * DIM_FACTOR);
    const TARGET_G = Math.round(g0 * DIM_FACTOR);
    const TARGET_B = Math.round(b0 * DIM_FACTOR);

    for (let step = 0; step < steps; step++) {
      const t = step / (steps - 1);
      const factor = smoothFalloff(t); // Non-linear falloff

      // Interpolate toward dimmer version (keeps hue)
      const r = Math.round(TARGET_R + (r0 - TARGET_R) * factor);
      const g = Math.round(TARGET_G + (g0 - TARGET_G) * factor);
      const b = Math.round(TARGET_B + (b0 - TARGET_B) * factor);

      // Convert back to index
      let newIndex = 16 + 36 * r + 6 * g + b;

      // Add small variation to last 4 steps of gradient
      if (step >= steps - 4) {
        newIndex = addVariation(newIndex, 1);
      }

      gradient.push(`\x1b[38;5;${newIndex}m`);
    }
  } else if (baseIndex >= 232 && baseIndex <= 255) {
    // Grayscale ramp - darken toward 25% of original
    const gray = baseIndex - 232; // 0-23
    const TARGET_GRAY = Math.round(gray * 0.25); // Dim to 25%

    for (let step = 0; step < steps; step++) {
      const t = step / (steps - 1);
      const factor = smoothFalloff(t); // Non-linear falloff
      const scaled = Math.round(TARGET_GRAY + (gray - TARGET_GRAY) * factor);
      let newIndex = 232 + scaled;

      // Add small variation to last 4 steps of gradient
      if (step >= steps - 4) {
        newIndex = addVariation(newIndex, 1);
      }

      gradient.push(`\x1b[38;5;${newIndex}m`);
    }
  } else {
    // Basic colors or out of range - fallback to dimmer gradient
    const GRAY_START = baseIndex >= 232 && baseIndex <= 255 ? baseIndex : 240;
    const GRAY_END = Math.round(GRAY_START * 0.25); // Dim to 25%

    for (let step = 0; step < steps; step++) {
      const t = step / (steps - 1);
      const factor = smoothFalloff(t); // Non-linear falloff
      const gray = Math.round(GRAY_END + (GRAY_START - GRAY_END) * factor);
      let newIndex = Math.max(GRAY_END, gray);

      // Add small variation to last 4 steps of gradient
      if (step >= steps - 4) {
        newIndex = addVariation(newIndex, 1);
      }

      gradient.push(`\x1b[38;5;${newIndex}m`);
    }
  }

  return gradient;
}

/**
 * Derive gradient colors from RGB values.
 *
 * Applies smooth falloff while keeping hue.
 * Scales toward dimmer version (25%) of original color.
 */
export function _deriveRgbGradient(r: number, g: number, b: number, steps: number): string[] {
  const gradient: string[] = [];

  // Scale toward 25% of original (keeps hue, reduces brightness)
  const DIM_FACTOR = 0.25;
  const TARGET_R = Math.round(r * DIM_FACTOR);
  const TARGET_G = Math.round(g * DIM_FACTOR);
  const TARGET_B = Math.round(b * DIM_FACTOR);

  for (let step = 0; step < steps; step++) {
    const t = step / (steps - 1);
    const factor = smoothFalloff(t); // Non-linear falloff

    // Interpolate toward dimmer version (keeps hue)
    const scaledR = Math.round(TARGET_R + (r - TARGET_R) * factor);
    const scaledG = Math.round(TARGET_G + (g - TARGET_G) * factor);
    const scaledB = Math.round(TARGET_B + (b - TARGET_B) * factor);

    let index = rgbTo256(scaledR, scaledG, scaledB);

    // Add small variation to last 4 steps of gradient
    if (step >= steps - 4) {
      // Get RGB components and dim them slightly
      const n = index - 16;
      const ri = Math.floor(n / 36);
      const gi = Math.floor((n % 36) / 6);
      const bi = n % 6;
      const dimmedRi = Math.max(0, ri - 1);
      const dimmedGi = Math.max(0, gi - 1);
      const dimmedBi = Math.max(0, bi - 1);
      index = 16 + 36 * dimmedRi + 6 * dimmedGi + dimmedBi;
    }

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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
// @ts-ignore
function _buildWaveGradient(theme: Theme, steps: number): string[] {
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
              // Wave animation - HSL saturation/lightness cycling with snap-back
              const CYCLE_STEPS = 8;

              // Get accent color to base hue from
              const accentText = theme.fg('accent', '');
              const parsed = parseAnsiFgColor(accentText);

              // Resolve accent to full RGB — avoid any 256-cube quantization
              let baseAccentRgb: { r: number; g: number; b: number } | null = null;

              if (parsed) {
                if (parsed.type === 'rgb' && parsed.r !== undefined && parsed.g !== undefined && parsed.b !== undefined) {
                  baseAccentRgb = { r: parsed.r, g: parsed.g, b: parsed.b };
                } else if (parsed.type === '256' && parsed.index !== undefined) {
                  const idx = parsed.index;
                  if (idx >= 16 && idx <= 231) {
                    const rgb = indexToRgb(idx);
                    if (rgb) baseAccentRgb = rgb;
                  } else if (idx >= 232 && idx <= 255) {
                    const gray = 8 + (idx - 232) * 10;
                    baseAccentRgb = { r: gray, g: gray, b: gray };
                  } else if (idx >= 0 && idx <= 15) {
                    const ansi16Rgb: Record<number, { r: number; g: number; b: number }> = {
                      0:  { r: 0,   g: 0,   b: 0   },
                      1:  { r: 170, g: 0,   b: 0   },
                      2:  { r: 0,   g: 170, b: 0   },
                      3:  { r: 170, g: 170, b: 0   },
                      4:  { r: 0,   g: 0,   b: 170 },
                      5:  { r: 170, g: 0,   b: 170 },
                      6:  { r: 0,   g: 170, b: 170 },
                      7:  { r: 170, g: 170, b: 170 },
                      8:  { r: 85,  g: 85,  b: 85  },
                      9:  { r: 255, g: 85,  b: 85  },
                      10: { r: 85,  g: 255, b: 85  },
                      11: { r: 255, g: 255, b: 85  },
                      12: { r: 85,  g: 85,  b: 255 },
                      13: { r: 255, g: 85,  b: 255 },
                      14: { r: 85,  g: 255, b: 255 },
                      15: { r: 255, g: 255, b: 255 },
                    };
                    baseAccentRgb = ansi16Rgb[idx] ?? null;
                  }
                } else if (parsed.type === 'basic' && parsed.index !== undefined) {
                  const basicRgb: Record<number, { r: number; g: number; b: number }> = {
                    0: { r: 0,   g: 0,   b: 0   },
                    1: { r: 170, g: 0,   b: 0   },
                    2: { r: 0,   g: 170, b: 0   },
                    3: { r: 170, g: 170, b: 0   },
                    4: { r: 0,   g: 0,   b: 170 },
                    5: { r: 170, g: 0,   b: 170 },
                    6: { r: 0,   g: 170, b: 170 },
                    7: { r: 170, g: 170, b: 170 },
                  };
                  baseAccentRgb = basicRgb[parsed.index] ?? null;
                }
              }

              if (!baseAccentRgb) {
                baseAccentRgb = { r: 148, g: 148, b: 148 };
              }

              const resetFg = '\x1b[39m';

              // Compute brightest/darkest colors before initializing waveColors
              // so the initial fill is accent-colored, not grey
              const brightRgb = cycleHslSaturationLightness(baseAccentRgb.r, baseAccentRgb.g, baseAccentRgb.b, 0, CYCLE_STEPS);
              const brightColor = `\x1b[38;2;${brightRgb.r};${brightRgb.g};${brightRgb.b}m`;

              const darkRgb = cycleHslSaturationLightness(baseAccentRgb.r, baseAccentRgb.g, baseAccentRgb.b, CYCLE_STEPS - 1, CYCLE_STEPS);
              const darkColor = `\x1b[38;2;${darkRgb.r};${darkRgb.g};${darkRgb.b}m`;

              if (!panel.waveColors || panel.waveColors.length !== available) {
                panel.waveColors = Array(available).fill(brightColor) as string[];
              }

              // Dynamic phase distance D in [2,4] chosen so available ≈ 1.5 × k × D
              const MIN_D = 2, MAX_D = 4;
              let bestD = MIN_D;
              let bestError = Infinity;
              for (let d = MIN_D; d <= MAX_D; d++) {
                const ratio = available / (1.5 * d);
                const error = Math.abs(ratio - Math.round(ratio));
                if (error < bestError) {
                  bestError = error;
                  bestD = d;
                }
              }
              const wavePeriod = available + bestD;
              // 2/3 speed: advance wave position 2 steps every 3 frames (2× original pace)
              const waveSlowFrame = Math.floor((panel.waveFrame ?? 0) * 2 / 3);
              const waveRawPos = waveSlowFrame % wavePeriod;

              // Paint trail color for current head position (persisted for gradient tail)
              if (waveRawPos < available) {
                const stepIndex = waveSlowFrame % CYCLE_STEPS;
                const waveRgb = cycleHslSaturationLightness(baseAccentRgb.r, baseAccentRgb.g, baseAccentRgb.b, stepIndex, CYCLE_STEPS);
                panel.waveColors[waveRawPos] = `\x1b[38;2;${waveRgb.r};${waveRgb.g};${waveRgb.b}m`;
              }

              // Build fill: ╶ lead-in | ─ trail | ╼ head | 6×space wake | ╶ lag | ─ background
              const WAKE_LEN = 6;
              let fill = '';
              for (let i = 0; i < available; i++) {
                if (i === waveRawPos) {
                  fill += `${brightColor}╼${resetFg}`;
                } else if (i > waveRawPos && i <= waveRawPos + WAKE_LEN) {
                  fill += ' ';
                } else if (i === waveRawPos + WAKE_LEN + 1) {
                  fill += `${panel.waveColors[waveRawPos + WAKE_LEN + 1] || darkColor}╶${resetFg}`;
                } else {
                  const bgChar = i === 0 ? '╶' : '─';
                  fill += `${panel.waveColors[i] || brightColor}${bgChar}${resetFg}`;
                }
              }

              headerLine += fill;
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
