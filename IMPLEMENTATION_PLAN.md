# Implementation Plan - All Performance Fixes

**Date:** 2026-04-30  
**Priority:** P0 → P1 → P2 → P3

---

## Quick Start

To apply all fixes at once, run:
```bash
cd /home/ldeen/Documents/pi-research
npm run build
# Test with a Level 2 research query
pi --verbose
> research "test query" --depth 1
```

---

## P0 Fixes (Apply First)

### Fix 1: Move Scrape Token Tracking to tool_execution_end

**File:** `src/orchestration/deep-research-orchestrator.ts`  
**Lines:** 557-567 → 569+

#### Find This Block (lines 554-568):
```typescript
                    this.options.onTokens(tokens);
                    this.options.panelState.totalCost += cost;
                    updateSliceTokens(this.options.panelState, label, tokens, cost);

                    // Estimate scrape tokens
                    const scrapeTokenEstimate = (msg as any)?.toolResults?.reduce((sum: number, result: any) => {
                        if (result.toolName === 'scrape') {
                            return sum + ((result.details?.count ?? 0) * AVG_TOKENS_PER_SCRAPE);
                        }
                        return sum;
                    }, 0) || 0;

                    if (scrapeTokenEstimate > 0) {
                        const currentScrapeTotal = this.siblingScrapeTokens.get(internalId) ?? 0;
                        this.siblingScrapeTokens.set(internalId, currentScrapeTotal + scrapeTokenEstimate);
                    }
                }
```

#### Replace With:
```typescript
                    this.options.onTokens(tokens);
                    this.options.panelState.totalCost += cost;
                    updateSliceTokens(this.options.panelState, label, tokens, cost);
                }
            } else if (event.type === 'tool_execution_end' && !event.isError) {
                // FIX: Track scrape tokens here where event.result is available
                if (event.toolName === 'scrape' && event.result?.details?.count) {
                    const scrapeTokenEstimate = event.result.details.count * AVG_TOKENS_PER_SCRAPE;
                    const currentScrapeTotal = this.siblingScrapeTokens.get(internalId) ?? 0;
                    this.siblingScrapeTokens.set(internalId, currentScrapeTotal + scrapeTokenEstimate);
                }

                // Advance progress fractionally as tools complete, capped at 90% before final credit
```

**Explanation:** The `toolResults` field doesn't exist on `message_end` events. It's available as `event.result` in `tool_execution_end` events.

---

### Fix 2: Add Per-URL Truncation in Scrape Output

**File:** `src/tools/scrape.ts`  
**Lines:** ~151 (in execute function)

#### Add Constant (near top of file, after imports):
```typescript
export function createScrapeTool(options: {
  ctx: ExtensionContext;
  tracker: ToolUsageTracker;
  getGlobalState: () => SystemResearchState;
  updateGlobalLinks: (links: string[]) => void;
  onLinksScraped?: (links: string[]) => void;
  getTokensUsed?: () => number;
  getScrapeTokens?: () => number;
  contextWindowSize?: number;
}): ToolDefinition {

  const MAX_CHARS_PER_URL = 10000;  // FIX: Limit per-URL content to ~2.5K tokens
  
  const ctxWindow = options.contextWindowSize ?? DEFAULT_MODEL_CONTEXT_WINDOW;
```

#### Find This Block (near end of execute function):
```typescript
      let markdown = `# URL Scrape Results (${batchLabel})\n\n${dedupNote}`;
      markdown += `**Successful:** ${successful.length}, **Failed:** ${failed.length}, **Duration:** ${((Date.now() - startTime)/1000).toFixed(2)}s\n\n`;

      for (const res of successful) {
          markdown += `### ${res.url}\n${res.markdown}\n\n---\n\n`;
      }
```

#### Replace With:
```typescript
      let markdown = `# URL Scrape Results (${batchLabel})\n\n${dedupNote}`;
      markdown += `**Successful:** ${successful.length}, **Failed:** ${failed.length}, **Duration:** ${((Date.now() - startTime)/1000).toFixed(2)}s\n\n`;

      for (const res of successful) {
          // FIX: Truncate content per URL to prevent context explosion
          let content = res.markdown;
          if (content.length > MAX_CHARS_PER_URL) {
              content = content.slice(0, MAX_CHARS_PER_URL) + '\n\n[...truncated - content too long for full analysis. For deeper dive, request this URL specifically.]';
          }
          markdown += `### ${res.url}\n${content}\n\n---\n\n`;
      }
```

---

## P1 Fixes

### Fix 3: Fix LLM Timing with LIFO Stack

**File:** `src/orchestration/deep-research-orchestrator.ts`  
**Lines:** 524-533

#### Find This Block:
```typescript
        // Track LLM call durations to diagnose performance issues
        const llmCallStart = new Map<string, number>();
        
        const subscription = session.subscribe((event: AgentSessionEvent) => {
            // Track LLM call timing
            if (event.type === 'message_start') {
                const callId = `${internalId}-${Date.now()}`;
                llmCallStart.set(callId, Date.now());
                logger.debug(`[Orchestrator] ${this.elapsed()} LLM call started for ${internalId} (id: ${callId})`);
            }
            if (event.type === 'message_end') {
                const callId = `${internalId}-${Date.now()}`;
                const startTime = llmCallStart.get(callId) || (llmCallStart.get(`${internalId}-${(Date.now() - 10000)}`) || Date.now());
                const duration = Date.now() - startTime;
                logger.debug(`[Orchestrator] ${this.elapsed()} LLM call completed for ${internalId} in ${duration}ms (${(duration/1000).toFixed(1)}s)`);
            }
```

#### Replace With:
```typescript
        // Track LLM call durations to diagnose performance issues
        // FIX: Use LIFO stack instead of map for accurate timing
        const llmCallStartStack: number[] = [];
        
        const subscription = session.subscribe((event: AgentSessionEvent) => {
            // Track LLM call timing
            if (event.type === 'message_start') {
                llmCallStartStack.push(Date.now());
                logger.debug(`[Orchestrator] ${this.elapsed()} LLM call started for ${internalId} (stack depth: ${llmCallStartStack.length})`);
            }
            if (event.type === 'message_end') {
                const startTime = llmCallStartStack.pop() || Date.now();
                const duration = Date.now() - startTime;
                logger.debug(`[Orchestrator] ${this.elapsed()} LLM call completed for ${internalId} in ${duration}ms (${(duration/1000).toFixed(1)}s)`);
            }
```

---

### Fix 4: Fix Evaluator Prompt Query Budgets

**File:** `src/constants.ts`  
**Lines:** 119-121

#### Find This Block:
```typescript
/** Hard cap on search queries per researcher, enforced after LLM planning */
export const MAX_QUERIES_PER_RESEARCHER_LEVEL_1 = 10;
export const MAX_QUERIES_PER_RESEARCHER_LEVEL_2 = 10;
export const MAX_QUERIES_PER_RESEARCHER_LEVEL_3 = 15;
```

#### Replace With:
```typescript
/** Hard cap on search queries per researcher, enforced after LLM planning */
export const MAX_QUERIES_PER_RESEARCHER_LEVEL_1 = 10;
export const MAX_QUERIES_PER_RESEARCHER_LEVEL_2 = 20;  // FIX: Match prompt (was 10)
export const MAX_QUERIES_PER_RESEARCHER_LEVEL_3 = 30;  // FIX: Match prompt (was 15)
```

**Note:** The prompt says "Level 1: 10, Level 2: 20, Level 3: 30", so we align the constants with that.

---

### Fix 5: Enforce RESEARCHER_TIMEOUT_MS

**File:** `src/orchestration/deep-research-orchestrator.ts`  
**Lines:** ~482 (in runResearcher method)

#### Add Import (at top of file):
```typescript
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectCurrentDate } from '../utils/inject-date.ts';
import type { ExtensionContext, AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { complete, completeSimple, type Model, type TextContent, type Usage } from '@mariozechner/pi-ai';
import { calculateTotalTokens, isTextContentBlock } from '../types/llm.ts';
import { logger } from '../logger.ts';
import type { ResearchPanelState } from '../tui/research-panel.ts';
import { getConfig } from '../config.ts';  // FIX: Import config
```

#### Find This Block (in runResearcher method):
```typescript
        this.activeSessions.set(internalId, session);
        try {
            await session.prompt("Begin your specialized research.");
        } finally {
            if (typeof subscription === 'function') subscription();
        }
```

#### Replace With:
```typescript
        this.activeSessions.set(internalId, session);
        try {
            // FIX: Enforce researcher timeout to prevent hung sessions
            const config = getConfig();
            const timeoutPromise = new Promise<void>((_, reject) => {
                const timeoutId = setTimeout(() => {
                    reject(new Error(`Researcher ${internalId} (${config.name}) timed out after ${config.RESEARCHER_TIMEOUT_MS}ms`));
                }, config.RESEARCHER_TIMEOUT_MS);
            });
            
            await Promise.race([
                session.prompt("Begin your specialized research."),
                timeoutPromise
            ]);
        } catch (error) {
            if (error?.message?.includes('timed out')) {
                logger.error(`[Orchestrator] ${this.elapsed()} ${error.message}`);
                throw error;
            }
            throw error;
        } finally {
            if (typeof subscription === 'function') subscription();
        }
```

---

## P2 Fixes

### Fix 6: Reduce MAX_EVALUATOR_REPORT_LENGTH

**File:** `src/constants.ts`  
**Lines:** 102

#### Find This Block:
```typescript
/** Maximum characters per researcher report when sent to lead evaluator */
export const MAX_EVALUATOR_REPORT_LENGTH = 50000;
```

#### Replace With:
```typescript
/** Maximum characters per researcher report when sent to lead evaluator */
export const MAX_EVALUATOR_REPORT_LENGTH = 20000;  // FIX: Reduced from 50000 for 60% smaller evaluator inputs
```

---

### Fix 7: Send Current-Round Reports for Delegation Calls

**File:** `src/orchestration/deep-research-orchestrator.ts`  
**Lines:** 691-698 (in evaluate method)

#### Find This Block:
```typescript
      const evalPrompt = loadPrompt('system-lead-evaluator')
          .replace('{ROOT_QUERY}', this.options.query)
          .replace('{ROUND_NUMBER}', this.currentRound.toString())
          .replace('{MAX_ROUNDS}', ((this.options.complexity === 1 ? MAX_ROUNDS_LEVEL_1 : this.options.complexity === 2 ? MAX_ROUNDS_LEVEL_2 : MAX_ROUNDS_LEVEL_3)).toString())
          .replace('{MAX_TEAM_SIZE}', maxTeamSize.toString())
          .replace('{PREVIOUS_QUERIES}', previousQueriesList)
          .replace('{NEXT_ID}', `r${nextId}`);

      const reportsText = Array.from(this.reports.entries())
          .map(([id, report]) => {
              const truncated = report.length > MAX_EVALUATOR_REPORT_LENGTH
                  ? report.slice(0, MAX_EVALUATOR_REPORT_LENGTH) + '\n\n[Report truncated]'
                  : report;
              return `### Researcher ${id} Report\n\n${truncated}`;
          })
          .join('\n\n---\n\n');
```

#### Replace With:
```typescript
      const evalPrompt = loadPrompt('system-lead-evaluator')
          .replace('{ROOT_QUERY}', this.options.query)
          .replace('{ROUND_NUMBER}', this.currentRound.toString())
          .replace('{MAX_ROUNDS}', ((this.options.complexity === 1 ? MAX_ROUNDS_LEVEL_1 : this.options.complexity === 2 ? MAX_ROUNDS_LEVEL_2 : MAX_ROUNDS_LEVEL_3)).toString())
          .replace('{MAX_TEAM_SIZE}', maxTeamSize.toString())
          .replace('{PREVIOUS_QUERIES}', previousQueriesList)
          .replace('{NEXT_ID}', `r${nextId}`);

      // FIX: For delegation-only, send only current round's reports to keep input size constant
      let reportsToUse = this.reports;
      if (!mustSynthesize && !atTarget) {
          // Delegation decision: use only current round's reports
          const currentRoundReports = new Map<string, string>();
          for (const [id, report] of this.reports.entries()) {
              if (id.startsWith(`${this.currentRound}.`)) {
                  currentRoundReports.set(id, report);
              }
          }
          reportsToUse = currentRoundReports;
      }
      // For synthesis or at-target, use all reports as before

      const reportsText = Array.from(reportsToUse.entries())
          .map(([id, report]) => {
              const truncated = report.length > MAX_EVALUATOR_REPORT_LENGTH
                  ? report.slice(0, MAX_EVALUATOR_REPORT_LENGTH) + '\n\n[Report truncated]'
                  : report;
              return `### Researcher ${id} Report\n\n${truncated}`;
          })
          .join('\n\n---\n\n');
```

**Note:** This keeps evaluator input constant-size during delegation rounds while providing full context for synthesis.

---

## P3 Fixes

### Fix 8: Raise Context Warning Threshold

**File:** `src/orchestration/deep-research-orchestrator.ts`  
**Lines:** 544-546

#### Find This Block:
```typescript
                    // Warn if context is getting too large (>30K tokens)
                    if (newTotal > 30000 && (currentTotal <= 30000 || newTotal % 10000 < 1000)) {
                        logger.warn(`[Orchestrator] ${this.elapsed()} Researcher ${internalId} context size: ${newTotal.toLocaleString()} tokens - this may cause performance degradation`);
                    }
```

#### Replace With:
```typescript
                    // Warn if context is getting too large (>80K tokens)
                    const CONTEXT_WARNING_THRESHOLD = 80000;
                    if (newTotal > CONTEXT_WARNING_THRESHOLD && (currentTotal <= CONTEXT_WARNING_THRESHOLD || newTotal % 20000 < 2000)) {
                        logger.warn(`[Orchestrator] ${this.elapsed()} Researcher ${internalId} context size: ${newTotal.toLocaleString()} tokens - this may cause performance degradation`);
                    }
```

---

## Testing After Fixes

### 1. Quick Smoke Test
```bash
cd /home/ldeen/Documents/pi-research
npm run build
pi --verbose
> research "quantum computing applications" --depth 0
```

**Expected:**
- Build succeeds
- Research completes in <5 minutes
- LLM call durations logged (not 0ms)
- No 350K+ token contexts

### 2. Level 2 Test (Main Test)
```bash
pi --verbose
> research "history of the ottoman empire" --depth 1
```

**Expected:**
- Total runtime: 8-15 minutes (vs 29+ before)
- Contexts: <100K tokens per researcher
- Evaluator inputs: <200K chars per call
- LLM calls: show accurate durations

### 3. Level 3 Test
```bash
pi --verbose
> research "climate change impact on global agriculture" --depth 2
```

**Expected:**
- Query budgets: L2 researchers use 20 queries, L3 use 30
- Contexts: still <100K tokens per researcher
- Runtime: <20 minutes

### 4. Verify Context Gate
Check logs for:
```
[Orchestrator] Context fraction for scraping: 0.47 >= 0.45 threshold
[Scrape] Skipped - Context Budget Reached
```

This confirms the gate is now working.

### 5. Verify Timeout
If a researcher hangs, you should see:
```
[Orchestrator] Researcher 1.r2 timed out after 240000ms
```

---

## Rollback Instructions

If any fix causes issues, revert only that fix:

### Rollback Fix 1 (Scrape Gate)
- Revert `deep-research-orchestrator.ts` to original scrape token tracking code
- Gate will be broken again (as it was before)

### Rollback Fix 2 (URL Truncation)
- Remove `MAX_CHARS_PER_URL` constant
- Remove truncation logic in loop
- Or increase to 20000 for less aggressive truncation

### Rollback Fix 3 (LLM Timing)
- Revert to Map-based implementation
- Timing will be 0ms again (as it was before)

### Rollback Fix 4 (Query Budgets)
- Change `MAX_QUERIES_PER_RESEARCHER_LEVEL_2` back to 10
- Change `MAX_QUERIES_PER_RESEARCHER_LEVEL_3` back to 15

### Rollback Fix 5 (Timeout)
- Remove `Promise.race` wrapper
- Restore simple `await session.prompt(...)`

### Rollback Fix 6 (Report Length)
- Change `MAX_EVALUATOR_REPORT_LENGTH` back to 50000

### Rollback Fix 7 (Report Filtering)
- Remove `reportsToUse` logic
- Always use `this.reports` directly

### Rollback Fix 8 (Warning Threshold)
- Change threshold back to 30000

---

## Verification Checklist

After applying all fixes, verify:

- [ ] Build succeeds with no TypeScript errors
- [ ] LLM call durations are logged correctly (not all 0ms)
- [ ] Context warnings appear only at >80K tokens
- [ ] Scrape gate fires when threshold exceeded
- [ ] URL content is truncated at 10K chars
- [ ] Evaluator receives current-round reports for delegation
- [ ] Evaluator receives all reports for synthesis
- [ ] Timeout is enforced after 4 minutes
- [ ] Query budgets: L1=10, L2=20, L3=30
- [ ] Level 2 test completes in <15 minutes
- [ ] Level 3 test completes in <20 minutes
- [ ] No researcher hangs indefinitely
- [ ] Search burst still fast (~43s)
- [ ] Concurrency control still works (max 3 parallel)

---

## Summary

**Total Fixes:** 8  
**Files Modified:** 4  
**Total Lines Changed:** ~60-80  
**Estimated Time to Apply:** 30-45 minutes  
**Expected Speedup:** 50-70% (29m → 8-15m)

**Priority Order:**
1. P0 (Apply first - critical for functionality)
2. P1 (Apply second - critical for performance & reliability)
3. P2 (Apply third - significant performance boost)
4. P3 (Apply last - nice to have, low risk)

**Testing After Each Priority:**
- After P0: Verify gate works, contexts smaller
- After P1: Verify timing accurate, budgets correct
- After P2: Verify evaluator faster
- After P3: Verify cleaner logs

---

**Implementation Date:** 2026-04-30  
**Document Version:** 1.0
