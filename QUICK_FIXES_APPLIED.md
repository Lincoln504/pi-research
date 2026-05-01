# Quick Fixes Applied

**Date:** 2026-05-01
**Status:** ✅ Complete
**Files Modified:** 3 (`src/tool.ts`, `src/index.ts`, `src/orchestration/deep-research-orchestrator.ts`)

---

## Summary

Applied 3 high-priority Pi feature recommendations that provide immediate UX and reliability benefits with minimal code changes.

---

## Changes Made

### 1. ✅ Added `prepareArguments` Hook to Research Tool

**File:** `src/tool.ts`

**Purpose:** Normalize tool arguments before validation to handle different LLM argument formats (string vs number for depth).

**Implementation:**
```typescript
prepareArguments: (args: unknown) => {
  const rawArgs = args as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    query: rawArgs['query'] ?? '',
    model: rawArgs['model'],
  };

  // Handle depth - accept string or number
  const rawDepth = rawArgs['depth'];
  if (rawDepth !== undefined && rawDepth !== null) {
    if (typeof rawDepth === 'string') {
      const parsed = parseInt(rawDepth, 10);
      normalized['depth'] = isNaN(parsed) ? 0 : Math.max(0, Math.min(3, parsed));
    } else if (typeof rawDepth === 'number') {
      normalized['depth'] = Math.max(0, Math.min(3, rawDepth));
    } else {
      normalized['depth'] = 0;
    }
  } else {
    normalized['depth'] = 0; // Default to quick mode
  }

  return normalized;
}
```

**Benefits:**
- Better compatibility with different LLM argument formats
- Reduced tool call errors due to malformed arguments
- Cleaner user experience
- Handles both `"depth": "1"` and `"depth": 1` formats

**Effort:** Low (simple hook function)

---

### 2. ✅ Added `renderShell: "self"` to Research Tool

**File:** `src/tool.ts`

**Purpose:** Use custom shell for large research output to avoid TUI flicker on large results.

**Implementation:**
```typescript
// Use custom shell for large research output to avoid flicker
renderShell: 'self',
```

**Benefits:**
- Cleaner display of research synthesis results
- Better readability of large research outputs
- Reduced TUI flicker on large results
- More stable UI experience

**Effort:** Low (single field addition)

---

### 3. ✅ Added Provider Response Monitoring

**File:** `src/index.ts`

**Purpose:** Monitor `after_provider_response` events for provider diagnostics (rate limits, server errors).

**Implementation:**
```typescript
// Monitor provider responses for diagnostics
pi.on('after_provider_response', (event: any, ctx: any) => {
  const { status, headers } = event;

  // Log provider status for diagnostics
  if (status >= 500) {
    logger.warn(`[pi-research] Provider server error: ${status}`, { headers });
  } else if (status === 429) {
    const retryAfter = headers?.['retry-after'];
    logger.warn(`[pi-research] Rate limited by provider`, { retryAfter });
    if (retryAfter) {
      ctx.ui?.notify?.(`Rate limited. Retry after ${retryAfter}s`, 'warning');
    }
  } else if (status >= 400) {
    logger.warn(`[pi-research] Provider error: ${status}`, { headers });
  }
});
```

**Benefits:**
- Better visibility into provider errors
- Rate limit detection and handling
- User notification when rate limited
- Improved debugging for provider issues

**Effort:** Low (simple event handler)

---

### 4. ✅ Enhanced Researcher System Prompts via `before_agent_start`

**File:** `src/index.ts`

**Purpose:** Add researcher-specific guidelines dynamically when researcher sessions start, improving research quality without modifying prompt files.

**Implementation:**
```typescript
pi.on('before_agent_start', async (event: any, ctx: any) => {
  const researchPrompt = loadPrompt('research-tool-usage');
  
  // Check if this is a researcher session
  const isResearcher = ctx?.model?.id?.toLowerCase().includes('researcher') ||
                      event.systemPrompt?.toLowerCase().includes('researcher');

  if (isResearcher) {
    // Add researcher-specific guidelines for better research quality
    const researcherGuidelines = `

## Research Guidelines (Auto-Injected)

- **Focus on Evidence**: Gather facts and evidence from reliable sources
- **Avoid Speculation**: Only report what sources explicitly confirm
- **Cite Sources**: Explicitly cite sources when making claims
- **Flag Uncertainty**: Mark information as uncertain when sources disagree
- **Be Thorough**: Use the full tool budget for comprehensive coverage
- **Stay Focused**: Maintain focus on the assigned research goal
`;
    return {
      systemPrompt: event.systemPrompt + '\n\n' + researchPrompt + researcherGuidelines
    };
  }

  return {
    systemPrompt: event.systemPrompt + '\n\n' + researchPrompt
  };
});
```

**Benefits:**
- Dynamic researcher behavior tuning
- Better research quality
- No need to modify prompt files
- Separation of concerns (tool usage vs. researcher behavior)

**Effort:** Low (event handler enhancement)

---

### 5. ✅ Added `/research-reload` Command for Hot Reload

**File:** `src/index.ts`

**Purpose:** Enable hot reload of the pi-research extension to apply configuration changes without restarting Pi.

**Implementation:**
```typescript
pi.registerCommand('research-reload', {
  description: 'Reload pi-research extension (hot reload config changes)',
  handler: async (_args, ctx) => {
    try {
      ctx.ui.notify('🔄 Reloading pi-research...', 'info');
      
      // Use Pi's reload function if available
      if (typeof ctx.reload === 'function') {
        await ctx.reload();
        ctx.ui.notify('✅ pi-research reloaded successfully', 'info');
      } else {
        // Fallback: notify user that reload is not available
        ctx.ui.notify('⚠️ Hot reload not available - restart Pi to reload', 'warning');
        logger.warn('[pi-research] ctx.reload() not available in this Pi version');
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[pi-research] /research-reload failed:', error);
      ctx.ui.notify(`❌ Reload failed: ${message}`, 'error');
    }
  },
});
```

**Benefits:**
- Hot reload of configuration changes
- No need to restart Pi
- Better development workflow
- User-friendly error handling with graceful fallback

**Effort:** Low (single command)

---

### 6. ✅ Enhanced Progress Tracking with LLM Status Updates

**File:** `src/orchestration/deep-research-orchestrator.ts`

**Purpose:** Update researcher status to show when the LLM is thinking vs. when it's scraping, providing better user visibility into research progress.

**Implementation:**
```typescript
if (event.type === 'message_start') {
    llmCallStartStack.push(Date.now());
    logger.debug(`[Orchestrator] ${this.elapsed()} LLM call started for ${internalId} (stack depth: ${llmCallStartStack.length})`);
    // Update status to show LLM is thinking
    updateSliceStatus(this.options.panelState, label, 'Thinking...');
    this.options.onUpdate();
}
if (event.type === 'message_end') {
    const startTime = llmCallStartStack.pop() || Date.now();
    const duration = Date.now() - startTime;
    logger.debug(`[Orchestrator] ${this.elapsed()} LLM call completed for ${internalId} in ${duration}ms (${(duration/1000).toFixed(1)}s)`);
    // Update status after LLM call completes
    updateSliceStatus(this.options.panelState, label, 'Scraping...');
    this.options.onUpdate();
}
```

**Benefits:**
- Real-time LLM progress display
- Better user feedback during long inference
- Reduced perception of being "stuck"
- Clear visibility into what the researcher is doing

**Effort:** Low (enhanced event handling)

---

## Already Implemented Features ✅

The following features from the recommendations were already present in the codebase:

### ✅ `promptSnippet` and `promptGuidelines` (Already Present)

**File:** `src/tool.ts`

The research tool already had these fields populated:
- `promptSnippet: 'Conduct multi-agent web/internet research'`
- `promptGuidelines: [...]` (7 detailed guidelines)

### ✅ `before_agent_start` Hook (Already Present)

**File:** `src/index.ts`

The extension already uses `before_agent_start` to append research tool usage instructions to the system prompt.

### ✅ `ctx.signal` Usage (Already Present)

**File:** `src/tool.ts` and other tools

The abort signal is already passed through to tool execution and used in various places:
- Quick research: `signal?.addEventListener('abort', ...)`
- Deep research: `await orchestrator.run(signal)`
- Scrape tool: `await scrape(..., signal)`

---

## Type Check Status

✅ **Type Check Passed:** `npm run type-check` - No errors

---

## Impact Summary

| Fix | Impact | Effort | Status |
|-----|--------|--------|--------|
| `prepareArguments` | Better argument handling, fewer errors | Low | ✅ Complete |
| `renderShell: "self"` | Cleaner large output display | Low | ✅ Complete |
| `after_provider_response` | Better provider diagnostics | Low | ✅ Complete |
| Enhanced `before_agent_start` | Better researcher quality, dynamic guidelines | Low | ✅ Complete |
| `/research-reload` command | Hot reload support, better DX | Low | ✅ Complete |
| LLM status updates | Better progress visibility | Low | ✅ Complete |

---

## Next Steps (Medium Priority)

The following medium-priority improvements could be implemented next:

1. **Custom dialogs for research configuration**
   - Interactive configuration UI
   - No need for environment variables
   - Effort: Medium (custom dialog component)

2. **Add autocomplete for scraped URLs**
   - Quick reference to previously scraped URLs
   - Convenience for mentioning sources
   - Effort: Medium (requires URL tracking)

3. **Customize hidden thinking label**
   - Better clarity when thinking is collapsed
   - Distinguish researcher thinking from other messages
   - Effort: Low (single function call)

4. **Consider AgentSessionRuntime for session management**
   - Proper session lifecycle management
   - Better cross-cwd session handling
   - Cleaner session replacement
   - Effort: High (architectural change)

---

## Completed Improvements

The following improvements from the recommendations have been completed:

✅ **High Priority:**
- `prepareArguments` hook for argument normalization
- `renderShell: "self"` for large output handling
- `after_provider_response` monitoring for provider diagnostics

✅ **Medium Priority:**
- Enhanced `before_agent_start` with researcher-specific guidelines
- Fine-grained progress tracking with LLM status updates
- Hot reload support via `/research-reload` command

---

## Notes

- All changes are backward compatible
- No breaking changes to existing functionality
- All fixes are isolated and reversible if needed
- Changes follow Pi's best practices for extension development

---

**Fixes Applied:** 6
**Type Errors:** 0
**Lines Changed:** ~100
**Effort:** ~1 hour
**Risk:** Low
