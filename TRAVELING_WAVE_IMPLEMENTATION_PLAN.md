# Traveling Wave Animation for Search Progress - Implementation Plan

## Executive Summary

This plan details the implementation of a traveling comet/scan-line animation for the pi-research TUI header during active searching phases. The animation replaces the static fill pattern with a dynamic wave effect that moves left-to-right across the available width, with a gradient trail based on the theme's accent color.

## Investigation Findings

### Architecture Overview

1. **TUI Rendering System**
   - `render()` is called only on explicit state-change events, not on a timer
   - `debouncedRefresh()` triggers re-renders via `refreshAllSessions()`
   - Default debounce is 10ms (`TUI_REFRESH_DEBOUNCE_MS`)
   - Theme colors are applied via `theme.fg(color, text)` which returns ANSI escape codes
   - ANSI 256-color codes: `\x1b[38;5;Nm` (foreground), `\x1b[48;5;Nm` (background)
   - Truecolor codes: `\x1b[38;2;r;g;bm` (foreground), `\x1b[48;2;r;g;bm` (background)
   - `visibleWidth()` and `truncateToWidth()` correctly handle ANSI codes

2. **Theme System** (`/home/ldeen/.config/nvm/versions/node/v25.8.2/lib/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js`)
   - Theme stores resolved ANSI codes in Maps (`fgColors`, `bgColors`)
   - `theme.fg(color, text)` returns: `${ansiCode}${text}\x1b[39m` (reset foreground)
   - `theme.getFgAnsi(color)` returns just the ANSI code without text wrapper
   - Supports truecolor and 256color modes
   - 256-color cube: indices 16-231 (6×6×6 RGB cube)
   - Grayscale ramp: indices 232-255 (24 grays from 8 to 238)
   - Basic colors: 0-15 (terminal-dependent)

3. **Search State Management** (`src/tool.ts`)
   - `isSearching` toggled in observer callbacks:
     - `onSearchStart()` → `isSearching = true`
     - `onSearchComplete()` → `isSearching = false`
   - `debouncedRefresh()` called after state changes
   - Cleanup function handles abort scenarios

4. **TUI Panel State** (`src/tui/research-panel.ts`)
   - `ResearchPanelState` interface contains:
     - `isSearching?: boolean` - current searching state
     - No animation state currently
   - Header rendered in `createMasterResearchPanel()` with static pattern

### Key Files to Modify

1. **src/tui/research-panel.ts**
   - Add `waveFrame?: number` to `ResearchPanelState` interface
   - Create `buildWaveGradient()` function for color gradient generation
   - Replace static fill in header rendering with wave animation logic

2. **src/tool.ts**
   - Add animation timer variable
   - Start timer in `onSearchStart()`
   - Stop timer in `onSearchComplete()` and cleanup

## Detailed Implementation Plan

### Phase 1: Interface and State Changes

#### 1.1 Update ResearchPanelState Interface

**File:** `src/tui/research-panel.ts`

```typescript
export interface ResearchPanelState {
  sessionId: string;
  researchId: string;
  query: string;
  totalTokens: number;
  totalCost: number;
  slices: Map<string, SliceState>;
  modelName: string;
  isSearching?: boolean;
  progress?: ResearchProgress;
  statusMessage?: string;
  // NEW: Animation frame counter for traveling wave
  waveFrame?: number;
}
```

### Phase 2: Color Gradient Builder

#### 2.1 ANSI Color Parsing Utilities

**File:** `src/tui/research-panel.ts`

Add helper functions to extract color information from ANSI codes:

```typescript
/**
 * Parse ANSI foreground color escape code to extract color index or RGB values
 *
 * Returns:
 *   - { type: '256', index: N } for \x1b[38;5;Nm
 *   - { type: 'rgb', r, g, b } for \x1b[38;2;r;g;bm
 *   - { type: 'basic', index: N } for \x1b[30-37m
 *   - null if parse fails
 */
function parseAnsiFgColor(ansiCode: string): { type: '256' | 'rgb' | 'basic', index?: number, r?: number, g?: number, b?: number } | null {
  // Match \x1b[38;5;Nm (256-color)
  const match256 = ansiCode.match(/\x1b\[38;5;(\d+)m/);
  if (match256) {
    return { type: '256', index: parseInt(match256[1], 10) };
  }

  // Match \x1b[38;2;r;g;bm (truecolor)
  const matchRgb = ansiCode.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
  if (matchRgb) {
    return {
      type: 'rgb',
      r: parseInt(matchRgb[1], 10),
      g: parseInt(matchRgb[2], 10),
      b: parseInt(matchRgb[3], 10)
    };
  }

  // Match basic colors \x1b[30-37m
  const matchBasic = ansiCode.match(/\x1b\[(3[0-7])m/);
  if (matchBasic) {
    return { type: 'basic', index: parseInt(matchBasic[1], 10) - 30 };
  }

  return null;
}

/**
 * Convert RGB to nearest 256-color cube or grayscale index
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
      const dist = Math.abs(value - CUBE_VALUES[i]);
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
  const cubeR = CUBE_VALUES[rIdx];
  const cubeG = CUBE_VALUES[gIdx];
  const cubeB = CUBE_VALUES[bIdx];

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
    const dist = Math.abs(gray - GRAY_VALUES[i]);
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
 * Derive gradient colors from a base 256-color index
 *
 * For 256-color cube (16-231):
 *   n = index - 16
 *   r = floor(n/36), g = floor((n%36)/6), b = n%6 (each 0-5)
 *   Scale each component toward 0 for each gradient step
 *
 * For grayscale (232-255):
 *   Scale (index - 232) toward 0
 *
 * Returns array of ANSI escape codes for foreground colors
 */
function derive256Gradient(baseIndex: number, steps: number): string[] {
  const gradient: string[] = [];

  if (baseIndex >= 16 && baseIndex <= 231) {
    // 6×6×6 color cube
    const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
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
    const graySteps = Math.max(2, Math.min(steps, GRAY_START - GRAY_END));

    for (let step = 0; step < steps; step++) {
      const factor = step / (steps - 1); // 0.0 to 1.0
      const gray = Math.round(GRAY_START - factor * (GRAY_START - GRAY_END));
      gradient.push(`\x1b[38;5;${gray}m`);
    }
  }

  return gradient;
}

/**
 * Derive gradient colors from RGB values
 *
 * Scales each channel toward 0 and converts to nearest 256-color
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
```

#### 2.2 Main Gradient Builder Function

**File:** `src/tui/research-panel.ts`

```typescript
/**
 * Build wave gradient colors from theme accent color
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
 *   Returns gray gradient (244 down to 234) if accent color cannot be parsed
 */
function buildWaveGradient(theme: Theme, steps: number): string[] {
  // Get the raw ANSI code for accent color
  const accentAnsi = theme.getFgAnsi('accent');

  // Parse the ANSI code to extract color information
  const parsed = parseAnsiFgColor(accentAnsi);

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

    case 'basic':
      // Basic ANSI colors - map to approximate 256-color indices
      const basicTo256: Record<number, number> = {
        0: 16,   // black
        1: 196,  // red
        2: 46,   // green
        3: 226,  // yellow
        4: 21,   // blue
        5: 201,  // magenta
        6: 51,   // cyan
        7: 231,  // white
      };
      const mappedIndex = basicTo256[parsed.index!] ?? 244;
      return derive256Gradient(mappedIndex, steps);

    default:
      // Fallback
      return Array.from({ length: steps }, (_, i) => {
        const gray = Math.round(244 - (i / (steps - 1)) * 10);
        return `\x1b[38;5;${Math.max(234, gray)}m`;
      });
  }
}
```

### Phase 3: Wave Rendering Logic

#### 3.1 Update Header Rendering

**File:** `src/tui/research-panel.ts`

In `createMasterResearchPanel()`, replace the static fill logic:

```typescript
// Current code (lines ~382-397 in original):
if (panel.isSearching) {
  const currentWidth = visibleWidth(headerLine);
  const targetWidth = width - 1;
  const available = targetWidth - (currentWidth + 2);
  if (available > 0) {
    const pattern = 'ˍ＿';
    const pWidth = visibleWidth(pattern);
    const count = Math.floor(available / pWidth);
    let fill = pattern.repeat(count);
    const remaining = available % pWidth;
    if (remaining >= 1) fill += 'ˍ';
    headerLine += '  ' + theme.fg('accent', fill);
  }
}

// NEW CODE:
if (panel.isSearching) {
  const currentWidth = visibleWidth(headerLine);
  const targetWidth = width - 1;
  const available = targetWidth - (currentWidth + 2);

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
        const color = gradient[distFromPeak];
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
    const remaining = available % pWidth;
    if (remaining >= 1) fill += 'ˍ';
    headerLine += '  ' + theme.fg('accent', fill);
  }
}
```

### Phase 4: Animation Timer Management

#### 4.1 Add Timer Variables to tool.ts

**File:** `src/tool.ts`

In the `execute()` function, before the observer is defined:

```typescript
// Add after line ~148 (after const researchRunId = createResearchRunId();)
let waveTimer: ReturnType<typeof setInterval> | null = null;
```

#### 4.2 Start Timer on Search Start

**File:** `src/tool.ts`

In the `onSearchStart` observer callback:

```typescript
onSearchStart: () => {
  // ... existing slice logic ...

  panelState.isSearching = true;

  // NEW: Start wave animation timer
  panelState.waveFrame = 0;
  if (waveTimer) clearInterval(waveTimer);
  waveTimer = setInterval(() => {
    if (!panelState.isSearching) {
      clearInterval(waveTimer!);
      waveTimer = null;
      return;
    }
    panelState.waveFrame = (panelState.waveFrame ?? 0) + 1;
    debouncedRefresh();
  }, 80); // 80ms = 12.5 FPS

  debouncedRefresh();
},
```

#### 4.3 Stop Timer on Search Complete

**File:** `src/tool.ts`

In the `onSearchComplete` observer callback:

```typescript
onSearchComplete: () => {
  panelState.isSearching = false;

  // NEW: Stop wave animation timer
  if (waveTimer) {
    clearInterval(waveTimer);
    waveTimer = null;
  }
  panelState.waveFrame = undefined;

  // ... existing slice completion logic ...
  debouncedRefresh();
},
```

#### 4.4 Cleanup Timer on Abort

**File:** `src/tool.ts`

In the cleanup function (after line ~174, in the `signal?.addEventListener` block and the try-catch error handler):

```typescript
cleanup = () => {
  if (cleanup === null) return;
  cleanup = null;

  // NEW: Clear wave timer
  if (waveTimer) {
    clearInterval(waveTimer);
    waveTimer = null;
  }

  if (unsubOrder) unsubOrder();
  if (unsubInput) { unsubInput(); unsubInput = null; }
  // ... rest of existing cleanup logic ...
};
```

### Phase 5: Edge Cases and Validation

#### 5.1 Edge Case Handling

The implementation handles these edge cases:

1. **waveFrame undefined**: Falls back to static fill pattern
2. **available <= 0**: No fill rendered (same as current behavior)
3. **TRAIL_LEN > available**: Wave still works with fewer visible gradient steps
4. **Timer fires after isSearching goes false**: Guarded by `if (!panelState.isSearching)` check inside interval
5. **Multiple concurrent searches**: Single timer per tool execution, cleared and restarted on each new search start
6. **Memory leaks**: Timer handle stored in local variable, always cleared in cleanup paths
7. **Theme color parse failures**: Falls back to gray gradient (244 down to 234)
8. **Truecolor terminals**: RGB values converted to nearest 256-color index for compatibility

#### 5.2 Performance Considerations

1. **Animation frame rate**: 80ms interval = 12.5 FPS
   - Balance between smoothness and CPU usage
   - Adjustable via constant if needed

2. **Gradient caching**: Gradient is rebuilt on each render
   - Acceptable since gradient computation is lightweight
   - Could be cached with waveFrame as key if performance issues arise

3. **Debounce interaction**: Animation timer calls `debouncedRefresh()`
   - Debounce default (10ms) is shorter than animation interval (80ms)
   - Most frames should render promptly

4. **Memory**: No growing data structures
   - `waveFrame` is a simple number counter
   - `waveTimer` is single interval handle

### Phase 6: Testing Strategy

#### 6.1 Unit Tests

**File:** `test/tui/research-panel.test.ts` (new file)

```typescript
import { buildWaveGradient, parseAnsiFgColor, rgbTo256, derive256Gradient } from '../src/tui/research-panel.ts';
import type { Theme } from '../src/tui/research-panel.ts';

describe('Wave Animation', () => {
  describe('parseAnsiFgColor', () => {
    it('should parse 256-color ANSI codes', () => {
      const result = parseAnsiFgColor('\x1b[38;5;39m');
      expect(result).toEqual({ type: '256', index: 39 });
    });

    it('should parse truecolor ANSI codes', () => {
      const result = parseAnsiFgColor('\x1b[38;2;255;0;128m');
      expect(result).toEqual({ type: 'rgb', r: 255, g: 0, b: 128 });
    });

    it('should parse basic ANSI color codes', () => {
      const result = parseAnsiFgColor('\x1b[31m');
      expect(result).toEqual({ type: 'basic', index: 1 });
    });

    it('should return null for invalid codes', () => {
      expect(parseAnsiFgColor('\x1b[invalid')).toBeNull();
    });
  });

  describe('rgbTo256', () => {
    it('should map pure red to correct cube index', () => {
      const index = rgbTo256(255, 0, 0);
      expect(index).toBe(16 + 36 * 5); // r=5 in cube
    });

    it('should map gray colors to grayscale ramp', () => {
      const index = rgbTo256(100, 100, 100);
      expect(index).toBeGreaterThanOrEqual(232);
      expect(index).toBeLessThanOrEqual(255);
    });
  });

  describe('derive256Gradient', () => {
    it('should return correct number of steps', () => {
      const gradient = derive256Gradient(39, 8);
      expect(gradient).toHaveLength(8);
    });

    it('should return valid ANSI codes', () => {
      const gradient = derive256Gradient(39, 8);
      for (const code of gradient) {
        expect(code).toMatch(/\x1b\[38;5;\d+m/);
      });
    });
  });

  describe('buildWaveGradient', () => {
    const mockTheme: Theme = {
      fg: (color: string, text: string) => `\x1b[38;5;39m${text}\x1b[39m`,
    };

    it('should return correct number of gradient steps', () => {
      const gradient = buildWaveGradient(mockTheme, 8);
      expect(gradient).toHaveLength(8);
    });

    it('should fallback to gray gradient for invalid color', () => {
      const invalidTheme: Theme = {
        fg: (color: string, text: string) => text,
        getFgAnsi: () => '',
      } as any;
      const gradient = buildWaveGradient(invalidTheme, 8);
      expect(gradient).toHaveLength(8);
      // Should be gray range (234-244)
      for (const code of gradient) {
        const match = code.match(/\x1b\[38;5;(\d+)m/);
        expect(match).toBeTruthy();
        const index = parseInt(match![1], 10);
        expect(index).toBeGreaterThanOrEqual(234);
        expect(index).toBeLessThanOrEqual(244);
      }
    });
  });
});
```

#### 6.2 Integration Tests

1. **Manual visual testing**:
   - Run research task with depth 0 (quick mode)
   - Observe wave animation during search phase
   - Verify wave moves left to right
   - Check gradient trail is visible
   - Confirm fallback to static fill when animation not running

2. **Theme testing**:
   - Test with dark theme
   - Test with light theme
   - Test with custom theme
   - Verify accent color is used correctly

3. **Edge case testing**:
   - Narrow terminal width (< 20 columns)
   - Wide terminal width (> 200 columns)
   - Very short search duration (< 1 animation frame)
   - Multiple concurrent searches (if applicable)

4. **Error handling**:
   - Abort with Ctrl+C during search
   - Network error during search
   - Theme change during search

#### 6.3 Automated Tests

```bash
# Type checking
npx tsc --noEmit

# Run test suite
npx vitest run

# Linting
npx eslint src/

# Coverage
npx vitest run --coverage
```

### Phase 7: Configuration (Optional)

#### 7.1 Add Configuration Options

**File:** `src/config.ts`

```typescript
export interface Config {
  // ... existing fields ...

  /** Wave animation frame interval in milliseconds (default: 80) */
  WAVE_ANIMATION_INTERVAL_MS: number;

  /** Wave trail length in characters (default: 8) */
  WAVE_TRAIL_LENGTH: number;
}

export const DEFAULTS: Config = {
  // ... existing defaults ...

  WAVE_ANIMATION_INTERVAL_MS: 80,
  WAVE_TRAIL_LENGTH: 8,
};
```

Update wave animation code to use config values:

```typescript
const interval = getConfig().WAVE_ANIMATION_INTERVAL_MS;
const trailLen = getConfig().WAVE_TRAIL_LENGTH;

// In timer:
waveTimer = setInterval(() => { /* ... */ }, interval);

// In rendering:
const gradient = buildWaveGradient(theme, trailLen);
const peakPos = (panel.waveFrame % (available + trailLen)) - trailLen;
```

## Implementation Order

1. **Phase 1**: Add `waveFrame` to interface
2. **Phase 2**: Implement color parsing and gradient building
3. **Phase 3**: Update header rendering logic
4. **Phase 4**: Add animation timer management
5. **Phase 5**: Test and refine edge cases
6. **Phase 6**: Write tests
7. **Phase 7**: Optional: Add configuration options

## Rollback Plan

If issues arise, each phase can be independently rolled back:

1. **Phase 4 rollback**: Remove timer code, animation won't work but no breakage
2. **Phase 3 rollback**: Restore static fill, TUI works but no animation
3. **Phase 2 rollback**: Remove gradient functions (unused)
4. **Phase 1 rollback**: Remove `waveFrame` from interface (unused)

## Success Criteria

1. ✓ Wave animation displays during search phases
2. ✓ Wave moves smoothly left-to-right across available width
3. ✓ Gradient trail uses theme accent color
4. ✓ Falls back to gray if accent color cannot be parsed
5. ✓ Falls back to static fill if animation not running
6. ✓ No memory leaks (timers always cleared)
7. ✓ No TypeScript errors
8. ✓ All existing tests pass
9. ✓ New tests for wave functionality pass
10. ✓ Manual testing confirms visual quality

## Performance Targets

- Animation frame rate: 10-15 FPS (80-100ms interval)
- CPU overhead: Negligible (< 1% on modern hardware)
- Memory overhead: < 1KB (simple counter + timer handle)
- Rendering time: < 1ms per frame (excluding debounce delay)

## Future Enhancements

1. **Configurable wave shapes**: Comet, scan-line, pulse
2. **Multiple wave patterns**: Per-theme selection
3. **Animation speed control**: Based on search progress
4. **Sound effects**: Optional beep on search complete
5. **Wave completion animation**: Special effect when search finishes
6. **Debug visualization**: Show color indices in development mode

## References

- pi-tui documentation: `/home/ldeen/.config/nvm/versions/node/v25.8.2/lib/node_modules/@mariozechner/pi-coding-agent/docs/tui.md`
- Theme documentation: `/home/ldeen/.config/nvm/versions/node/v25.8.2/lib/node_modules/@mariozechner/pi-coding-agent/docs/themes.md`
- Theme implementation: `/home/ldeen/.config/nvm/versions/node/v25.8.2/lib/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js`
- pi-tui utils: `/home/ldeen/.config/nvm/versions/node/v25.8.2/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-tui/dist/utils.js`
- Animation examples: `/home/ldeen/.config/nvm/versions/node/v25.8.2/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/snake.ts`
