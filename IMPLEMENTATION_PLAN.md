# Implementation Complete: Per-Agent Token Count and Cost Display

## Status: ✅ COMPLETE

All changes have been implemented and tested.

## Summary of Changes

### 1. `src/orchestration/swarm-types.ts`
- Added `cost?: number` to `ResearchSibling` interface
- Added `SIBLING_TOKENS` event type to `SwarmEvent` for tracking per-agent usage

### 2. `src/tui/research-panel.ts`
- Expanded `SliceState` interface with `tokens?: number` and `cost?: number`
- Added `updateSliceTokens()` helper function
- Added `formatCost()` function for currency formatting
- Added `truncateMiddle()` helper for fitting long text in boxes
- Complete rewrite of `createResearchPanel` render function:
  - Removed big title bar across top
  - Each agent box now shows its own header with:
    - Token count (formatted: 1000 → "1k", 15000 → "15k")
    - Cost (formatted: "$0.0012" to "$12.00")
    - Agent label (bottom, e.g., "1", "2", "✓3")
  - Fallback to compact mode (just labels) when boxes are too narrow

### 3. `src/orchestration/swarm-orchestrator.ts`
- Added import for `updateSliceTokens`
- Added `calculateUsageCost()` helper function using model.cost rates
- Modified session subscription to:
  - Extract usage data from message_end events
  - Calculate cost from input/output/cache tokens
  - Update panel state per-agent via `updateSliceTokens()`
  - Update system state via `SIBLING_TOKENS` event

### 4. `src/orchestration/swarm-reducer.ts`
- Added handler for `SIBLING_TOKENS` event that accumulates tokens/cost per sibling

## TUI Output

**Before:**
```
┌─ Research | gpt-4o  125k ─────────────────────────────────┐
│  ┌───┐  ┌───┐  ┌───┐                                    │
│  │ 1 │  │ 2 │  │ 3 │                                    │
│  └───┘  └───┘  └───┘                                    │
└──────────────────────────────────────────────────────────┘
```

**After:**
```
│ ┌──────┐  ┌──────┐  ┌──────┐                            │
│ │ 12k  │  │ 15k  │  │ 18k  │                            │
│ │$0.12 │  │$0.15 │  │$0.18 │                            │
│ │  1   │  │  2   │  │  ✓3  │                            │
│ └──────┘  └──────┘  └──────┘                            │
└──────────────────────────────────────────────────────────┘
```

## Technical Details

### Cost Calculation
```typescript
const cost = (modelCost.input / 1_000_000) * usage.input +
             (modelCost.output / 1_000_000) * usage.output +
             (modelCost.cacheRead / 1_000_000) * usage.cacheRead +
             (modelCost.cacheWrite / 1_000_000) * usage.cacheWrite;
```

### Token Accumulation
- Each `message_end` event accumulates to the agent's running total
- Both panel state (for UI) and system state (for persistence) are updated
- Completed agents show muted colors; active agents show normal text

## Verification

- ✅ TypeScript type-check passes
- ✅ All 597 unit tests pass
- ✅ No breaking changes to existing functionality
