# Deep Investigation: Report Injection & Link Pooling

## Executive Summary

**🔴 CRITICAL ISSUE FOUND**: Report injection mechanism uses non-existent methods

---

## Issue 1: Report Injection - BROKEN ❌

### Current Implementation (swarm-orchestrator.ts:207-212)

```typescript
targetSession.abort().catch(() => {});
(targetSession as any).appendMessage({
  role: 'user',
  content: [{ type: 'text', text: `UPDATE: Sibling ${finished.id} findings:\n${finished.report}` }],
  timestamp: Date.now()
});
(targetSession as any).continue().catch(() => {});
```

### Problem

Examined AgentSession interface from pi-coding-agent SDK (agent-session.d.ts):

```typescript
// AVAILABLE METHODS:
- prompt(text, options?)       ✅ Send a prompt
- steer(text, images?)         ✅ Queue steering message
- followUp(text, images?)      ✅ Queue follow-up message  
- sendUserMessage(content)     ✅ Send user message
- sendCustomMessage(message)   ✅ Send custom message
- abort()                      ✅ Abort current operation
- subscribe(listener)          ✅ Subscribe to events
- dispose()                    ✅ Cleanup

// MISSING/BROKEN IN OUR CODE:
- appendMessage()              ❌ DOES NOT EXIST
- continue()                   ❌ DOES NOT EXIST
```

### Root Cause

The code attempts to:
1. `abort()` the target session (valid)
2. `appendMessage()` with the sibling report (method doesn't exist)
3. `continue()` to resume (method doesn't exist)

The `(as any)` casting hides these type errors, but they fail at runtime.

### Correct Implementation

Based on AgentSession API, the proper way to inject while running is:

```typescript
// Option 1: Use steer() - queues message to interrupt current operation
await targetSession.steer(`SIBLING REPORT:\n${finished.report}`);

// Option 2: Use sendUserMessage with steer delivery
await targetSession.sendUserMessage(
  `UPDATE: Sibling ${finished.id} findings:\n${finished.report}`,
  { deliverAs: 'steer' }  // Delivered after current tool calls
);

// Option 3: Use sendCustomMessage for structured delivery
await targetSession.sendCustomMessage({
  customType: 'sibling_report',
  content: { siblingId: finished.id, report: finished.report },
  display: 'Sibling Report',
  details: { source: 'orchestrator' }
}, { deliverAs: 'steer' });
```

**Recommended**: Option 2 (`sendUserMessage` with `deliverAs: 'steer'`) because:
- ✅ Properly queues during streaming
- ✅ Natural message format
- ✅ No need for abort/continue hacks
- ✅ Integrated with session's message queue management

---

## Issue 2: Link Pool Management - PARTIALLY WORKING ⚠️

### Current Implementation

**In swarm-orchestrator.ts (lines 145-154):**
```typescript
const tools = createResearchTools({
  searxngUrl: this.options.searxngUrl,
  ctx: this.options.ctx,
  tracker,
  getGlobalState: () => this.state,                    // ✅ Good
  updateGlobalLinks: (links: string[]) => {            // ✅ Good
    this.state.allScrapedLinks = [...new Set([...this.state.allScrapedLinks, ...links])];
    this.stateManager.save(this.state);
  }
});
```

**Tool Usage (lines 166):**
```typescript
(session as any).agent.customTools = tools;
```

### Problems

1. **Late Binding** 🔴
   - Tools are created in `executeSibling()`
   - Session is created in `createResearcherSession()` with **dummy** getGlobalState/updateGlobalLinks
   - Tools are reassigned AFTER session creation: `session.agent.customTools = tools`
   - **Issue**: If session reads tools during init, it gets dummies, not real ones

2. **Timing Window** 🔴
   - Tools are replaced AFTER `createResearcherSession()` returns
   - If session eagerly initializes tool registry, it won't see real tools yet
   - Race condition between tool setup and tool discovery

3. **Dummy Functions in researcher.ts** 🔴
   ```typescript
   getGlobalState: () => ({} as any),        // Returns empty object!
   updateGlobalLinks: () => {}               // No-op!
   ```
   - If tools are used before reassignment, they operate on dead/empty state

### Link Pool Verification

**Does scraped link pool work?**

✅ **Mostly works IF tools get reassigned before first use**

Flow:
1. Orchestrator creates tools with real `getGlobalState()`
2. Tools read from `this.state.allScrapedLinks`
3. Scrape tool calls `updateGlobalLinks()` 
4. Orchestrator's closure captures real state
5. Global pool updated in `this.state`
6. Next sibling sees links in `buildSiblingReportsContext()`

**But it's fragile** because:
- Initial tool copy gets dummies
- Reassignment happens late
- No guarantee of proper timing

---

## Issue 3: Sibling Report Context Injection - WORKING ✅

### Implementation (swarm-orchestrator.ts:235-251)

```typescript
private buildSiblingReportsContext(_currentAspect: ResearchSibling): string {
  const currentRound = this.state.currentRound;
  const completedInRound = Object.values(this.state.aspects)
    .filter(a => a.id.startsWith(`${currentRound}.`) && a.status === 'completed' && a.report)
    .sort((a, b) => {
      const aParts = a.id.split('.');
      const bParts = b.id.split('.');
      const aNum = parseInt(aParts[1] ?? '0');
      const bNum = parseInt(bParts[1] ?? '0');
      return aNum - bNum;
    });

  if (completedInRound.length === 0) {
    return '## Reports from Earlier Researchers\n\n*No earlier researchers have completed in this round yet.*';
  }

  let context = '## Reports from Earlier Researchers\n\n';
  for (const completed of completedInRound) {
    const displayNum = getDisplayNumber(this.state, completed.id);
    context += `### Researcher ${displayNum}: ${completed.query}\n\n${completed.report}\n\n`;
  }
  return context;
}
```

**Status**: ✅ **This part is solid**
- Filters correct siblings (completed, same round)
- Sorts by sibling number
- Formats with display numbers
- Builds markdown context
- Injected into researcher prompt at startup

**However**:
- Reports are only visible at startup
- If sibling finishes AFTER researcher starts, new report not injected (except via steer/followUp)
- Real-time injection is broken (appendMessage/continue don't exist)

---

## Issue 4: Integration with pi-coding-agent SDK

### What We're Using Correctly

✅ `prompt()` - Start researcher with query
✅ `subscribe()` - Listen for events (tokens, tool execution)
✅ `abort()` - Stop current operation
✅ Tool registration via `customTools`
✅ Session management via SessionManager
✅ Resource loader for system prompts

### What We're Using Incorrectly

❌ `appendMessage()` / `continue()` - Don't exist, use `sendUserMessage()` or `steer()` instead
❌ `agent.customTools` direct reassignment - Fragile, no guarantee of timing
⚠️ Dummy tool closures in researcher.ts - Should pass real closures from start

### SDK Capabilities We're NOT Using

- `steer()` - Perfect for interrupting with new info
- `followUp()` - Queue messages after current operation
- `sendCustomMessage()` - Structured messages with metadata
- `sendUserMessage()` - Proper user message API
- Event subscription with `AgentSessionEvent` types - Could use for better orchestration

---

## Robustness Assessment

### Report Injection: 🔴 BROKEN
- **Reliability**: 0% (methods don't exist)
- **Will this work?** No, always fails at runtime
- **Impact**: Siblings never receive reports from earlier completers

### Link Pool Management: ⚠️ FRAGILE
- **Reliability**: 70% (works if timing is right, but fragile)
- **Will this work?** Mostly, if session tool reassignment happens before first tool use
- **Impact**: Link sharing works, but could fail under edge cases

### Sibling Context at Startup: ✅ WORKING
- **Reliability**: 95% (solid markdown injection)
- **Will this work?** Yes, contexts built and injected correctly
- **Impact**: Siblings know about earlier findings at start

### Integration with SDK: ⚠️ PARTIALLY ALIGNED
- **Reliability**: 50% (using some APIs correctly, some incorrectly)
- **Best practices violated**: Late tool binding, dummy closures, non-existent method calls
- **Impact**: Fragile, non-idiomatic use of SDK

---

## What's Actually Happening (Best Case Scenario)

```
Sibling 1 Starts (10:00)
  ↓ reads tools with dummy closures
  ↓ session.agent.customTools reassigned (probably succeeds)
  ↓ tools now use real closures
  ↓ starts researching
  ↓ scrapes links → calls updateGlobalLinks() ✅
  ↓ allScrapedLinks updated in orchestrator state ✅

Sibling 1 Completes (10:30)
  ↓ report stored in state.aspects['1.1']
  ↓ handleSiblingCompletion() called
  ↓ attempts targetSession.appendMessage() ❌ FAILS
  ↓ attempt targetSession.continue() ❌ FAILS
  ↓ exception caught silently

Sibling 2 Was Running (still going at 10:30)
  ❌ NEVER receives Sibling 1's report via injection
  ✅ BUT will see link pool updated (if update succeeded before completion)
  ✅ AND will see report in startup context when prompt is read (too late)

Sibling 2 Completes (10:45)
  ↓ Promoted to Lead Evaluator
  ✅ Sees both reports in buildSiblingReportsContext() ✅
  ✅ Can synthesize

Lead Evaluator Turn (10:50)
  ✅ Works correctly
```

---

## Recommendations

### 1. Fix Report Injection (CRITICAL) 🔴

**Current (broken)**:
```typescript
targetSession.abort().catch(() => {});
(targetSession as any).appendMessage({...});
(targetSession as any).continue().catch(() => {});
```

**Fixed**:
```typescript
// Queue report as steering message (will be delivered after current tool calls)
await targetSession.steer(
  `SIBLING UPDATE:\n\nFIndings from Researcher ${finished.id}:\n\n${finished.report}`
);
```

### 2. Fix Tool Binding (HIGH) ⚠️

**Current (fragile)**:
```typescript
// In executeSibling
const tools = createResearchTools({...}); // Created here
const session = await createResearcherSession({...}); // Session created with dummies
(session as any).agent.customTools = tools; // Reassigned after creation
```

**Fixed**:
```typescript
// Pass tools/closures to createResearcherSession directly
const session = await createResearcherSession({
  cwd, ctxModel, modelRegistry, settingsManager,
  systemPrompt, searxngUrl, extensionCtx,
  getGlobalState: () => this.state,        // ✅ Real closures
  updateGlobalLinks: (links) => {
    this.state.allScrapedLinks = [...new Set([...this.state.allScrapedLinks, ...links])];
    this.stateManager.save(this.state);
  }
});
```

### 3. Verify Real-Time Injection Works

After fixing `steer()` usage, verify:
- [ ] Sibling 1 completes
- [ ] Sibling 2 receives report via `steer()`
- [ ] Sibling 2 acknowledges receipt
- [ ] Sibling 2 uses injected report in answer
- [ ] Sibling 3 sees both reports in startup context

### 4. Add Logging for Injection

```typescript
logger.log(`[swarm] Injecting report from ${finished.id} to ${target.id}`);
await targetSession.steer(`SIBLING REPORT:\n${finished.report}`);
logger.log(`[swarm] Report queued for ${target.id}`);
```

---

## Conclusion

| Component | Status | Risk |
|-----------|--------|------|
| Report Injection (real-time) | 🔴 Broken | CRITICAL - Methods don't exist |
| Link Pool Sharing | ⚠️ Fragile | HIGH - Late binding, timing window |
| Report Context at Startup | ✅ Working | LOW - Solid implementation |
| SDK Integration | ⚠️ Partial | MEDIUM - Non-idiomatic usage |

**Priority Fixes**:
1. Replace `appendMessage()`/`continue()` with `steer()` (prevents runtime failures)
2. Pass real closures to `createResearcherSession()` (improves reliability)
3. Add logging to verify injection works (enables debugging)
4. Test with actual concurrent researchers (validates architecture)
