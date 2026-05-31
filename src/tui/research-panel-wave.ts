/**
 * Research Panel Wave Animation
 *
 * Head-trails gradient for the research panel header.
 *
 * Mechanic:
 *
 *  HEAD: always full accent brightness.
 *        Character is a directional half-dash:
 *          ╶  (right half) while moving left→right
 *          ╴  (left half)  while moving right→left
 *
 *  TRAIL: each position stores the slowFrame when it was last visited by the
 *  head.  On every rendered frame, age = currentSlowFrame − lastVisitFrame[i].
 *  That age is mapped through an easeIn brightness ramp (power 2.2) over a
 *  window of TRAIL_LEN = ¾ of available chars:
 *
 *    age 0            → full accent brightness  (head just left)
 *    age TRAIL_LEN-1  → 65 % brightness floor   (far edge of trail)
 *    age >= TRAIL_LEN → dark floor (clamped)
 *
 *  DWELL: the head pauses DWELL=3 slow-frames at both the left and right edge
 *  before reversing, giving a consistent rest at each end.
 *
 *  Speed factor 0.87 retained from the original commit.
 */

import type { Theme } from '../types/research-panel-types.ts';
import {
  parseAnsiFgColor,
  indexToRgb,
  rgbToHsl,
  hslToRgb,
} from './research-panel-color-utils.ts';

const DWELL_FRAMES = 4; // pause duration at each edge
const PERIOD_FRAMES = 40; // total frames for one full back-and-forth cycle (twice as fast)

/**
 * Resolve the theme accent colour to a full-precision RGB triple.
 */
function getBaseAccentRgb(theme: Theme): { r: number; g: number; b: number } {
  const accentText = theme.fg('accent', '');
  const parsed = parseAnsiFgColor(accentText);

  if (parsed) {
    if (parsed.type === 'rgb' && parsed.r !== undefined && parsed.g !== undefined && parsed.b !== undefined) {
      return { r: parsed.r, g: parsed.g, b: parsed.b };
    }
    if (parsed.type === '256' && parsed.index !== undefined) {
      const idx = parsed.index;
      if (idx >= 16 && idx <= 231) {
        const rgb = indexToRgb(idx);
        if (rgb) return rgb;
      } else if (idx >= 232 && idx <= 255) {
        const gray = 8 + (idx - 232) * 10;
        return { r: gray, g: gray, b: gray };
      } else if (idx >= 0 && idx <= 15) {
        const ansi16: Record<number, { r: number; g: number; b: number }> = {
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
        const c = ansi16[idx];
        if (c) return c;
      }
    } else if (parsed.type === 'basic' && parsed.index !== undefined) {
      const basic: Record<number, { r: number; g: number; b: number }> = {
        0: { r: 0,   g: 0,   b: 0   },
        1: { r: 170, g: 0,   b: 0   },
        2: { r: 0,   g: 170, b: 0   },
        3: { r: 170, g: 170, b: 0   },
        4: { r: 0,   g: 0,   b: 170 },
        5: { r: 170, g: 0,   b: 170 },
        6: { r: 0,   g: 170, b: 170 },
        7: { r: 170, g: 170, b: 170 },
      };
      const c = basic[parsed.index];
      if (c) return c;
    }
  }

  return { r: 148, g: 148, b: 148 };
}

/**
 * Compute the color for a given age within the trail window.
 *
 * age = 0              → full accent brightness (head just visited)
 * age = trailLen - 1   → 42 % brightness (dark floor of trail)
 * age >= trailLen      → clamped to dark floor
 *
 * easeIn power-curve 2.2 for perceptually even brightness distribution.
 * Saturation is boosted on the dark end (up to +20%) so the trail stays
 * vivid rather than going muddy as it dims.
 */
function ageToColor(
  hsl: { h: number; s: number; l: number },
  age: number,
  trailLen: number,
): { r: number; g: number; b: number } {
  const clamped = Math.min(age, trailLen - 1);
  const progress = clamped / Math.max(1, trailLen - 1); // 0.0 (bright) … 1.0 (dark)
  const linearFactor = 1 - progress;
  const curvedFactor = Math.pow(linearFactor, 2.2);       // easeIn

  const newL = hsl.l * (0.42 + 0.58 * curvedFactor);
  const newS = Math.min(1.0, hsl.s * (1.20 - 0.20 * curvedFactor));
  return hslToRgb(hsl.h, newS, newL);
}

/**
 * Compute head position and state given a frame counter and width.
 *
 * Returns { headPos, goingRight, isDwelling }
 * Constant duration: total period is fixed, speed scales with available width.
 */
function computeHeadState(frame: number, available: number): { headPos: number; goingRight: boolean; isDwelling: boolean } {
  const M = Math.max(1, available - 1);
  const D = DWELL_FRAMES;
  const halfPeriod = PERIOD_FRAMES / 2;
  const pos = frame % PERIOD_FRAMES;

  if (pos < D) {
    // Left dwell
    return { headPos: 0, goingRight: true, isDwelling: true };
  } else if (pos < halfPeriod) {
    // Traversing left→right
    const traverseFrames = halfPeriod - D;
    const progress = (pos - D) / traverseFrames;
    return { headPos: Math.floor(progress * M), goingRight: true, isDwelling: false };
  } else if (pos < halfPeriod + D) {
    // Right dwell
    return { headPos: M, goingRight: false, isDwelling: true };
  } else {
    // Traversing right→left
    const traverseFrames = PERIOD_FRAMES - (halfPeriod + D);
    const progress = (pos - (halfPeriod + D)) / traverseFrames;
    return { headPos: M - Math.floor(progress * M), goingRight: false, isDwelling: false };
  }
}

/**
 * Generate the head-trails gradient wave fill string for one frame.
 *
 * waveColors stores the waveFrame when each position was last visited by the
 * head.  On each call the head's current position is updated, and every
 * position is colored based on its decay age since the last head visit.
 *
 * updatedColors must be stored by the caller (panel.waveColors = updatedColors).
 *
 * @param theme      - current theme (provides accent colour)
 * @param waveFrame  - monotonically increasing frame counter
 * @param waveColors - previously returned updatedColors (or undefined on first call)
 * @param available  - number of characters to fill
 */
export function generateWaveFill(
  theme: Theme,
  waveFrame: number,
  waveColors: number[] | undefined,
  available: number
): { fill: string; updatedColors: number[] } {
  if (available <= 0) return { fill: '', updatedColors: [] };

  const base = getBaseAccentRgb(theme);
  const hsl = rgbToHsl(base.r, base.g, base.b);
  const resetFg = '\x1b[39m';

  // Trail length = ¾ of line width (at least 1)
  const trailLen = Math.max(1, Math.floor(available * 3 / 4));

  // Initialise or resize: place last-visit far enough in the past that all
  // positions start at the dark floor.
  if (!waveColors || waveColors.length !== available) {
    const neverVisited = waveFrame - trailLen;
    waveColors = Array(available).fill(neverVisited) as number[];
  }

  const { headPos, goingRight, isDwelling } = computeHeadState(waveFrame, available);

  // Paint the trail: we need to ensure every segment between the previous
  // frame's head and this frame's head is colored. This prevents "gaps" on
  // wide terminals where the head moves >1 char per frame.
  if (waveFrame > 0) {
    const prev = computeHeadState(waveFrame - 1, available);
    const start = Math.min(prev.headPos, headPos);
    const end = Math.max(prev.headPos, headPos);
    for (let i = start; i <= end; i++) {
      waveColors[i] = waveFrame;
    }
  } else {
    waveColors[headPos] = waveFrame;
  }

  // Directional head character: half-dash pointing in the direction of motion
  //   ╴ (U+2574, BOX DRAWINGS LIGHT LEFT)  while going left→right (connects to trail on left)
  //   ╶ (U+2576, BOX DRAWINGS LIGHT RIGHT) while going right→left (connects to trail on right)
  let headChar = goingRight ? '╴' : '╶';

  // Solid head when dwelling (no gap)
  if (isDwelling) {
    headChar = (headPos === 0) ? '╶' : '─';
  }

  // Ensure head doesn't point into space at index 0 when starting movement
  if (headPos === 0 && goingRight) {
    headChar = '╶';
  }

  // Special edge hit characters (1-frame impact) override solid head
  const halfPeriod = PERIOD_FRAMES / 2;
  const pos = waveFrame % PERIOD_FRAMES;

  if (pos === halfPeriod) {
    headChar = '╼'; // Hit right edge (LIGHT LEFT AND HEAVY RIGHT)
  } else if (pos === 0) {
    headChar = '╺'; // Hit left edge (HEAVY RIGHT)
  }

  // Build fill from per-position ages
  let fill = '';
  for (let i = 0; i < available; i++) {
    const lastVisit = waveColors[i] ?? (waveFrame - trailLen);
    const age = waveFrame - lastVisit;

    const rgb = ageToColor(hsl, age, trailLen);
    const color = `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;

    // Trail at index 0 should be rounded '╶' to match header style
    let char = (i === 0) ? '╶' : '─';
    if (i === headPos) char = headChar;

    fill += `${color}${char}${resetFg}`;
  }

  return { fill, updatedColors: waveColors };
}

