/**
 * Research Panel Color Utilities
 *
 * Color parsing, conversion, and gradient generation for wave animation.
 */

/**
 * Parse ANSI foreground color escape code to extract color index or RGB values.
 *
 * Returns:
 *   - { type: '256', index: N } for \x1b[38;5;Nm
 *   - { type: 'rgb', r, g, b } for \x1b[38;2;r;g;bm
 *   - { type: 'basic', index: N } for \x1b[30-37m
 *   - null if parse fails
 */
export function parseAnsiFgColor(
  ansiCode: string
): { type: '256' | 'rgb' | 'basic'; index?: number; r?: number; g?: number; b?: number } | null {
  // Match \x1b[38;5;N... (256-color)
  // eslint-disable-next-line no-control-regex
  const match256 = ansiCode.match(/\x1b\[38;5;(\d+)/);
  if (match256 && match256[1] !== undefined) {
    return { type: '256', index: parseInt(match256[1], 10) };
  }

  // Match \x1b[38;2;r;g;b... (truecolor)
  // eslint-disable-next-line no-control-regex
  const matchRgb = ansiCode.match(/\x1b\[38;2;(\d+);(\d+);(\d+)/);
  if (matchRgb && matchRgb[1] !== undefined && matchRgb[2] !== undefined && matchRgb[3] !== undefined) {
    return {
      type: 'rgb',
      r: parseInt(matchRgb[1], 10),
      g: parseInt(matchRgb[2], 10),
      b: parseInt(matchRgb[3], 10),
    };
  }

  // Match basic colors \x1b[30-37...
  // eslint-disable-next-line no-control-regex
  const matchBasic = ansiCode.match(/\x1b\[3([0-7])/);
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
export function rgbTo256(r: number, g: number, b: number): number {
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
  const grayR = GRAY_VALUES[minGrayIdx] ?? 0;
  const grayG = GRAY_VALUES[minGrayIdx] ?? 0;
  const grayB = GRAY_VALUES[minGrayIdx] ?? 0;
  const grayDist = colorDistance(r, g, b, grayR, grayG, grayB);

  // Prefer cube if not essentially grayscale (low saturation)
  const maxDist = Math.max(cubeDist, grayDist);
  if (maxDist === 0) return cubeIndex;
  const saturation = cubeDist / maxDist;

  // If very low saturation, prefer grayscale; otherwise prefer cube
  return saturation < 0.15 ? grayIndex : cubeIndex;
}

/**
 * Convert 256-color index to RGB values.
 *
 * @param index - 256-color index (0-255)
 * @returns RGB values or null if index is invalid
 */
export function indexToRgb(index: number): { r: number; g: number; b: number } | null {
  if (index < 0 || index > 255) return null;

  // Basic colors (0-7)
  if (index < 8) {
    const BASIC_COLORS: [number, number, number][] = [
      [0, 0, 0],      // 0: black
      [128, 0, 0],    // 1: red
      [0, 128, 0],    // 2: green
      [128, 128, 0],  // 3: yellow
      [0, 0, 128],    // 4: blue
      [128, 0, 128],  // 5: magenta
      [0, 128, 128],  // 6: cyan
      [192, 192, 192], // 7: white
    ];
    const color = BASIC_COLORS[index];
    return color ? { r: color[0], g: color[1], b: color[2] } : null;
  }

  // High-intensity colors (8-15)
  if (index < 16) {
    const HIGH_COLORS: [number, number, number][] = [
      [128, 128, 128], // 8: bright black (gray)
      [255, 0, 0],     // 9: bright red
      [0, 255, 0],     // 10: bright green
      [255, 255, 0],   // 11: bright yellow
      [0, 0, 255],     // 12: bright blue
      [255, 0, 255],   // 13: bright magenta
      [0, 255, 255],   // 14: bright cyan
      [255, 255, 255], // 15: bright white
    ];
    const highIndex = index - 8;
    const color = HIGH_COLORS[highIndex];
    return color ? { r: color[0], g: color[1], b: color[2] } : null;
  }

  // 6×6×6 color cube (16-231)
  if (index < 232) {
    const cubeIndex = index - 16;
    const rIdx = Math.floor(cubeIndex / 36) % 6;
    const gIdx = Math.floor(cubeIndex / 6) % 6;
    const bIdx = cubeIndex % 6;

    const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
    return {
      r: CUBE_VALUES[rIdx] ?? 0,
      g: CUBE_VALUES[gIdx] ?? 0,
      b: CUBE_VALUES[bIdx] ?? 0,
    };
  }

  // Grayscale ramp (232-255)
  const grayIndex = index - 232;
  const grayValue = 8 + grayIndex * 10;
  return { r: grayValue, g: grayValue, b: grayValue };
}

/**
 * Convert RGB to HSL
 */
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }

  return { h: h * 360, s, l };
}

/**
 * Convert HSL to RGB
 */
export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h /= 360;

  let r: number;
  let g: number;
  let b: number;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

/**
 * Apply easing curve to a value (0-1)
 */
export function applyCurve(t: number, curve: number): number {
  return curve === 1 ? t : Math.pow(t, curve);
}

/**
 * Cycle HSL saturation and lightness for gradient generation.
 *
 * Sawtooth wave: stepIndex=0 → full brightness → stepIndex→totalSteps → 65% brightness.
 * Saturation barely moves (98%→100%). Only lightness varies, so the hue is preserved.
 * An easeIn curve (power 2.2) spreads frames perceptually: bright drops fast,
 * mid-dark range gets more dwell time.
 */
export function cycleHslSaturationLightness(
  baseR: number,
  baseG: number,
  baseB: number,
  stepIndex: number,
  totalSteps: number
): { r: number; g: number; b: number } {
  const hsl = rgbToHsl(baseR, baseG, baseB);

  // Sawtooth: progress 0→1 over the cycle, then snaps back
  const progress = (stepIndex % totalSteps) / totalSteps;
  const linearFactor = 1 - progress; // 1.0 (bright) → 0.0 (dark)

  // easeIn (2.2): fast initial brightness drop, slow approach to dark end —
  // perceptually even spacing across the brightness range
  const curvedFactor = Math.pow(linearFactor, 2.2);

  // Lightness: 100% of base (bright) → 65% of base (dark)
  const newL = hsl.l * (0.65 + 0.35 * curvedFactor);
  // Saturation: minimal movement (98% → 100%), preserves hue identity
  const newS = hsl.s * (0.98 + 0.02 * curvedFactor);

  return hslToRgb(hsl.h, newS, newL);
}

/**
 * Smooth exponential falloff for gradient generation.
 *
 * t = 0 → 1.0 (bright, at head)
 * t = 1 → 0.0 (dark, far from head)
 * power = 0.7 → stays bright longer before falling off
 */
export function smoothFalloff(t: number, power: number = 0.7): number {
  return Math.pow(1 - t, power);
}

/**
 * Add variation to a value for gradient generation
 */
export function addVariation(index: number, maxVariation: number = 1): number {
  return index + Math.sin(index * 0.5) * maxVariation;
}

/**
 * Derive a 256-color gradient from a base color index.
 *
 * This is the main entry point for generating wave animation colors.
 */
export function derive256Gradient(baseIndex: number, steps: number): string[] {
  const colors: string[] = [];

  // Parse base color to RGB
  const baseRgb = indexToRgb(baseIndex);
  if (!baseRgb) {
    // Fallback to a simple gradient if base color is invalid
    for (let i = 0; i < steps; i++) {
      colors.push(`\x1b[38;5;${Math.floor((i / steps) * 255)}m`);
    }
    return colors;
  }

  // Generate gradient by cycling through HSL variations
  for (let i = 0; i < steps; i++) {
    const rgb = cycleHslSaturationLightness(baseRgb.r, baseRgb.g, baseRgb.b, i, steps);
    const index256 = rgbTo256(rgb.r, rgb.g, rgb.b);
    colors.push(`\x1b[38;5;${index256}m`);
  }

  return colors;
}

/**
 * Derive an RGB color gradient from base RGB values.
 */
export function deriveRgbGradient(r: number, g: number, b: number, steps: number): string[] {
  const colors: string[] = [];

  for (let i = 0; i < steps; i++) {
    const rgb = cycleHslSaturationLightness(r, g, b, i, steps);
    colors.push(`\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`);
  }

  return colors;
}

// Export internal functions for testing (with _ prefix for internal use)
export const _rgbTo256 = rgbTo256;
export const _indexToRgb = indexToRgb;
export const _rgbToHsl = rgbToHsl;
export const _hslToRgb = hslToRgb;
export const _parseAnsiFgColor = parseAnsiFgColor;
export const _derive256Gradient = derive256Gradient;
export const _deriveRgbGradient = deriveRgbGradient;