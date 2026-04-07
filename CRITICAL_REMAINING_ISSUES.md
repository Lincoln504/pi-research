# Critical Remaining Issues & Fixes Needed

## Issue 1: Incorrect Complexity-to-Sibling Mapping 🔴

### Current Implementation (WRONG)
```typescript
// Line 99 in swarm-orchestrator.ts
initialCount: this.state.complexity === 1 ? 1 : 3
```

Maps to:
- Level 1 → 1 researcher
- Level 2 → 3 researchers  
- Level 3 → 3 researchers

**Problem**: No distinction between 2 and 3. No follow-up rounds defined.

### Correct Mapping (per spec)

**Level 1 (Simple Fact)**: Light research
- Initial: 1-2 researchers
- Follow-ups: 1 follow-up round with 1 researcher (if needed)
- Total possible: 2-3 researchers across 2 rounds max

**Level 2 (Standard Topic)**: Medium research
- Initial: 2-3 researchers
- Follow-ups: 2 rounds with up to 2 researchers each (if needed)
- Total possible: 2-3 + 2 + 2 = 6-7 researchers across 3 rounds

**Level 3 (Deep/Nuanced)**: Deep research
- Initial: 3 researchers
- Follow-ups: 2 rounds with up to 3 researchers each (if needed)
- Total possible: 3 + 3 + 3 = 9 researchers across 3 rounds

### Current Issue: "Runaway Delegation"

No check for max researchers or max rounds. Lead evaluator can keep delegating infinitely.

---

## Issue 2: Last Alive Researcher Not Getting All Context 🔴

### Current Problem

Lead evaluator (promoted from last sibling) only sees:
- Reports from current round only
- Via `buildSiblingReportsContext()` which filters: `a.id.startsWith(`${currentRound}.`)`

### Missing Context

If research spans multiple rounds:
- Round 1: Siblings 1, 2, 3 complete
- Round 2: Siblings 4, 5 complete
- Sibling 5 promoted to Lead

Lead (Sibling 5) should see:
- ✅ Sibling 4 report (same round)
- ❌ Siblings 1-3 reports (previous round) - MISSING!

### Fix Required

Lead evaluator must receive:
```markdown
## All Previous Research Findings

### Round 1
#### Researcher 1: [query]
[report]

#### Researcher 2: [query]
[report]

#### Researcher 3: [query]
[report]

### Round 2
#### Researcher 4: [query]
[report]

[Lead is Researcher 5]
```

---

## Issue 3: System Not Exiting Properly 🔴

### Current Flow

1. Lead evaluator makes decision: synthesize or delegate
2. If synthesize: `this.state.finalSynthesis = decision`
3. `this.resolveCompletion(decision)`
4. → Back to tool.ts
5. → Should return and close

**What's broken**:
- System continues looping even after completion
- Extension doesn't properly return the synthesis
- Tool execution doesn't exit cleanly

### Lead Evaluator Detection Issue

**Current code** (swarm-orchestrator.ts:212-214):
```typescript
if (isRoundComplete(this.state, currentRound)) {
  logger.log(`[swarm] Round ${currentRound} complete. Sibling ${finished.id} promoting to Lead.`);
  await this.promoteToLead(finished, session, signal);
}
```

**Problem**:
- Only called in `handleSiblingCompletion()`
- If that sibling finishes AFTER sibling is already printing, it might not be called
- Need explicit "last alive" detection

---

## Issue 4: Lead Prompt Not Given After Sibling Finishes 🔴

### Current Problem

When last sibling finishes and prints response:
1. `session.prompt(aspect.query)` completes
2. Response captured
3. `handleSiblingCompletion()` called
4. Lead prompt given
5. But session already finished printing

### Fix Required

Lead prompt must be given BEFORE sibling response is finalized, or with explicit continuation:

```typescript
// After sibling completes:
const report = ensureAssistantResponse(session, aspect.id);

// Check if this is last alive
if (isLastAlive(aspect)) {
  // Give lead prompt IMMEDIATELY
  await session.prompt(leadPrompt);
  // Now leadResponse is the final output
  const leadResponse = ensureAssistantResponse(session, aspect.id);
  this.state.finalSynthesis = leadResponse;
}
```

---

## Issue 5: TUI Widget Staying After Abort 🔴

### Current Problem

When user cancels (Ctrl+C, Operation aborted):
1. Abort signal triggered
2. Cleanup called: `ctx.ui.setWidget(widgetId, undefined)`
3. But widget remains visible

**Evidence from user screenshot**:
```
Operation aborted

┌── Research | qwen/qwen3.5-35b-a3b  2.4...
│      │      │     │     │     │     │ ...
│  +1  │  ✓2  │ ✓3  │ ✓4  │ ✓5  │ ✓6  │ ...
│      │      │     │     │     │     │ ...
└──────┴──────┴─────┴─────┴─────┴─────┴─...
```

Widget still displayed despite abort.

### Root Cause

In tool.ts:
```typescript
const cleanup = () => {
  endResearchSession(sessionId);
  cleanupSharedLinks(sessionId);
  ctx.ui.setWidget(widgetId, undefined);      // This may not work
  refreshAllSessions();
  setTimeout(restoreConsole, ...).unref?.();
};

signal?.addEventListener('abort', () => {
  aborted = true;
  cleanup?.();                                 // Called on abort
}, { once: true });
```

**Problem**: `setWidget(widgetId, undefined)` might not remove widget from display.

---

## Fix Strategy

### 1. Fix Complexity Mapping
```typescript
function getInitialSiblingCount(complexity: 1 | 2 | 3): number {
  switch(complexity) {
    case 1: return 1;        // Simple: start with 1
    case 2: return 2;        // Standard: start with 2
    case 3: return 3;        // Deep: start with 3
  }
}

function getMaxRounds(complexity: 1 | 2 | 3): number {
  switch(complexity) {
    case 1: return 2;        // Max 2 rounds for simple
    case 2: return 3;        // Max 3 rounds for standard
    case 3: return 3;        // Max 3 rounds for deep
  }
}

function getMaxSiblingsPerRound(complexity: 1 | 2 | 3): number {
  switch(complexity) {
    case 1: return 2;        // Up to 2 per round for simple
    case 2: return 3;        // Up to 3 per round for standard
    case 3: return 3;        // Up to 3 per round for deep
  }
}
```

### 2. Fix Lead Context
```typescript
private buildAllPreviousReports(): string {
  const allCompleted = Object.values(this.state.aspects)
    .filter(a => a.status === 'completed' && a.report)
    .sort((a, b) => {
      const aRound = parseInt(a.id.split('.')[0] ?? '0');
      const bRound = parseInt(b.id.split('.')[0] ?? '0');
      if (aRound !== bRound) return aRound - bRound;
      const aNum = parseInt(a.id.split('.')[1] ?? '0');
      const bNum = parseInt(b.id.split('.')[1] ?? '0');
      return aNum - bNum;
    });

  if (allCompleted.length === 0) {
    return '## All Research Findings\n\nNo completed research yet.';
  }

  let output = '## All Research Findings\n\n';
  let currentRound = 0;
  
  for (const completed of allCompleted) {
    const round = parseInt(completed.id.split('.')[0] ?? '0');
    if (round !== currentRound) {
      currentRound = round;
      output += `\n### Round ${round}\n\n`;
    }
    const displayNum = getDisplayNumber(this.state, completed.id);
    output += `#### Researcher ${displayNum}: ${completed.query}\n\n${completed.report}\n\n`;
  }

  return output;
}
```

### 3. Fix Lead Promotion & Detection
```typescript
private isLastAliveResearcher(aspect: ResearchSibling): boolean {
  const currentRound = this.state.currentRound;
  const allInRound = Object.values(this.state.aspects)
    .filter(a => a.id.startsWith(`${currentRound}.`));
  
  // Check if this is the only one running
  const running = allInRound.filter(a => a.status === 'running' || a.status === 'completed');
  
  return running.length === 1 || 
         (running.length > 1 && running.every(a => a.status === 'completed' || a.id === aspect.id));
}

private async promoteToLeadIfLastAlive(finished: ResearchSibling, session: AgentSession) {
  if (this.isLastAliveResearcher(finished)) {
    logger.log(`[swarm] ${finished.id} is last alive. Promoting to Lead Evaluator.`);
    await this.doLeadEvaluation(finished, session);
  }
}
```

### 4. Fix TUI Cleanup
```typescript
const cleanup = () => {
  endResearchSession(sessionId);
  cleanupSharedLinks(sessionId);
  // Force widget removal - try multiple approaches
  try {
    ctx.ui.setWidget(widgetId, undefined);
  } catch (err) {
    logger.error('[research] Failed to unset widget:', err);
  }
  // Also try clearing via panelState
  if (panelState.slices) {
    panelState.slices.clear();
  }
  refreshAllSessions();
  setTimeout(restoreConsole, getConfig().CONSOLE_RESTORE_DELAY_MS).unref?.();
};
```

### 5. Fix System Exit
```typescript
private async promoteToLead(_lead: ResearchSibling, session: AgentSession, signal?: AbortSignal) {
  try {
    // Get all previous reports
    const allReportsContext = this.buildAllPreviousReports();
    const remainingAgenda = this.getRemainingAgenda();
    const maxRounds = this.getMaxRoundsForComplexity();
    
    const leadPromptRaw = readFileSync(...);
    const leadPrompt = leadPromptRaw
      .replace('{ROUND_NUMBER}', this.state.currentRound.toString())
      .replace('{MAX_ROUNDS}', maxRounds.toString())
      + '\n\n' + allReportsContext
      + '\n\n' + (remainingAgenda.length > 0 ? ... : 'All agenda items covered');

    // CRITICAL: Give lead prompt explicitly
    await session.prompt(leadPrompt);
    const decision = ensureAssistantResponse(session, 'Lead');

    // Parse decision (JSON = delegate, Markdown = synthesize)
    try {
      const nextQueries = JSON.parse(decision.match(/\[.*\]/s)?.[0] || '[]');
      if (nextQueries.length === 0 || this.state.currentRound >= maxRounds) {
        // SYNTHESIZE - exit here
        this.updateState({ 
          type: 'PROMOTION_DECISION', 
          nextQueries: [], 
          finalSynthesis: decision,
          maxRounds 
        });
        this.resolveCompletion(decision);  // ← This completes the research
        return;
      } else {
        // DELEGATE - continue to next round
        this.updateState({ 
          type: 'PROMOTION_DECISION', 
          nextQueries,
          maxRounds 
        });
        if (this.state.status === 'researching') {
          await this.startRound(signal);
        }
        return;
      }
    } catch {
      // Synthesis fallback
      this.updateState({ type: 'PROMOTION_DECISION', nextQueries: [], finalSynthesis: decision, maxRounds });
      this.resolveCompletion(decision);  // ← Exit
      return;
    }
  } catch (err) {
    logger.error('[swarm] Lead evaluation failed:', err);
    this.rejectCompletion(err);
  }
}
```

---

## Verification Needed

After fixes:

- [ ] Level 1 research uses 1 initial sibling
- [ ] Level 2 research uses 2-3 initial siblings
- [ ] Level 3 research uses 3 initial siblings
- [ ] Max rounds enforced correctly
- [ ] Lead gets ALL previous reports (all rounds)
- [ ] Lead prompt given even after sibling finishes
- [ ] System exits cleanly after synthesis
- [ ] TUI widget removed on abort
- [ ] No runaway delegation

---

## Current Behavior vs Expected

| Scenario | Current | Expected | Fix |
|----------|---------|----------|-----|
| Level 1 starts | 1 sibling | 1 sibling ✅ | None needed |
| Level 2 starts | 3 siblings | 2-3 siblings | Add random 2-3 |
| Level 3 starts | 3 siblings | 3 siblings ✅ | None needed |
| Round 2 delegation | 3 siblings | 2-3 siblings | Add complexity check |
| Lead context | Round-only reports | All reports | buildAllPreviousReports() |
| Lead prompt | After completion | During completion | prompt() before completion |
| System exit | Continues looping | Exits cleanly | Add explicit exit |
| Abort cleanup | Widget stays | Widget removed | Force widget removal |

---

## Priority Order

1. **CRITICAL**: Fix system exit and lead detection (blocks user workflow)
2. **HIGH**: Fix lead context injection (affects quality)
3. **HIGH**: Fix complexity mapping (affects research scope)
4. **MEDIUM**: Fix TUI cleanup (UX issue)
5. **MEDIUM**: Enforce max rounds (prevent runaway delegation)
