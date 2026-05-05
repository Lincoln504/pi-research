# Traveling Wave Animation - Demo Guide

## Quick Demo

To see the traveling wave animation in action:

```bash
cd /home/ldeen/Documents/pi-research
pi "research: traveling wave animation"
```

This will trigger a research operation and display the animated wave in the TUI header during the search phase.

## Expected Visual Behavior

### During Search
```
── Research: [status] ─╮
╭─┬─┬─┬─┬─┬─┬─┬─┬─┬─╮
│││││││││││││││││││││││
```

The wave fill section (after "Research:") will show:
- Bright peak entering from left
- Gradient trail following the peak
- Dim gray background for non-wave areas
- Colors matching your theme's accent color

### Animation Phases

1. **Entry**: Peak enters from left edge
   ```
   ─── Research  ╮──────
   ```

2. **Travel**: Peak moves across with trailing gradient
   ```
   ─── Research  ──────╮
   ```

3. **Exit**: Peak exits right edge, cycle resets
   ```
   ─── Research  ╮────────
   ```

4. **Loop**: New peak enters, cycle repeats

### After Search Complete

The wave stops and the display returns to normal:

```
── Research: 50% ─╮
╭─┬─┬─┬─┬─┬─┬─┬─┬─╮
││││││││││││││││││││││
```

## Wave Animation Parameters

Current default values:
- **Trail length**: 8 gradient steps
- **Frame rate**: 80ms (12.5 FPS)
- **Background color**: ANSI 237 (dim gray)
- **Wave character**: `─` (U+2500)
- **Gradient**: Brightest at peak → dimmest at tail

## Theme Color Integration

The wave automatically uses your theme's accent color:

- **Dark theme**: Bright accent color with dark trail
- **Light theme**: Appropriate accent for visibility
- **Custom theme**: Uses whatever `accent` color is defined
- **Fallback**: Gray gradient if accent cannot be parsed

## Terminal Width Adaptation

The wave adapts to your terminal width:
- **Wide terminal** (80+ columns): Full wave visible
- **Narrow terminal** (40 columns): Partial wave, fewer steps
- **Very narrow** (< 30 columns): Minimal wave, still works

## Testing Different Themes

To test with different themes:

1. Check current theme:
   ```bash
   pi "/settings"
   ```
   Navigate to theme selection

2. Run research with new theme:
   ```bash
   pi "research: test wave animation"
   ```

3. Observe how the wave colors adapt to the theme

## Performance Observations

Monitor during the demo:
- **CPU usage**: Should be minimal (< 1%)
- **Memory**: No growing memory footprint
- **Responsiveness**: TUI remains responsive
- **Animation smoothness**: ~12.5 FPS

## Edge Case Demo

To test edge cases:

### Short Search (< 1 animation frame)
```bash
pi "research: quick test"
```
Expected: Wave may not complete full cycle before search ends

### Multiple Concurrent Searches
```bash
pi "research: first query"
# While first is running, start another session
# (In another terminal) pi "research: second query"
```
Expected: Each session has independent wave animation

### Narrow Terminal
```bash
# Resize terminal to 30 columns, then:
pi "research: narrow test"
```
Expected: Wave works with fewer visible gradient steps

## Troubleshooting

### Wave Not Visible

If wave animation doesn't appear:
1. Check if search is actually running (look for "Searching..." status)
2. Verify theme accent color is valid
3. Check terminal width is sufficient (> 20 columns)
4. Look for errors in pi logs

### Flickering or Janky Animation

If animation is not smooth:
1. Check system load (high CPU may affect timing)
2. Verify TUI refresh debounce is working
3. Check for multiple timers running (should be only 1)

### Colors Not Matching Theme

If wave doesn't use accent color:
1. Check theme definition
2. Verify `accent` color token is set
3. Look for errors in color parsing (check logs)

## Manual Testing Checklist

Run this checklist to verify implementation:

- [ ] Wave appears during search
- [ ] Wave moves left-to-right smoothly
- [ ] Gradient trail is visible
- [ ] Colors match theme accent
- [ ] Background is dim gray
- [ ] Wave stops when search completes
- [ ] Static pattern shows when animation not running
- [ ] No visual artifacts or glitches
- [ ] Works with narrow terminal width
- [ ] No memory leaks after multiple searches
- [ ] CPU usage is minimal
- [ ] TUI remains responsive

## Code-Level Testing

For deeper testing, examine the implementation:

```bash
# View the rendering logic
cat src/tui/research-panel.ts | grep -A 30 "Traveling wave animation"

# View the timer management
cat src/tool.ts | grep -A 20 "waveTimer"

# Run unit tests for wave animation
npm test -- test/unit/tui/research-panel.test.ts
```

## Integration Testing

Test with actual research operations:

### Depth 0 (Quick Mode)
```bash
pi "research: traveling wave animation depth 0"
```
Expected: Quick search, short animation cycle

### Depth 1 (Normal Mode)
```bash
pi "research: traveling wave animation depth 1"
```
Expected: Multiple search rounds, wave animates each time

### Depth 2 (Deep Mode)
```bash
pi "research: traveling wave animation depth 2"
```
Expected: Extended search, longer animation periods

## Conclusion

The traveling wave animation provides clear visual feedback during search operations while maintaining excellent performance and compatibility with all themes and terminal configurations.

For more details, see:
- `TRAVELING_WAVE_IMPLEMENTATION_PLAN.md` - Detailed technical plan
- `WAVE_ANIMATION_IMPLEMENTATION_SUMMARY.md` - Implementation summary
