# Evaluator Logic Verification & Fixes

## Problem Statement

The evaluator was incorrectly tracking completed researchers, which could cause:
1. **Incorrect agenda tracking:** Pending researchers from new rounds appeared as "completed" when filtering the initial agenda
2. **Missing reports:** Evaluator might not receive reports from all completed researchers across multiple rounds
3. **Visual confusion:** Researcher states could appear inconsistent in TUI

## Root Cause Analysis

### Bug 1: Incorrect Agenda Filtering

**Before Fix:**
```typescript
const completedAspectQueries = Object.values(this.state.aspects).map(a => a.query);
const remainingAgenda = this.state.initialAgenda.filter(q => !completedAspectQueries.includes(q));
```

**Problem:** This maps ALL aspect queries, not just completed ones.

**Example Scenario:**
- Round 1: `1.1`, `1.2`, `1.3` (all completed)
- Round 2: `2.1`, `2.2`, `2.3` (just created, pending)

**Before Fix:**
```typescript
completedAspectQueries = ["query1", "query2", "query3", "query4", "query5", "query6"]
```
All 6 queries appear as "completed" even though 2.1-2.3 haven't started!

**After Fix:**
```typescript
completedAspectQueries = Object.values(this.state.aspects)
  .filter(a => a.status === 'completed')
  .map(a => a.query);
// Result: ["query1", "query2", "query3"] ← Only actually completed queries
```

### Bug 2: Missing Verification Logging

The evaluator logic lacked visibility into:
- How many completed researchers were being analyzed
- Whether delegation or synthesis was chosen
- How many new researchers would be spawned

## Fixes Implemented

### Fix 1: Correct Agenda Filtering

**File:** `src/orchestration/deep-research-orchestrator.ts`

**Change:**
```typescript
// BEFORE: Incorrect - includes pending queries
const completedAspectQueries = Object.values(this.state.aspects).map(a => a.query);
const remainingAgenda = this.state.initialAgenda.filter(q => !completedAspectQueries.includes(q));

// AFTER: Correct - only completed queries
const completedAspectQueries = Object.values(this.state.aspects)
  .filter(a => a.status === 'completed')
  .map(a => a.query);
const remainingAgenda = this.state.initialAgenda.filter(q => !completedAspectQueries.includes(q));
```

**Impact:**
- ✅ Correctly tracks which initial agenda items are completed
- ✅ Properly identifies remaining agenda items
- ✅ Prevents false completion of pending researchers

### Fix 2: Enhanced Logging

**Added debug logging:**

1. **Evaluator start:**
```typescript
logger.log(`[deep-research] Evaluator Round ${evaluatedRound}: Analyzing ${allCompleted.length} completed researchers from all rounds`);
```
Shows how many completed reports the evaluator is analyzing.

2. **Evaluator decision:**
```typescript
logger.log(`[deep-research] Evaluator decision for Round ${evaluatedRound}: ${
  isSynthesis ? 'SYNTHESIS - completing research' : `DELEGATION - spawning ${nextQueries.length} new researchers in Round ${evaluatedRound + 1}`
}`);
```
Shows whether evaluator chose to synthesize or delegate.

## Verification

### State Management

The reducer correctly preserves ALL aspects across rounds:

```typescript
const newState: SystemResearchState = {
  ...state,
  // ... other fields
  aspects: { ...state.aspects }  // ← Copies ALL existing aspects
};

// In PROMOTION_DECISION:
newState.currentRound++;
event.nextQueries.forEach((q: string, i: number) => {
  const id = `${newState.currentRound}.${i + 1}`;
  newState.aspects[id] = { id, query: q, status: 'pending' };  // Adds NEW aspects
});
```

**Result:** State contains:
- `1.1`, `1.2`, `1.3` (completed from Round 1)
- `2.1`, `2.2`, `2.3` (pending for Round 2)

### Evaluator Receives All Reports

```typescript
const allCompleted = Object.values(this.state.aspects)
  .filter(a => a.status === 'completed' && a.report);
```

**This correctly gets:**
- All completed researchers from ALL rounds
- Only those with actual reports (not just status 'completed')

## Test Results

All tests pass:
- ✅ Unit tests: 575/575
- ✅ Type check: PASS
- ✅ Linting: PASS

## Expected Behavior After Fix

### Scenario 1: Single Round (Synthesis)

```
Round 1:
[1] [2] [3]  ← Researchers running
↓
[OK1] [OK2] [OK3]  ← All complete
↓
[Eval]  ← Evaluator appears
↓
Decision: SYNTHESIS
↓
Research completes with final report of all 3 researchers
```

### Scenario 2: Two Rounds (Delegation)

```
Round 1:
[1] [2] [3]  ← Researchers running
↓
[OK1] [OK2] [OK3]  ← All complete
↓
[Eval]  ← Evaluator appears
↓
Decision: DELEGATE 2 more researchers
↓
[OK Eval]  ← Evaluator complete
↓
Round 2:
[4] [5]  ← New researchers spawn
↓
[OK4] [OK5]  ← All complete
↓
[Eval]  ← Evaluator appears (Round 2)
↓
Decision: SYNTHESIS
↓
Research completes with final report of ALL 5 researchers (1-5)
```

### Scenario 3: Three Rounds (Multiple Delegations)

```
Round 1: [1] [2] [3] → Complete
Eval 1: Delegate 3 more → Spawn [4] [5] [6]
Round 2: [4] [5] [6] → Complete
Eval 2: Delegate 2 more → Spawn [7] [8]
Round 3: [7] [8] → Complete
Eval 3: SYNTHESIS → Final report of ALL 8 researchers (1-8)
```

## Key Principles

1. **State Preservation:** All aspects from all rounds are preserved in state
2. **Correct Filtering:** Only `status === 'completed'` aspects are considered completed
3. **Complete Reports:** Evaluator receives ALL completed reports from ALL rounds
4. **Proper Tracking:** Agenda items correctly tracked across multiple delegations
5. **Visibility:** Logging provides clear insight into evaluator decisions

## Related Files

- **Modified:** `src/orchestration/deep-research-orchestrator.ts`
- **Related:** `src/orchestration/deep-research-reducer.ts` (verified correct)

---

**Fix Status:** ✅ COMPLETE AND TESTED
