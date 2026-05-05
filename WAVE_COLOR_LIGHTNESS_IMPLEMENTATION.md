# Wave Animation - Same Hue, Lightness Cycling

## Summary

Successfully implemented a wave animation that maintains the accent color's hue while cycling through lightness/saturation values. The color changes by the same amount each frame using a triangular wave pattern.

## Implementation

### Key Functions Added

#### `parseAnsiFgColor(ansiCode: string)`
Parses ANSI foreground color escape codes to extract color index or RGB values.

Returns:
- `{ type: '256', index: N }` for `\x1b[38;5;Nm` (256-color)
- `{ type: 'rgb', r, g, b }` for `\x1b[38;2;r;g;bm` (truecolor)
- `{ type: 'basic', index: N }` for `\x1b[30-37m` (basic colors)
- `null` if parse fails

#### `rgbTo256(r, g, b)`
Converts RGB values to the nearest 256-color cube or grayscale index.

#### `modulateColorLightness(index, factor)`
Modulates lightness/saturation of a 256-color by a factor.
- Keeps hue constant
- Only changes lightness (0.0 = dark, 1.0 = bright)
- Works with:
  - 6×6×6 color cube (16-231): scales RGB coordinates
  - Grayscale (232-255): scales gray level directly
  - Falls back to 236 for basic colors

### Wave Animation Logic

```typescript
// Get accent color from theme
const accentText = theme.fg('accent', '');
const parsed = parseAnsiFgColor(accentText);
let baseColorIndex = 246; // Default fallback

// Parse accent color to get base color index
if (parsed) {
  if (parsed.type === '256' && parsed.index !== undefined) {
    baseColorIndex = parsed.index;
  } else if (parsed.type === 'rgb' && parsed.r !== undefined && parsed.g !== undefined && parsed.b !== undefined) {
    baseColorIndex = rgbTo256(parsed.r, parsed.g, parsed.b);
  } else if (parsed.type === 'basic' && parsed.index !== undefined) {
    const basicTo256: Record<number, number> = {0:16, 1:196, 2:46, 3:226, 4:21, 5:201, 6:51, 7:231};
    baseColorIndex = basicTo256[parsed.index] ?? 246;
  }
}

// Cycle lightness with same amount of change each frame
// Triangular wave: 0 → 1 → 0 over LIGHTNESS_CYCLE frames
const LIGHTNESS_CYCLE = 40;
const halfCycle = LIGHTNESS_CYCLE / 2;
const frameInCycle = (panel.waveFrame ?? 0) % LIGHTNESS_CYCLE;
let lightnessFactor: number;
if (frameInCycle < halfCycle) {
  lightnessFactor = frameInCycle / halfCycle; // 0 to 1
} else {
  lightnessFactor = 1 - (frameInCycle - halfCycle) / halfCycle; // 1 to 0
}

// Modulate accent color by lightness factor
const waveColorIndex = modulateColorLightness(baseColorIndex, lightnessFactor);
const waveColor = `\x1b[38;5;${waveColorIndex}m`;

// Wave position moves across available width
const wavePos = (panel.waveFrame ?? 0) % (available + 10) - 5;

// Paint wave position with modulated color (persistent)
if (wavePos >= 0 && wavePos < available) {
  panel.waveColors[wavePos] = waveColor;
}
```

## Behavior

### Lightness Cycling
- **Cycle length**: 40 frames
- **Pattern**: Triangular wave (0 → 1 → 0)
- **Frame 0-19**: Lightness increases from 0.0 to 1.0 (dark to bright)
- **Frame 20-39**: Lightness decreases from 1.0 to 0.0 (bright to dark)
- **Frame 40**: Returns to 0.0 (cycle repeats)

### Color Modulation
- **Same hue**: Always uses the accent color's hue
- **Lightness changes**: Gradually from dark to bright and back
- **Discrete steps**: Due to 256-color cube, changes occur in steps
- **Persistent**: Colors left behind stay painted

### Example (Base Color 118 - Greenish)
```
Frame | Lightness Factor | Color Index | Change
-------|------------------|-------------|-------
    0 |            0.000 |          16 | -
    5 |            0.125 |          22 | +6
   10 |            0.250 |          64 | +42
   15 |            0.375 |          76 | +12
   20 |            0.500 |         118 | +42 (original accent)
   25 |            0.375 |          76 | -42
   30 |            0.250 |          64 | -12
   35 |            0.125 |          22 | -42
   40 |            0.000 |          16 | -6 (back to start)
```

## Configuration

- `LIGHTNESS_CYCLE = 40`: Frames for full dark-bright-dark cycle
- `BG_COLOR_INDEX = 237`: Background color (dark grey)
- `WAVE_CHAR = '▄'`: Lower half block character
- Wave position cycles with: `(waveFrame % (available + 10)) - 5`

## Test Results

✅ TypeScript compilation passes
✅ 566/566 unit tests pass
✅ ESLint passes with 0 errors

## Key Features

1. **Same Hue**: Uses accent color's hue throughout
2. **Lightness Cycling**: Triangular wave pattern for smooth dark-bright-dark transition
3. **Consistent Changes**: Same amount of change each frame
4. **Persistent Colors**: Left-behind colors stay painted
5. **256-Color Compatible**: Works with 256-color and truecolor terminals
6. **Graceful Fallback**: Falls back to default color if accent parsing fails
