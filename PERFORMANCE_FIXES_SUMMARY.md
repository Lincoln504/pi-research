# Pi-Research Performance Fixes - Quick Reference

**Status:** Ready for Implementation  
**Date:** 2026-04-30  
**Expected Improvement:** 50-70% faster (29m → 8-15m)

---

## At a Glance

| Priority | Fix | Impact | Effort |
|----------|-----|--------|--------|
| P0 | Scrape gate broken → 350K tokens | **Critical** | Medium |
| P0 | No URL truncation → 240K+ chars | **Critical** | Easy |
| P1 | LLM timing always 0ms | High | Easy |
| P1 | Wrong query budgets (L2=10, L3=15) | High | Easy |
| P1 | No timeout enforcement | High | Easy |
| P2 | Evaluator gets all reports (350K chars) | Medium | Medium |
| P2 | MAX_EVALUATOR_REPORT_LENGTH = 50K | Medium | Easy |
| P3 | Context warning at 30K (too low) | Low | Easy |

**Total:** 8 fixes across 4 files, ~60-80 lines of code

---

## The Root Cause

The **massive search burst is working excellently** (30 queries in 43s). The problem is:

1. **Scrape context gate is completely broken** (reading `toolResults` from wrong event type)
2. **No URL content truncation** (full 30-80K char dumps)
3. **Evaluator accumulates all reports** (7 × 50K = 350K chars by round 3)

Result: Researchers and evaluators processing 350K-390K tokens per call.

---

## P0 Fixes (Apply First - 30 minutes)

### Fix 1: Move Scrape Token Tracking
**File:** `src/orchestration/deep-research-orchestrator.ts`  
**Issue:** `message_end` event has no `toolResults` field  
**Fix:** Move tracking to `tool_execution_end` where `event.result` exists  
**Lines:** 557-567 → 569+  
**Impact:** Gate activates, contexts limited to ~90K tokens

```typescript
// Before (WRONG - toolResults not on message_end)
if (event.type === 'message_end') {
    const scrapeTokenEstimate = (msg as any)?.toolResults?.reduce(...);
}

// After (CORRECT - use event.result in tool_execution_end)
else if (event.type === 'tool_execution_end' && !event.isError) {
    if (event.toolName === 'scrape' && event.result?.details?.count) {
        const scrapeTokenEstimate = event.result.details.count * AVG_TOKENS_PER_SCRAPE;
        // ...
    }
}
```

### Fix 2: Add URL Truncation
**File:** `src/tools/scrape.ts`  
**Issue:** No per-URL character limit  
**Fix:** Add `MAX_CHARS_PER_URL = 10000` and truncate in output loop  
**Lines:** Add constant near top, modify loop near line 151  
**Impact:** Max 80K chars vs 240K+ chars

```typescript
// Add constant
const MAX_CHARS_PER_URL = 10000;

// Truncate in loop
for (const res of successful) {
    let content = res.markdown;
    if (content.length > MAX_CHARS_PER_URL) {
        content = content.slice(0, MAX_CHARS_PER_URL) + '\n\n[...truncated...]';
    }
    markdown += `### ${res.url}\n${content}\n\n---\n\n`;
}
```

---

## P1 Fixes (Apply Second - 20 minutes)

### Fix 3: Fix LLM Timing
**File:** `src/orchestration/deep-research-orchestrator.ts`  
**Issue:** `Date.now()` in both start/end creates different IDs  
**Fix:** Use LIFO array (push start, pop end)  
**Lines:** 524-533  
**Impact:** Accurate timing, performance visibility

```typescript
// Before (WRONG - different IDs)
const llmCallStart = new Map<string, number>();
if (event.type === 'message_start') {
    llmCallStart.set(`${id}-${Date.now()}`, Date.now());
}
if (event.type === 'message_end') {
    const callId = `${id}-${Date.now()}`;  // Different ID!
    const duration = Date.now() - llmCallStart.get(callId);  // Always 0!
}

// After (CORRECT - LIFO stack)
const llmCallStartStack: number[] = [];
if (event.type === 'message_start') {
    llmCallStartStack.push(Date.now());
}
if (event.type === 'message_end') {
    const startTime = llmCallStartStack.pop() || Date.now();
    const duration = Date.now() - startTime;  // Accurate!
}
```

### Fix 4: Fix Query Budgets
**File:** `src/constants.ts`  
**Issue:** Constants don't match prompt (prompt says L2=20, L3=30)  
**Fix:** Update constants  
**Lines:** 119-121  
**Impact:** Better coverage at higher complexity

```typescript
// Before
MAX_QUERIES_PER_RESEARCHER_LEVEL_1 = 10
MAX_QUERIES_PER_RESEARCHER_LEVEL_2 = 10  // Should be 20!
MAX_QUERIES_PER_RESEARCHER_LEVEL_3 = 15  // Should be 30!

// After
MAX_QUERIES_PER_RESEARCHER_LEVEL_1 = 10
MAX_QUERIES_PER_RESEARCHER_LEVEL_2 = 20  // Fixed!
MAX_QUERIES_PER_RESEARCHER_LEVEL_3 = 30  // Fixed!
```

### Fix 5: Enforce Timeout
**File:** `src/orchestration/deep-research-orchestrator.ts`  
**Issue:** `RESEARCHER_TIMEOUT_MS` defined but never used  
**Fix:** Wrap `session.prompt()` with `Promise.race`  
**Lines:** ~482  
**Impact:** No hung researchers blocking slots

```typescript
// Add import
import { getConfig } from '../config.ts';

// Wrap session.prompt()
const config = getConfig();
const timeoutPromise = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error('Timeout')), config.RESEARCHER_TIMEOUT_MS);
});
await Promise.race([
    session.prompt("Begin your specialized research."),
    timeoutPromise
]);
```

---

## P2 Fixes (Apply Third - 15 minutes)

### Fix 6: Reduce Report Length
**File:** `src/constants.ts`  
**Issue:** 50K chars per report is too much  
**Fix:** Reduce to 20K chars  
**Lines:** 102  
**Impact:** 60% smaller evaluator inputs

```typescript
// Before
MAX_EVALUATOR_REPORT_LENGTH = 50000

// After
MAX_EVALUATOR_REPORT_LENGTH = 20000
```

### Fix 7: Filter Reports for Delegation
**File:** `src/orchestration/deep-research-orchestrator.ts`  
**Issue:** Evaluator gets ALL reports every round  
**Fix:** Send only current-round reports for delegation  
**Lines:** 691-698 (in evaluate method)  
**Impact:** Constant-size evaluator inputs during delegation

```typescript
// Before
const reportsText = Array.from(this.reports.entries()).map(...);

// After
let reportsToUse = this.reports;
if (!mustSynthesize && !atTarget) {
    // Delegation: use only current round's reports
    const currentRoundReports = new Map<string, string>();
    for (const [id, report] of this.reports.entries()) {
        if (id.startsWith(`${this.currentRound}.`)) {
            currentRoundReports.set(id, report);
        }
    }
    reportsToUse = currentRoundReports;
}
const reportsText = Array.from(reportsToUse.entries()).map(...);
```

---

## P3 Fixes (Apply Last - 5 minutes)

### Fix 8: Raise Warning Threshold
**File:** `src/orchestration/deep-research-orchestrator.ts`  
**Issue:** 30K token warning fires during normal operation  
**Fix:** Raise to 80K tokens  
**Lines:** 544-546  
**Impact:** Cleaner logs

```typescript
// Before
if (newTotal > 30000 && ...) {
    logger.warn(`Context size: ${newTotal.toLocaleString()} tokens`);
}

// After
const CONTEXT_WARNING_THRESHOLD = 80000;
if (newTotal > CONTEXT_WARNING_THRESHOLD && ...) {
    logger.warn(`Context size: ${newTotal.toLocaleString()} tokens`);
}
```

---

## Files to Modify

```
src/orchestration/deep-research-orchestrator.ts
  ├─ Fix 1: Scrape token tracking (lines 557-567 → 569+)
  ├─ Fix 3: LLM timing (lines 524-533)
  ├─ Fix 5: Timeout enforcement (line ~482)
  ├─ Fix 7: Report filtering (lines 691-698)
  └─ Fix 8: Warning threshold (lines 544-546)

src/tools/scrape.ts
  └─ Fix 2: URL truncation (add constant, modify loop)

src/constants.ts
  ├─ Fix 4: Query budgets (lines 119-121)
  └─ Fix 6: Report length (line 102)
```

---

## Expected Results

### Before (29m28s Level 2 run)
| Component | Time | % | Context |
|-----------|------|---|---------|
| Coordinator | 74.7s | 4% | N/A |
| Search | 93.5s | 5% | N/A |
| Researchers | 804s | 47% | 350K-390K tokens |
| Evaluators | 796s | 47% | 350K chars input |

### After P0 Fixes
| Component | Time | % | Context |
|-----------|------|---|---------|
| Coordinator | 74.7s | 4% | N/A |
| Search | 93.5s | 5% | N/A |
| Researchers | 200-300s | 35-40% | ~90K tokens |
| Evaluators | 150-200s | 30-35% | 140K chars input |
| **Total** | **12-15 min** | **100%** | **50% faster** |

### After All Fixes (P0-P2)
| Component | Time | % | Context |
|-----------|------|---|---------|
| Coordinator | 74.7s | 5% | N/A |
| Search | 93.5s | 6% | N/A |
| Researchers | 150-200s | 30-35% | ~90K tokens |
| Evaluators | 80-120s | 15-20% | 60K chars input |
| **Total** | **8-10 min** | **100%** | **70% faster** |

---

## Implementation Order

1. **Apply P0 fixes** (Fixes 1-2)
   - Test Level 2 run
   - Expect: 12-15 minutes, contexts <100K tokens

2. **Apply P1 fixes** (Fixes 3-5)
   - Test Level 2 run
   - Expect: 10-13 minutes, LLM timing visible

3. **Apply P2 fixes** (Fixes 6-7)
   - Test Level 3 run
   - Expect: 8-10 minutes, evaluator faster

4. **Apply P3 fixes** (Fix 8)
   - Test any run
   - Expect: Cleaner logs

---

## Quick Test Commands

```bash
# Build
cd /home/ldeen/Documents/pi-research
npm run build

# Test Level 2 (main test)
pi --verbose
> research "history of the ottoman empire" --depth 1

# Test Level 3
pi --verbose
> research "climate change impact on agriculture" --depth 2

# Quick smoke test
pi --verbose
> research "quantum computing applications" --depth 0
```

---

## What's Already Working ✅

- **Search burst**: 30 queries in 43s (excellent!)
- **Concurrency control**: Max 3 parallel researchers
- **State machine**: Round/delegation/synthesis transitions
- **JSON parsing**: Robust after recent fixes
- **Error recovery**: Failed researchers don't crash rounds
- **Session lifecycle**: Clean startup/teardown, no leaks

---

## Verification Checklist

After applying fixes:

- [ ] Build succeeds (no TypeScript errors)
- [ ] LLM call durations logged (not all 0ms)
- [ ] Context warnings only at >80K tokens
- [ ] Scrape gate fires at threshold
- [ ] URL content truncated at 10K chars
- [ ] Evaluator gets current-round reports for delegation
- [ ] Evaluator gets all reports for synthesis
- [ ] Timeout enforced after 4 minutes
- [ ] Query budgets: L1=10, L2=20, L3=30
- [ ] Level 2 completes in <15 minutes
- [ ] Level 3 completes in <20 minutes
- [ ] No researcher hangs indefinitely

---

## Rollback if Needed

Each fix can be individually reverted:

- **Fix 1**: Gate will be broken again (as it was)
- **Fix 2**: Remove truncation or increase limit
- **Fix 3**: Timing will be 0ms again
- **Fix 4**: Revert constants to L2=10, L3=15
- **Fix 5**: Remove Promise.race wrapper
- **Fix 6**: Change back to 50K
- **Fix 7**: Remove reportsToUse logic
- **Fix 8**: Change threshold back to 30K

All fixes are isolated and safe to revert individually.

---

## Documentation

- **Full Investigation**: `COMPREHENSIVE_INVESTIGATION_REPORT.md`
- **Detailed Implementation**: `IMPLEMENTATION_PLAN.md`
- **This Quick Reference**: `PERFORMANCE_FIXES_SUMMARY.md`

---

## Summary

**Root Cause:** Broken scrape gate + missing URL truncation → 350K-390K token contexts

**Solution:** Fix gate, add truncation, optimize evaluator inputs

**Effort:** 8 fixes, 4 files, ~60-80 lines, 1-2 hours

**Impact:** 50-70% faster (29m → 8-15m)

**Risk:** Low - all fixes are isolated and reversible

---

**Last Updated:** 2026-04-30  
**Status:** Ready for Implementation
