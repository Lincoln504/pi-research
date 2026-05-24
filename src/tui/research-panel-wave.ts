/**
 * Research Panel Wave Animation
 *
 * Handles the wave animation logic for the research panel header.
 */

import type { Theme } from './research-panel-types.ts';
import { parseAnsiFgColor, indexToRgb, cycleHslSaturationLightness } from './research-panel-color-utils.ts';

/**
 * Get base RGB color from theme accent color
 */
function getBaseAccentRgb(theme: Theme): { r: number; g: number; b: number } | null {
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

  return baseAccentRgb;
}

/**
 * Generate wave animation fill string
 * Returns both the fill string and the updated waveColors array
 */
export function generateWaveFill(
  theme: Theme,
  waveFrame: number,
  waveColors: string[] | undefined,
  available: number
): { fill: string; updatedColors: string[] } {
  const baseAccentRgb = getBaseAccentRgb(theme);
  const resetFg = '\x1b[39m';

  const CYCLE_STEPS = 16;

  // Compute brightest/darkest colors before initializing waveColors
  // so the initial fill is accent-colored, not grey
  const brightRgb = cycleHslSaturationLightness(baseAccentRgb!.r, baseAccentRgb!.g, baseAccentRgb!.b, 0, CYCLE_STEPS);
  const brightColor = `\x1b[38;2;${brightRgb.r};${brightRgb.g};${brightRgb.b}m`;


  if (!waveColors || waveColors.length !== available) {
    waveColors = Array(available).fill(brightColor) as string[];
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
  // ~87% speed: 30% faster than 2/3 pace (advance wave position 0.87 steps every frame)
  const waveSlowFrame = Math.floor(waveFrame * 0.87);
  const waveRawPos = waveSlowFrame % wavePeriod;

  // Paint trail color for current head position (persisted for gradient tail)
  if (waveRawPos < available) {
    const stepIndex = waveSlowFrame % CYCLE_STEPS;
    const waveRgb = cycleHslSaturationLightness(baseAccentRgb!.r, baseAccentRgb!.g, baseAccentRgb!.b, stepIndex, CYCLE_STEPS);
    waveColors[waveRawPos] = `\x1b[38;2;${waveRgb.r};${waveRgb.g};${waveRgb.b}m`;
  }

  // Build fill: ╶ lead-in | ─ trail | ┄ head | ─ background
  let fill = '';
  for (let i = 0; i < available; i++) {
    if (i === waveRawPos) {
      fill += `${waveColors[i] || brightColor}┄${resetFg}`;
    } else {
      const bgChar = i === 0 ? '╶' : '─';
      fill += `${waveColors[i] || brightColor}${bgChar}${resetFg}`;
    }
  }

  return { fill, updatedColors: waveColors };
}