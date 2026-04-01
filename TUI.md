# TUI (Terminal User Interface) Documentation

## Overview

The pi-research extension supports two TUI modes for visualizing research progress:

- **Simple Mode (default)**: Compact 3-line display with SearXNG status + agent dots
- **Full Mode**: Boxed grid layout showing slice/depth hierarchy with visual research tree

## Configuration

Set the TUI mode via environment variable:

```bash
# Simple mode (default)
export PI_RESEARCH_TUI_MODE=simple

# Full mode
export PI_RESEARCH_TUI_MODE=full
```

## Simple Mode (TUI_MODE='simple')

### Visual Layout

```
 ● active  http://localhost:8080                tk: 10.2k
 ● Coordinator  ●1 ●2 ●3
```

### Features

- **Line 1**: SearXNG connection status + URL + token count
  - Status indicators: `[starting]`, `[active]`, `[inactive]`, `[error]`
  - Token count formatted: `10.2k` (thousands), `1.5M` (millions)
- **Line 2**: Coordinator indicator + agent dots
  - `●` = recently completed (green/red flash)
  - `○` = running or idle
  - Numbers after dots: agent labels (1, 2, 3, etc.)
- **Line 3**: Empty (placeholder)

### State Management

```typescript
interface SimplePanelState {
  searxngStatus: SearxngStatus;
  totalTokens: number;
  agents: Map<string, AgentDot>; // key = label
}

interface AgentDot {
  label: string;
  flash: 'green' | 'red' | null;
}
```

### When to Use

- **Production environments** where space is limited
- **Quick status checks** during research
- **Minimal overhead** with same functionality
- **Default mode** for most use cases

## Full Mode (TUI_MODE='full')

### Visual Layout

```
┌─ Research Coordinator ── tk: 42.3k ─────────────┐
│    1         2         3                        │
│   ●●        ●●        ●●                       │
│   ○1.1      ○         ○                        │
│   ○1.2      ○         ○                        │
└─────────────────────────────────────────────────┘
```

### Features

- **Boxed grid layout** with border characters
- **Columns** = Research slices (side-by-side)
- **Rows** = Agent depth levels (hierarchical)
- **Header**: Research Coordinator with token count
- **Column headers**: Slice numbers (1, 2, 3, ...)
- **Agent labels**:
  - Top-level: `●` or `○` (no label)
  - Depth 1: `●1.1` or `○1.1`
  - Depth 2: `●1.2` or `○1.2`
- **Flash effects**:
  - Green flash = successful completion
  - Red flash = error
  - Flash clears after `PI_RESEARCH_FLASH_TIMEOUT_MS` (default: 500ms)

### State Management

```typescript
interface FullPanelState {
  totalTokens: number;
  agents: Map<string, AgentState>;
  sliceGroups: Map<number, string[]>; // slice# → agent IDs
}

interface AgentState {
  label: string;
  sliceNumber: number;
  depthNumber?: number;
  flash: 'green' | 'red' | null;
}
```

### Visual Semantics

**Column = Research Slice**
- Each top-level slice becomes a column
- Shows how many parallel research branches

**Row = Agent Depth Level**
- Row position = iteration depth
- Shows research refinement levels

**Label Format**
- Top-level agents: Just marker (● or ○)
- Depth agents: Full hierarchical label (1.1, 1.2, 2.1, etc.)

### Example: Multi-Slice, Multi-Depth Research

**Query:** "AI safety research"

**Iteration 1:** 3 slices spawned
```
┌─ Research Coordinator ── tk: 8.2k ──────┐
│    1         2         3                │
│   ●●        ●●        ●●               │
└──────────────────────────────────────────┘
```

**Iteration 2:** Depth research on slice 1
```
┌─ Research Coordinator ── tk: 15.4k ─────┐
│    1         2         3                │
│   ○         ○         ○                │
│   ●1.1      ○         ○                │
│   ●1.2      ○         ○                │
└──────────────────────────────────────────┘
```

**Iteration 3:** All complete
```
┌─ Research Coordinator ── tk: 23.1k ─────┐
│    1         2         3                │
│   ○         ○         ○                │
│   ○1.1      ○         ○                │
│   ○1.2      ○         ○                │
└──────────────────────────────────────────┘
```

### When to Use

- **Development/testing** where visual feedback is helpful
- **Complex research** with many slices and depths
- **Debugging** research orchestration
- **Presentations/demos** showing research process

## Flash Indicators

### Behavior

Both TUI modes use flash indicators to show agent completion:

1. **Research starts** → Agent shows `○` (hollow)
2. **Research completes successfully** → Agent shows `●` (green) for 500ms
3. **Research fails with error** → Agent shows `●` (red) for 500ms
4. **Flash clears** → Agent reverts to `○` (hollow)

### Configuration

```bash
# Flash duration in milliseconds
export PI_RESEARCH_FLASH_TIMEOUT_MS=500  # Default: 500ms
```

Valid range: 100ms to 5000ms

## Token Tracking

Tokens are accumulated from:
- **Coordinator session**: Added when assistant messages complete
- **Researcher sessions**: Added when researchers complete

Display format:
- `< 1000`: Raw number (e.g., `542`)
- `1k - 9.9k`: 1 decimal place (e.g., `5.2k`)
- `10k - 999k`: Rounded (e.g., `42k`)
- `≥ 1M`: 1 decimal place (e.g., `1.5M`)

## SearXNG Status Display

### Simple Mode

```
 ● active  http://localhost:8080
```

### Full Mode

SearXNG status is tracked but not displayed in the full panel.
For SearXNG-specific status, use simple mode or check logs.

## Layout Algorithm (Full Mode)

### Column Width Calculation

```typescript
const sliceNumbers = [1, 2, 3, ...];              // Sorted slice IDs
const sliceWidth = floor((width - 6) / numSlices); // Divide available width
// Example: 80-char terminal with 3 slices → ~24 chars per column
```

### Grid Rendering

```typescript
for each row (0 to maxHeight-1):
  for each column (slice 1, 2, 3, ...):
    Get cell = column[row] (e.g., "●1.1" or " ")
    Pad cell to sliceWidth
    Append to row parts
  Render: │ cell1 cell2 cell3 │
```

### Dynamic Sizing

The full panel adapts to:
- Terminal width (recalculated on each render)
- Number of slices (dynamic columns)
- Depth of research (variable height)

## Cleanup and Disposal

### Flash Timeout Cleanup

All flash timeouts are tracked globally and cleared on panel disposal:

```typescript
import { clearAllFlashTimeouts } from './tui/panel-factory.js';

// Call when cleaning up the panel
clearAllFlashTimeouts();
```

### Memory Management

- **TUI component**: References cleaned on widget removal
- **Flash timeouts**: Cleared via `clearAllFlashTimeouts()`
- **Subscriptions**: Unsubscribed on cleanup
- **State maps**: Cleared on each new research session

## API Reference

### Panel Factory Functions

```typescript
import {
  createPanel,
  getCapturedTui,
  clearAllFlashTimeouts,
  setAgentFlash,
  addAgent,
  createInitialPanelState,
  type PanelState,
  type SimplePanelState,
  type FullPanelState,
} from './tui/panel-factory.js';
```

#### createPanel(state: PanelState)

Creates the appropriate panel component based on `TUI_MODE`.

#### getCapturedTui()

Returns the captured TUI reference for triggering re-renders.

#### clearAllFlashTimeouts()

Clears all active flash timeout handlers.

#### setAgentFlash(agents, label, color, timeoutMs)

Sets flash indicator for an agent with automatic cleanup.

#### addAgent(state, agentId, sliceNumber, depthNumber?)

Adds a new agent to the panel state.

#### createInitialPanelState(searxngStatus)

Creates initial panel state based on TUI_MODE.

## Performance Considerations

### Simple Mode

- **Rendering**: ~0.1ms per render (minimal)
- **Memory**: ~1KB for panel state
- **Flash overhead**: ~1ms per agent completion

### Full Mode

- **Rendering**: ~0.5ms per render (grid calculation)
- **Memory**: ~5KB for panel state
- **Flash overhead**: ~1ms per agent completion

### Recommendations

- **Production**: Use simple mode for minimal overhead
- **Development**: Use full mode for better visibility
- **Large terminal windows**: Full mode shines with more space
- **Small terminal windows**: Simple mode avoids clipping

## Troubleshooting

### Panel Not Showing

1. Check TUI widget is registered:
   ```typescript
   ctx.ui.setWidget('pi-research-panel', createPanel(state), { placement: 'aboveEditor' });
   ```

2. Verify TUI reference is captured:
   ```typescript
   getCapturedTui()?.requestRender?.();
   ```

3. Check placement in terminal window

### Flash Effects Not Working

1. Verify flash timeout configuration:
   ```bash
   echo $PI_RESEARCH_FLASH_TIMEOUT_MS
   ```

2. Check agent state updates:
   ```typescript
   agent.flash = 'green';
   getCapturedTui()?.requestRender?.();
   ```

3. Ensure timeouts are cleared on cleanup:
   ```typescript
   clearAllFlashTimeouts();
   ```

### Layout Issues in Full Mode

1. Terminal too narrow for number of slices
2. Try reducing number of slices or widening terminal
3. Or use simple mode for compact display

## Future Enhancements

Potential improvements to consider:

1. **Interactive panels**: Click agents to show details
2. **Color themes**: Customizable color schemes
3. **Progress bars**: Visual progress for each agent
4. **Historical views**: Show previous research sessions
5. **Export capability**: Save visualizations to files
6. **Animation support**: Smooth transitions for state changes
