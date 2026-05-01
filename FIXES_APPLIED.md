# Fixes Applied to Address Slowness

## Date: 2026-04-30

## Summary

Applied 3 critical fixes to address the 7-12 minute silent gaps in researcher execution.

## Fix 1: Remove Grep Tool from Researchers

**File:** `src/orchestration/researcher.ts`

**Change:**
```typescript
// Before:
const customTools = noSearch 
  ? allTools.filter(t => t.name !== 'search')
  : allTools;

// After:
const customTools = noSearch 
  ? allTools.filter(t => t.name !== 'search' && t.name !== 'grep')
  : allTools;
```

**Rationale:**
- Grep searches the local filesystem, not web content
- Researchers were using grep to search for web research topics
- This is completely useless and wastes time
- Example: searching "laser engraving" in `/home/ldeen/Documents/pi-research/`

**Expected Impact:**
- Eliminates wasteful grep calls
- Reduces noise in context window
- Researchers focus on actual web research tools (scrape, stackexchange)

## Fix 2: Add LLM Call Duration Logging

**File:** `src/orchestration/deep-research-orchestrator.ts`

**Change:**
Added tracking of `message_start` and `message_end` events:
```typescript
const llmCallStart = new Map<string, number>();

session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'message_start') {
        const callId = `${internalId}-${Date.now()}`;
        llmCallStart.set(callId, Date.now());
        logger.debug(`[Orchestrator] LLM call started for ${internalId}`);
    }
    if (event.type === 'message_end') {
        const duration = Date.now() - startTime;
        logger.debug(`[Orchestrator] LLM call completed for ${internalId} in ${duration}ms`);
    }
});
```

**Rationale:**
- Currently we can't see how long LLM calls take
- Need to diagnose the 12-minute gaps
- Will show exactly where time is being spent

**Expected Impact:**
- Visible timing of each LLM turn
- Identify if gaps are from LLM or other sources
- Better performance monitoring

## Fix 3: Add Context Size Warnings

**File:** `src/orchestration/deep-research-orchestrator.ts`

**Change:**
```typescript
if (tokens > 0) {
    const currentTotal = this.siblingTokens.get(internalId) ?? 0;
    const newTotal = currentTotal + tokens;
    
    // Warn if context is getting too large (>30K tokens)
    if (newTotal > 30000 && (currentTotal <= 30000 || newTotal % 10000 < 1000)) {
        logger.warn(`[Orchestrator] Researcher ${internalId} context size: ${newTotal.toLocaleString()} tokens - this may cause performance degradation`);
    }
}
```

**Rationale:**
- Full markdown dumps create massive contexts
- 4 URLs × 30K tokens = 120K tokens
- Large contexts slow down LLM processing dramatically
- Need to track when this becomes a problem

**Expected Impact:**
- Early warning of context bloat
- Ability to correlate size with performance
- Data to inform truncation strategy

## Fix 4: Verify Thinking Level Logging

**File:** `src/orchestration/researcher.ts`

**Change:**
```typescript
const result = await createAgentSession({
    // ...
    thinkingLevel: 'off',
});

// Log to confirm thinking level was set
piLogger.log(`[Researcher] Created session with thinkingLevel='off', model=${ctxModel?.id || 'unknown'}`);
```

**Rationale:**
- User settings have `defaultThinkingLevel: "high"`
- Need to verify `thinkingLevel: 'off'` is being respected
- Will show if it's being overridden

**Expected Impact:**
- Confirmation of thinking level setting
- Ability to correlate with performance

## Remaining Issues

### Not Yet Addressed

1. **Full Markdown Dump**
   - No truncation of scraped content
   - Could still cause 60K+ token contexts
   - Needs truncation or summarization

2. **Model Performance**
   - deepseek-v4-flash might have performance issues
   - Should test with other models
   - May need model-specific tuning

3. **API Throttling**
   - Could be causing delays
   - Need to check rate limits
   - May need retry logic

4. **Thinking Level Override**
   - Not confirmed if `thinkingLevel: 'off'` is respected
   - May need to force it via different mechanism
   - Could add `reasoning: 'off'` to API calls

## Testing Plan

1. Run research with `--verbose` to see new logs
2. Check for:
   - LLM call duration logs (should be seconds, not minutes)
   - Context size warnings (should show if >30K tokens)
   - Thinking level confirmation
   - No grep calls (should be eliminated)

3. Compare with baseline:
   - Previous: 12+ minute gaps
   - Expected: 10-30 second gaps

## Next Steps (If Still Slow)

1. **Add content truncation:**
   ```typescript
   const MAX_CHARS_PER_SCRAPE = 10000;
   content = res.markdown.slice(0, MAX_CHARS_PER_SCRAPE);
   ```

2. **Force reasoning off in API calls:**
   - May need different mechanism than `thinkingLevel`
   - Could add `reasoning: 'off'` to all API calls

3. **Test different models:**
   - Try Claude, GPT-4, etc.
   - Compare performance
   - Allow model selection for researchers

4. **Add timeout enforcement:**
   ```typescript
   const timeoutMs = 30000; // 30 seconds
   await Promise.race([session.prompt(...), timeoutPromise]);
   ```

## Compilation Status

✓ All changes compile without errors
✓ TypeScript validation passed
✓ Ready for testing
