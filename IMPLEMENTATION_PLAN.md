# Implementation Plan: Per-Agent Token Count and Cost Display

## Current State

The TUI currently shows:
1. A big title bar across the top of the right box with: `Research | {model} {totalTokens}`
2. Individual slice boxes below showing just the label (e.g., "1", "2", "3")

## Desired State

Each slice box should have its own header showing:
1. Token count for **that specific** research agent
2. Cost for **that specific** research agent

## Architecture Analysis

### Data Flow
1. **SwarmOrchestrator** creates researcher sessions
2. Each session emits `message_end` events with token usage
3. `onTokens(n)` callback accumulates tokens globally
4. `SliceState` tracks individual agent state (id, label, completed, queued, flash)

### Key Data Types
- `Model.cost`: `{ input, output, cacheRead, cacheWrite }` - per-million rates
- `Usage`: `{ input, output, cacheRead, cacheWrite, totalTokens, cost }`
- `calculateCost(model, usage)`: Calculates actual cost from tokens

## Changes Required

### 1. `src/orchestration/swarm-types.ts`
- Expand `ResearchSibling` to include `tokens?: number` and `cost?: number`
- Add new event types for per-agent token updates if needed

### 2. `src/tui/research-panel.ts`
- Expand `SliceState` interface to include:
  - `tokens?: number` - tokens for this specific agent
  - `cost?: number` - calculated cost for this agent
- Add helper functions:
  - `updateSliceTokens(state, id, tokens, cost)` - update per-agent stats
- Modify `createResearchPanel` render logic:
  - Remove big title across top
  - Add per-box headers with token count and cost

### 3. `src/orchestration/swarm-orchestrator.ts`
- Pass model to orchestrator so costs can be calculated
- Track per-agent tokens (need to sum from message_end events)
- Calculate cost using `calculateCost()` from pi-ai
- Update both:
  - `panelState.totalTokens` (aggregate)
  - `sliceState.tokens` and `sliceState.cost` (per-agent)

### 4. `src/orchestration/swarm-reducer.ts`
- Add event types for token/cost updates per sibling

### 5. `src/tool.ts`
- Pass model reference to orchestrator
- Ensure onTokens callback signature supports per-agent tracking

## Technical Approach

### Per-Agent Token Tracking
Each researcher session already subscribes to `message_end` events:
```typescript
session.subscribe((event: AgentSessionEvent) => {
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    const tokens = (event.message as any).usage?.totalTokens;
    if (tokens) this.options.onTokens(tokens);
  }
});
```

We need to:
1. Capture the `aspect.id` in the closure
2. Call a per-agent callback instead of just the global one
3. Calculate cost from the usage breakdown

### Cost Calculation
```typescript
import { calculateCost } from '@mariozechner/pi-ai';

function calculateAgentCost(model: Model, usage: Usage): number {
  const cost = calculateCost(model, usage);
  return cost.total;
}
```

### TUI Render Changes
Instead of:
```
┌─ Research | gpt-4o  125k ─────────────────────────────────┐
│  ┌───┐  ┌───┐  ┌───┐                                    │
│  │ 1 │  │ 2 │  │ 3 │                                    │
│  └───┘  └───┘  └───┘                                    │
└──────────────────────────────────────────────────────────┘
```

Show:
```
┌──────────────────────────────────────────────────────────┐
│ ┌──────┐  ┌──────┐  ┌──────┐                           │
│ │ 12k  │  │ 15k  │  │ 18k  │                           │
│ │ $0.12│  │ $0.15│  │ $0.18│                           │
│ │  1   │  │  2   │  │  3   │                           │
│ └──────┘  └──────┘  └──────┘                           │
└──────────────────────────────────────────────────────────┘
```

Each box shows:
- Token count (top)
- Cost (below tokens)
- Agent label (bottom)

## Implementation Notes

1. **Backward Compatibility**: Keep totalTokens for aggregate stats
2. **Zero State**: Handle boxes with 0 tokens/cost gracefully
3. **Currency Formatting**: Format costs to 4 decimal places
4. **Token Formatting**: Use same formatTokens() helper
5. **Tight Spaces**: The right box may have limited width; need to fit token+cost+label in each column
