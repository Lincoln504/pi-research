# Pi Changes Quick Reference (0.68 → 0.71.0)
## Actionable Recommendations for pi-research

---

## Critical Finding: SDK Event Structure Bug ✅ FIXED

**Issue:** pi-research was reading `toolResults` from `message_end` event (which doesn't have it) instead of `tool_execution_end` event (which has `result`).

**Impact:**
- Scrape context gate never activated → 350K-390K token contexts
- Researcher sessions extremely slow

**Status:** ✅ Already fixed in FINAL_FIXES_APPLIED.md

---

## High-Priority Integrations

### 1. Add `terminate: true` to Research Tool
**Version:** 0.69.0
**Benefit:** Skip automatic follow-up LLM turn, saving cost
**Impact:** ~10-20% cost reduction per research query

```typescript
// In research tool result
return {
    content: [textResult],
    details: { totalTokens, synthesisComplete },
    terminate: synthesisComplete  // ✅ Skip follow-up if done
};
```

---

### 2. Implement Custom Working Indicators
**Version:** 0.68.0
**Benefit:** Better visual feedback for research state
**Impact:** Improved UX

```typescript
// Animated indicator for active researchers
ctx.ui.setWorkingIndicator({
    type: 'animated',
    frames: ['🔍 Searching...', '📊 Analyzing...', '💭 Synthesizing...'],
    interval: 1000
});

// Static for queued researchers
ctx.ui.setWorkingIndicator({
    type: 'static',
    text: '📋 Research queued'
});

// Hide when complete
ctx.ui.setWorkingIndicator({ type: 'hidden' });
```

---

### 3. Add Autocomplete for Scraped URLs
**Version:** 0.69.0
**Benefit:** Quick access to scraped links in prompts
**Impact:** Better researcher efficiency

```typescript
ctx.ui.addAutocompleteProvider({
    trigger: '@',  // Activate on @
    handler: async (input) => {
        return scrapedLinks.filter(url =>
            url.toLowerCase().includes(input.toLowerCase())
        );
    }
});
```

---

### 4. Make Provider Timeout/Retry Configurable
**Version:** 0.70.1
**Benefit:** Users can adjust for long sessions
**Impact:** Better reliability

```typescript
// config.ts
interface Config {
    researcherTimeoutMs?: number;
    researcherMaxRetries?: number;
    researcherMaxRetryDelayMs?: number;
}

// Default values
const DEFAULTS: Config = {
    researcherTimeoutMs: 240000,      // 4 minutes
    researcherMaxRetries: 3,
    researcherMaxRetryDelayMs: 5000,
    // ...
};
```

---

## Medium-Priority Integrations

### 5. Use `message_end` for Report Length Enforcement
**Version:** 0.71.0
**Benefit:** Enforce evaluator input size without truncation
**Impact:** Cleaner reports

```typescript
pi.on('message_end', (event) => {
    if (isResearcherReport(event.message)) {
        if (event.message.content.length > MAX_EVALUATOR_REPORT_LENGTH) {
            return {
                message: {
                    ...event.message,
                    content: event.message.content.slice(0, MAX_EVALUATOR_REPORT_LENGTH) +
                            '\n\n[Report truncated for evaluator input. Full report preserved.]'
                };
            };
        }
    }
});
```

---

### 6. Enforce `thinkingLevel: 'off'` via Observation
**Version:** 0.71.0
**Benefit:** Ensure researchers don't accidentally enable thinking
**Impact:** Consistent performance

```typescript
pi.on('thinking_level_select', (event) => {
    if (isResearcherSession(ctx) && event.level !== 'off') {
        logger.warn(`[Orchestrator] Researcher tried to enable thinking, forcing back to 'off'`);
        pi.setThinkingLevel('off');
    }
});
```

---

### 7. Enable Terminal Progress Indicators
**Version:** 0.70.0
**Benefit:** Show research progress in terminal title/tab
**Impact:** Better visibility

```json
// settings.json
{
    "terminal": {
        "showTerminalProgress": true
    }
}
```

---

## New Providers Available

### Consider for Research Use Cases:

| Provider | Version | Auth | Use Case |
|----------|---------|------|----------|
| DeepSeek | 0.70.1 | `DEEPSEEK_API_KEY` | Cost-effective, good reasoning |
| Fireworks | 0.68.1 | `FIREWORKS_API_KEY` | Fast inference |
| Cloudflare Workers AI | 0.70.6 | `CLOUDFLARE_API_KEY` | Edge inference |
| Cloudflare AI Gateway | 0.71.0 | `CLOUDFLARE_*` | Routing/proxy |
| Moonshot AI | 0.71.0 | `MOONSHOT_API_KEY` | Alternative option |

### Removed Providers:
- ❌ Google Gemini CLI (0.71.0) - Use Google Vertex instead
- ❌ Google Antigravity (0.71.0) - No longer supported

---

## New Settings

### Add to Documentation:

```json
{
    "retry": {
        "provider": {
            "timeoutMs": 240000,      // Researcher timeout
            "maxRetries": 3,           // Max retries
            "maxRetryDelayMs": 5000    // Delay between retries
        }
    },
    "terminal": {
        "showTerminalProgress": false,  // Show in terminal tab
        "imageWidthCells": 60          // Tool output image width
    },
    "warnings": {
        "anthropicExtraUsage": false    // Suppress during long research
    }
}
```

---

## Breaking Changes (All Already Handled ✅)

| Version | Change | Status |
|---------|--------|--------|
| 0.68.0 | Tool selection: `string[]` instead of `Tool[]` | ✅ Already correct |
| 0.68.0 | Resource loader requires explicit cwd | ✅ Already correct |
| 0.69.0 | TypeBox 1.x migration | ✅ Already migrated |
| 0.70.0 | OSC progress disabled by default | Document in settings |
| 0.69.0 | Session replacement invalidates captured refs | ✅ Not used |

---

## Relevant Bug Fixes

### Improved Reliability:
- ✅ Provider retry/timeout settings now work (0.70.1)
- ✅ Auto-retry for transient HTTP/2 failures (0.70.0)
- ✅ Better Bedrock support (0.70.x)
- ✅ PowerShell output fixes (0.71.0)
- ✅ Empty `tools` arrays handled correctly (0.70.3)
- ✅ Symlinked resources deduplicated (0.70.3)

### Improved Security:
- ✅ HTML export sanitization (0.69.0)
- ✅ Grep/find argument injection fixes (0.71.0)
- ✅ Markdown link URL sanitization (0.71.0)

### Improved Performance:
- ✅ OpenAI prompt caching improvements (0.68.0)
- ✅ Parallel tool-call row feedback (0.68.1)
- ✅ Better auto-retry behavior (0.70.x)

---

## SDK API Quick Reference

### Event Subscription:

```typescript
session.subscribe((event) => {
    switch (event.type) {
        case 'tool_execution_end':
            // ✅ Tool result is here: event.result
            console.log(`Tool ${event.toolName} result:`, event.result);
            break;

        case 'message_end':
            // ❌ NO toolResults field here, just the message
            console.log(`Message ended:`, event.message);
            break;

        case 'thinking_level_select':
            // Observe thinking level changes
            console.log(`Thinking: ${event.level}`);
            break;
    }
});
```

### Tool Result Termination:

```typescript
// Skip follow-up LLM turn
return {
    content: [textResult],
    details: { ... },
    terminate: true  // ✅ No automatic follow-up
};
```

### Message Replacement:

```typescript
// In message_end handler
return {
    message: {
        ...event.message,
        content: modifiedContent
    }
};
```

---

## Migration Checklist

### Must Do (Breaking Changes):
- [x] Tool selection API (0.68.0) - Already using `string[]`
- [x] Resource loader cwd (0.68.0) - Already passing cwd
- [x] TypeBox 1.x (0.69.0) - Already using `typebox`
- [x] Event structure (Bug 1) - Already fixed

### Should Do (High Value):
- [ ] Add `terminate: true` to research tool
- [ ] Implement custom working indicators
- [ ] Add URL autocomplete provider
- [ ] Make retry/timeout settings configurable

### Could Do (Medium Value):
- [ ] Use `message_end` for report enforcement
- [ ] Enforce `thinkingLevel: 'off'` via observation
- [ ] Enable terminal progress indicators
- [ ] Document new settings

---

## Summary

### What's Fixed:
- ✅ SDK event structure bug (scrape gate now works)
- ✅ LLM timing (LIFO stack)
- ✅ Query budgets (L2=20, L3=30)
- ✅ Timeout enforcement
- ✅ All breaking changes already handled

### What's New:
- 🆕 Terminate tool results (cost savings)
- 🆕 Custom working indicators (better UX)
- 🆕 Autocomplete providers (convenience)
- 🆕 Thinking level observation (consistency)
- 🆕 Message end replacement (report enforcement)
- 🆕 5 new providers (more options)
- 🆕 Retry/timeout settings (reliability)

### What's Recommended:
1. **Implement:** `terminate: true` in research tool (quick win)
2. **Implement:** Custom working indicators (better UX)
3. **Implement:** URL autocomplete (convenience)
4. **Consider:** Report length enforcement via `message_end`
5. **Consider:** Thinking level enforcement
6. **Document:** New settings and providers

---

**Version:** 1.0
**Last Updated:** 2026-05-01
**Pi Version:** 0.71.0
**pi-research Version:** 0.1.13
