# Fixes Applied: Runaway Researchers & Abort Handling

## Issues Diagnosed

Using verbose logs from `/tmp/pi-research-debug-yq03.log`, identified three critical issues:

### 1. **Runaway Researchers** ❌
**Symptom**: Researchers continuously flashing green, generating huge token counts (01:37+ minutes of continuous tool calls)

**Root Cause**: Scrape tool requires 2 calls (handshake + execution), but limit was set to 1
- First scrape call (handshake): SUCCEEDED
- Second scrape call (execution): BLOCKED (limit=1)
- AI model kept retrying blocked call 100+ times, never stopping

**Log Evidence**:
```
[00:13:52] scrape calls=1/1  ← First call succeeds
[00:13:53] scrape blocked    ← Second call blocked
[00:13:54] scrape blocked    ← Retried 100+ times until 00:17:14
```

### 2. **Research Aborted Error** ❌
**Symptom**: "Research failed: Error: Research aborted" when user closes/Ctrl+C

**Root Cause**: Abort signal was caught as an error, propagated to user as failure message

### 3. **TUI Width Overages** ❌
**Symptom**: "Rendered line exceeds terminal width" crashes (off-by-one errors)

**Root Cause**: ANSI color codes adding invisible characters; some lines not properly truncated

---

## Fixes Implemented

### Fix #1: Scrape Limit (CRITICAL)
**File**: `src/utils/tool-usage-tracker.ts`

```typescript
// BEFORE (BROKEN):
scrape: 1,    // Only ONE batch scrape allowed

// AFTER (FIXED):
scrape: 2,    // TWO scrape calls: 1 handshake + 1 execution
```

**Impact**: 
- ✅ Researchers now successfully complete both scrape calls
- ✅ No more runaway token counts
- ✅ No more continuous retries of blocked calls

**Error Message Updated**:
```typescript
// BEFORE: "You have already used your 1 allowed scrape call"
// AFTER: "You have completed both scrape calls (handshake + execution). Proceed immediately to Phase 3"
```

---

### Fix #2: Abort Signal Handling
**File**: `src/tool.ts`

**Changes**:
1. Track abort state: `let aborted = false`
2. Set flag on abort: `signal?.addEventListener('abort', () => { aborted = true; cleanup?.(); })`
3. Handle gracefully in catch: 
   ```typescript
   if (aborted) {
     return { content: [{ type: 'text', text: 'Research cancelled.' }], details: {} };
   }
   ```

**Impact**:
- ✅ User can close research gracefully
- ✅ No "Research failed" error message
- ✅ Clean cleanup on abort

---

### Fix #3: TUI Width Safety
**File**: `src/tui/research-panel.ts`

**Added Safety Truncation**:
```typescript
// Final pass: truncate any line that exceeds terminal width
return result.map(line => {
  const w = visibleWidth(line);
  if (w > width) {
    return truncateToWidth(line, Math.max(3, width - 1));
  }
  return line;
});
```

**Impact**:
- ✅ No more off-by-one rendering errors
- ✅ All lines guaranteed to fit within terminal
- ✅ Graceful truncation with ellipsis

---

### Fix #4: Test Updates
**File**: `test/unit/utils/tool-usage-tracker.test.ts`

Updated all tests to reflect:
- Default scrape limit now 2 (not 1)
- New error message: "SCRAPE PROTOCOL COMPLETE" (not "SCRAPE LIMIT REACHED")
- All 596 tests passing ✅

---

## Verification

✅ **All Tests Passing**: 596 tests pass (41 test files)
✅ **Type Checking**: 0 TypeScript errors
✅ **Linting**: 0 ESLint errors

---

## Root Cause Analysis

### Why Did Researcher Run Away?

The issue was **protocol mismatch**:

```
Expected Protocol:
Call 1: Handshake (recordCall returns true, tracker at 1/1)
Call 2: Execution (recordCall returns true, tracker at 2/1)
        ↑ This call should be allowed because limit=2

Broken Protocol (with limit=1):
Call 1: Handshake (recordCall returns true, tracker at 1/1) ✅
Call 2: Execution (recordCall returns FALSE, tracker stays at 1/1) ❌
        → AI sees "blocked" and retries
        → Tool returns error message with blocked=true
        → AI interprets error and retries again
        → Loop continues 100+ times
```

The AI agent was **correctly implementing its protocol** (retry on failure), but the tool limit was wrong. When limit was set to 1 but the tool needs 2 calls, it created an impossible situation.

---

## Lessons Learned

1. **Tool limits must match protocol requirements**
   - Scrape protocol requires exactly 2 calls
   - Limit must be ≥ 2

2. **AI agents will retry on errors**
   - Tool blocking should either succeed or fail decisively
   - Ambiguous responses lead to retry loops
   - Clear error messages help AI understand phase transitions

3. **TUI rendering needs safety checks**
   - ANSI codes add invisible characters
   - Off-by-one errors are subtle
   - Final truncation pass prevents crashes

---

## Files Modified

- `src/utils/tool-usage-tracker.ts` - Fix scrape limit and messages
- `src/tool.ts` - Abort signal handling
- `src/tui/research-panel.ts` - TUI safety truncation
- `test/unit/utils/tool-usage-tracker.test.ts` - Update test assertions

---

## Status: ✅ RESOLVED

All identified issues fixed and verified with passing tests.
