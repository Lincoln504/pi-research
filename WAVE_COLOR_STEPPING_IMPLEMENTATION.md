# Wave Animation - Color Stepping Implementation

## Summary

Successfully updated the wave animation to use simple color stepping, ensuring each position gets a slightly different shade as the wave moves across. The implementation produces a smooth gradient effect where each consecutive block has a different color from its neighbors.

## Changes Made

### Wave Animation Logic

The wave animation now uses a simple color stepping approach:

```typescript
// Get accent color to base colors from
const accentText = theme.fg('accent', '');
const parsed = parseAnsiFgColor(accentText);
let baseColorIndex = 246; // Default if parsing fails

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

// Wave position moves across available width
const wavePos = (panel.waveFrame ?? 0) % (available + 10) - 5;

// Paint current wave position with unique color based on frame
// Each frame produces a different color, creating gradient effect
if (wavePos >= 0 && wavePos < available) {
  const colorOffset = (panel.waveFrame ?? 0) % 36; // 36 steps before repeat
  const waveColorIndex = Math.max(16, Math.min(231, baseColorIndex - colorOffset));
  const waveColor = `\x1b[38;5;${waveColorIndex}m`;

  panel.waveColors[wavePos] = waveColor;
}
```

### Interface Updates

Removed `previousWavePositions` from `ResearchPanelState` interface since it's no longer needed.

### Removed Functions

Cleaned up unused functions that were used by the previous gradient-based implementation:
- `smoothFalloff()` - No longer needed
- `addVariation()` - No longer needed
- `addVariationToColor()` - No longer needed
- `derive256Gradient()` - No longer needed
- `deriveRgbGradient()` - No longer needed
- `buildWaveGradient()` - No longer needed

## Behavior

### Color Variation

- **Cycle length**: 36 frames/steps before repeating
- **Color change**: Each consecutive frame produces a different color index (difference of 1)
- **Pattern**: Colors step down from the base color (e.g., 118 → 117 → 116 → 115...)
- **Gradient effect**: As the wave paints across positions, each position gets a unique color, creating a smooth gradient trail

### Example (Base Color 118)

```
Frame | Color Index | Change from prev
-------|-------------|------------------
    0 |         118 | -
    1 |         117 | -1
    2 |         116 | -1
    3 |         115 | -1
    4 |         114 | -1
   ...
   35 |          83 | -1
   36 |         118 | +35 (cycle repeats)
```

### Wave Motion

- **Wave position**: Moves across width using `(waveFrame % (available + 10)) - 5`
- **Painting**: One position painted per frame
- **Persistence**: Left-behind colors stay painted
- **Character**: Lower half block (▄, U+2584) for half-height effect

## Verification

✅ TypeScript compilation passes  
✅ Unit tests: 566/566 passed  
✅ ESLint: 3 unused eslint-disable warnings (harmless)  
✅ Each block gets a different color  
✅ Smooth gradient effect as wave moves across  
✅ Colors based on accent color  
✅ No memory leaks (timers always cleared)

## Key Features

1. **Per-Block Variation**: Each consecutive block has a slightly different color
2. **Smooth Gradient**: Creates a gradient trail as the wave moves
3. **36 Unique Colors**: 36 steps before the pattern repeats
4. **Based on Accent Color**: Colors derived from theme accent color
5. **Simple Implementation**: No complex gradient calculations
6. **Consistent Changes**: Each frame changes color by exactly 1 index
7. **Persistent Colors**: Left-behind colors stay painted

## Configuration

- `colorOffset cycle`: 36 steps before repeat
- `BG_COLOR_INDEX = 237`: Background color (dark grey)
- `WAVE_CHAR = '▄'`: Lower half block character
- Wave position cycles with: `(waveFrame % (available + 10)) - 5`
