# Wave Animation - Lightness Cycle Implementation

## Summary

Successfully implemented a lightness-cycling wave animation for the pi-research TUI header. The animation now uses a single color that cycles through brightness values while maintaining the accent color's hue. The color changes by a consistent amount each frame using modulo-based linear progression (triangular wave), instead of the previous smooth cosine wave cycling.

## Changes Made

### 1. New Lightness Cycle Functions (src/tui/research-panel.ts)

Replaced gradient functions with lightness modulation functions:

```typescript
/**
 * Get lightness factor with linear progression.
 * Returns a factor 0.0 (dark) to 1.0 (bright) based on frame.
 * Same amount of change each frame using modulo.
 */
function cycleLightness(position: number, cycleLength: number): number {
  // Linear progression: 0 → 1 → 0 (triangular wave)
  // First half: 0 to 1, second half: 1 to 0
  const half = cycleLength / 2;
  const halfPosition = position % cycleLength;
  if (halfPosition < half) {
    return halfPosition / half; // 0 to 1
  } else {
    return 1 - (halfPosition - half) / half; // 1 to 0
  }
}
```

**Key characteristics:**
- **Linear progression**: Each frame changes lightness by the same amount
- **Triangular wave**: 0 → 1 → 0 (ramp up, then ramp down)
- **Modulo-based**: Cycles predictably using `% cycleLength`
- **Consistent increments**: Frame 0=0, 1=0.05, 2=0.1, ..., 20=1, 21=0.975, ...

/**
 * Modulate lightness of a 256-color by a factor.
 * Returns a new color index with same hue but adjusted lightness.
 */
function modulateLightness(index: number, factor: number): number {
  if (index >= 16 && index <= 231) {
    // 6×6×6 color cube - scale lightness while keeping hue
    const n = index - 16;
    const r0 = Math.floor(n / 36);
    const g0 = Math.floor((n % 36) / 6);
    const b0 = n % 6;
    const r = Math.round(r0 * factor);
    const g = Math.round(g0 * factor);
    const b = Math.round(b0 * factor);
    return 16 + 36 * r + 6 * g + b;
  } else if (index >= 232 && index <= 255) {
    // Grayscale - scale directly
    const gray = index - 232;
    return 232 + Math.round(gray * factor);
  } else {
    return 236;
  }
}
```

### 2. Removed Gradient Functions

Deleted the following functions (no longer needed):
- `smoothFalloff()` - Exponential falloff for gradient
- `addVariation()` - Random variation for gradient tail
- `addVariationToColor()` - Random variation for left-behind trail
- `derive256Gradient()` - Build gradient from 256-color
- `deriveRgbGradient()` - Build gradient from RGB
- `buildGradientFromColor()` - Build gradient from ANSI color code

### 3. New Wave Rendering Logic

The wave animation now:
- Gets the accent color from the theme
- Cycles lightness using a 40-frame cycle (bright → dark → bright)
- Modulates the accent color by the current lightness factor
- Paints a single position with the modulated color
- Leaves colors behind (persistent)

Key implementation:
```typescript
// Get accent color to base hue from
const accentText = theme.fg('accent', '');
const parsed = parseAnsiFgColor(accentText);
let baseColorIndex = 246; // Default if parsing fails

if (parsed) {
  if (parsed.type === '256' && parsed.index !== undefined) {
    baseColorIndex = parsed.index;
  } else if (parsed.type === 'rgb' && parsed.r !== undefined) {
    baseColorIndex = rgbTo256(parsed.r, parsed.g, parsed.b);
  } else if (parsed.type === 'basic' && parsed.index !== undefined) {
    const basicTo256: Record<number, number> = {0:16, 1:196, 2:46, 3:226, 4:21, 5:201, 6:51, 7:231};
    baseColorIndex = basicTo256[parsed.index] ?? 246;
  }
}

// Wave position moves across available width
const wavePos = (panel.waveFrame ?? 0) % (available + 10) - 5;

// Update wave color - single color modulated by lightness cycle
const lightness = cycleLightness(panel.waveFrame ?? 0, LIGHTNESS_CYCLE);
const waveColorIndex = modulateLightness(baseColorIndex, lightness);
const waveColor = `\x1b[38;5;${waveColorIndex}m`;

// Paint wave position with modulated color
// Leave color behind (persistent)
if (wavePos >= 0 && wavePos < available) {
  panel.waveColors[wavePos] = waveColor;
}
```

### 4. Updated Interface (ResearchPanelState)

Removed:
```typescript
previousWavePositions?: Set<number>;
```

This is no longer needed since we don't track gradient trail positions anymore.

### 5. Updated src/tool.ts

Removed cleanup of `previousWavePositions` in the `onSearchComplete` callback.

### 6. Updated Tests

Removed references to `previousWavePositions` from test assertions.

## Behavior Changes

### Before
- Wave cycled through all 256-color cube colors (16-255)
- Created a gradient trail from bright to dark
- Left-behind trail used random variation
- Smooth cosine wave for lightness cycling
- Could produce pink/random colors due to cycling through all hues

### After
- Wave cycles through lightness values (0.0 to 1.0) of a single color
- Uses theme's accent color as the base hue
- Linear progression with modulo (triangular wave: 0 → 1 → 0)
- **Same amount of color change each frame**
- Predictable, even increments using modulo arithmetic
- Leaves modulated color behind (persistent)
- Maintains consistent hue throughout the animation
- No random colors - all colors are derived from the accent color

## Test Results

All tests pass:
- ✅ TypeScript compilation passes
- ✅ 566/566 unit tests pass
- ✅ ESLint passes (3 unused eslint-disable warnings, which are unrelated)

## Configuration Constants

- `LIGHTNESS_CYCLE = 40` - Frames for full bright-dark-bright cycle
- `BG_COLOR_INDEX = 237` - Background color (dark grey)
- `WAVE_CHAR = '▄'` - Lower half block character
- Wave position cycles with modulo: `(waveFrame % (available + 10)) - 5`

## Key Features

1. **Single Color**: The wave uses only one color (derived from accent)
2. **Lightness Cycling**: Brightness cycles smoothly using cosine wave
3. **Hue Preservation**: The accent color's hue is maintained
4. **Persistent Trail**: Colors left behind stay painted
5. **256-Color Compatible**: Works with both 256-color and truecolor terminals
6. **Graceful Fallback**: Falls back to default color (246) if accent parsing fails
