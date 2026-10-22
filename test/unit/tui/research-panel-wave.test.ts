import { describe, it, expect } from 'vitest';
import { generateWaveFill } from '../../../src/tui/research-panel-wave.ts';
import type { Theme } from '../../../src/types/research-panel-types.ts';

const rgbTheme = { fg: (_c: string, t: string) => `\x1b[38;2;80;160;240m${t}\x1b[39m` } as unknown as Theme;
// A theme whose accent cannot be parsed must degrade, never throw.
const brokenTheme = { fg: (_c: string, t: string) => t } as unknown as Theme;

// Strip SGR sequences, leaving the glyphs the user sees.
const glyphs = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('generateWaveFill', () => {
  it('returns an empty fill for a non-positive width', () => {
    expect(generateWaveFill(rgbTheme, 5, undefined, 0)).toEqual({ fill: '', updatedColors: [] });
    expect(generateWaveFill(rgbTheme, 5, undefined, -3)).toEqual({ fill: '', updatedColors: [] });
  });

  it('renders exactly `available` cells for every width and frame across two full periods', () => {
    for (const width of [1, 2, 3, 10, 79, 80, 200]) {
      let colors: number[] | undefined;
      for (let frame = 0; frame < 200; frame++) {
        const r = generateWaveFill(rgbTheme, frame, colors, width);
        colors = r.updatedColors;
        expect(glyphs(r.fill).length, `width ${width} frame ${frame}`).toBe(width);
        expect(colors).toHaveLength(width);
        expect(r.fill, `width ${width} frame ${frame}`).not.toMatch(/NaN|undefined|Infinity/);
      }
    }
  });

  it('keeps every colour channel inside 0-255', () => {
    let colors: number[] | undefined;
    for (let frame = 0; frame < 150; frame++) {
      const r = generateWaveFill(rgbTheme, frame, colors, 60);
      colors = r.updatedColors;
      for (const m of r.fill.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)) {
        for (const ch of [m[1], m[2], m[3]]) expect(Number(ch)).toBeGreaterThanOrEqual(0);
        for (const ch of [m[1], m[2], m[3]]) expect(Number(ch)).toBeLessThanOrEqual(255);
      }
    }
  });

  it('resets the trail when the width changes instead of indexing a stale array', () => {
    const a = generateWaveFill(rgbTheme, 20, undefined, 80);
    const b = generateWaveFill(rgbTheme, 21, a.updatedColors, 40);
    expect(b.updatedColors).toHaveLength(40);
    expect(glyphs(b.fill)).toHaveLength(40);
  });

  it('draws the edge-impact glyphs on the left and right edge frames', () => {
    // Frame 0 hits the left edge; half the period (49) hits the right edge.
    expect(glyphs(generateWaveFill(rgbTheme, 0, undefined, 40).fill)[0]).toBe('╺');
    expect(glyphs(generateWaveFill(rgbTheme, 49, undefined, 40).fill)[39]).toBe('╼');
  });

  it('survives an unparseable accent colour and a very large frame counter', () => {
    expect(() => generateWaveFill(brokenTheme, 3, undefined, 30)).not.toThrow();
    const r = generateWaveFill(rgbTheme, Number.MAX_SAFE_INTEGER - 1, undefined, 30);
    expect(glyphs(r.fill)).toHaveLength(30);
  });
});
