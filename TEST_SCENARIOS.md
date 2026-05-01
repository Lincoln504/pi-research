# Test Scenarios - Verifying All Fixes

## Quick Reference

| Scenario | Query | Expected Behavior |
|----------|--------|------------------|
| Pure web research | "laser engraving technology" | No grep anywhere, coordinator plans web research only |
| Local code research | "how this codebase handles auth" | Coordinator greps local code, plans comparison research |
| Mixed research | "Compare this project's architecture" | Coordinator shows local files, researchers investigate industry standards |

## Scenario 1: Pure Web Research

### Command
```bash
cd ~/Documents/pi-research
pi --verbose
```

### Query
```
research "laser engraving technology types applications" depth 2
```

### Expected Logs

#### Phase 1 - Coordinator
```
[Orchestrator] Starting research: "laser engraving..." (Complexity: 2)
[Orchestrator] Coordinator done in ~20s — planned 3 researcher(s)
[Orchestrator] Round 1 starting
```

**CHECK:**
- ✅ NO grep calls in coordinator phase
- ✅ NO "Local Codebase Context" section
- ✅ Fast planning (< 30s)

#### Phase 2 - Search
```
[Search] Orchestrating 30 queries via Browser Queue...
[Orchestrator] Search burst done in ~45s — 30 queries
```

**CHECK:**
- ✅ Fast search (1-2s per query)

#### Phase 3 - Researchers
```
[Orchestrator] Researcher 1.r1 (Technology Types) started
[tool-usage] category=scrape calls=1/2 tool=scrape count=1/2
[tool-usage] category=scrape calls=2/2 tool=scrape count=2/2
[Orchestrator] LLM call completed for 1.r1 in 5432ms  ← NEW!
[Orchestrator] LLM call completed for 1.r1 in 3210ms  ← NEW!
[Orchestrator] Researcher 1.r1 done in ~180s  ← FAST!
```

**CHECK:**
- ✅ NO grep tool calls
- ✅ LLM call durations visible (seconds, not minutes)
- ✅ Total researcher time: 2-5 minutes (not 15-25)
- ✅ Context size warnings if >30K tokens

### Success Criteria
- [ ] Researchers complete in < 5 minutes each
- [ ] NO grep calls anywhere
- [ ] LLM call times logged (visible in --verbose mode)
- [ ] Context warnings appear if applicable
- [ ] Total research time: < 15 minutes

---

## Scenario 2: Local Code Research

### Command
```bash
cd ~/Documents/pi-research
pi --verbose
```

### Query
```
research "how this codebase handles authentication security" depth 2
```

### Expected Logs

#### Phase 1 - Coordinator
```
[Orchestrator] Starting research: "how this codebase..." (Complexity: 2)
[Scrapers] Using native HTML-to-Markdown converter  ← Grepping files
[Orchestrator] Raw planning response...
  Found matches for: codebase, handles, authentication  ← NEW!
  ### Matches for "codebase"
  ./src/auth/jwt.ts:10:export async function codebase...
  ### Matches for "handles"
  ./src/auth/jwt.ts:20:export function handles(req, res) {
  ### Matches for "authentication"
  ./package.json:15:"jwt-authentication": "^2.0.0"
  ...[truncated]
[Orchestrator] Coordinator done in ~30s — planned 3 researcher(s)
```

**CHECK:**
- ✅ Grepping local codebase
- ✅ "Local Codebase Context" section present
- ✅ Truncated results (not overwhelming context)
- ✅ Relevant files found (auth, JWT, etc.)

#### Phase 2 - Search
```
[Search] Orchestrating 30 queries...
# Queries should include industry standards:
# - JWT security best practices 2025
# - OAuth2 implementation patterns
# - Authentication token storage
# - Session management security
[Orchestrator] Search burst done in ~45s
```

**CHECK:**
- ✅ Queries tailored to compare local with external knowledge
- ✅ Fast search

#### Phase 3 - Researchers
```
[Orchestrator] Researcher 1.r1 (JWT Security Standards) started
[tool-usage] category=scrape calls=1/2 tool=scrape
[tool-usage] category=scrape calls=2/2 tool=scrape
[Orchestrator] Researcher 1.r1 done in ~180s
```

**CHECK:**
- ✅ NO grep calls (coordinator already grepped)
- ✅ Researchers focused on external comparison
- ✅ Reports compare local implementation with industry standards

#### Phase 4 - Synthesis
```
[Orchestrator] Round 1 evaluator done in ~60s → action=synthesize
# Synthesis should include:
# - Analysis of local JWT implementation
# - Comparison with industry best practices
# - Security recommendations specific to this codebase
```

**CHECK:**
- ✅ Synthesis references local code files found by coordinator
- ✅ Recommends improvements based on external research
- ✅ No local code search by evaluator

### Success Criteria
- [ ] Coordinator greps local code successfully
- [ ] "Local Codebase Context" section appears in logs
- [ ] Researchers assigned to industry standards research
- [ ] Synthesis connects local and external findings
- [ ] No researcher grep calls

---

## Scenario 3: LLM Performance Monitoring

### Command
```bash
cd ~/Documents/pi-research
pi --verbose 2>&1 | grep "LLM call"
```

### Query
```
research "any topic" depth 2
```

### Expected Output

```
[Orchestrator] LLM call started for 1.r1 (id: 1.r1-1234567890)
[Orchestrator] LLM call completed for 1.r1 in 5432ms (5.4s)
[Orchestrator] LLM call started for 1.r1 (id: 1.r1-1234567910)
[Orchestrator] LLM call completed for 1.r1 in 3210ms (3.2s)
[Orchestrator] LLM call started for 1.r1 (id: 1.r1-1234567950)
[Orchestrator] LLM call completed for 1.r1 in 8932ms (8.9s)
```

### Success Criteria
- [ ] LLM call times logged for every turn
- [ ] Times are in seconds (not minutes)
- [ ] Can see correlation between context size and call time
- [ ] Can identify slow calls for investigation

---

## Scenario 4: Context Size Monitoring

### Command
```bash
cd ~/Documents/pi-research
pi --verbose 2>&1 | grep -i "context.*token\|scraping"
```

### Query
```
research "any topic with lots of scraping potential" depth 2
```

### Expected Output (if context gets large)

```
[tool-usage] category=scrape calls=1/2 tool=scrape count=4/4
[tool-usage] category=scrape calls=2/2 tool=scrape count=8/4
[Orchestrator] Researcher 1.r1 context size: 35,000 tokens - this may cause performance degradation  ← NEW!
[Orchestrator] LLM call completed for 1.r1 in 15230ms (15.2s)  ← Slower due to large context
```

### Success Criteria
- [ ] Warning appears when context exceeds 30K tokens
- [ ] Can correlate context size with LLM performance
- [ ] Multiple warnings don't appear (suggests truncation needed)

---

## Debugging Checklist

If tests fail, check:

### Researchers Still Slow?
1. **Check logs for:**
   ```bash
   grep "LLM call completed" /tmp/pi-research-debug-*.log
   ```
2. **Expected:** Times in seconds (< 10000ms)
3. **If minutes:** Check if thinking level is being applied:
   ```bash
   grep "thinkingLevel.*off\|Created session with thinkingLevel" /tmp/pi-research-debug-*.log
   ```
4. **If not applied:** May need to force via different mechanism

### Grep Still Appearing?
1. **Check researcher logs:**
   ```bash
   grep "tool-usage.*grep" /tmp/pi-research-debug-*.log
   ```
2. **Expected:** Zero grep calls
3. **If found:** Verify filter in researcher.ts is correct

### Coordinator Not Greeting?
1. **Check query detection:**
   ```bash
   grep "isCodeResearch\|Local Codebase" /tmp/pi-research-debug-*.log
   ```
2. **Expected:** Appears when query contains: codebase, code, project, this, implementation, architecture
3. **If not:** Check keyword detection logic

### LLM Call Times Not Showing?
1. **Check event subscription:**
   ```bash
   grep "message_start\|message_end" /tmp/pi-research-debug-*.log
   ```
2. **Expected:** Both events present
3. **If missing:** Check subscription implementation

## Performance Targets

| Metric | Target | Acceptable | Failure |
|--------|--------|-------------|---------|
| Coordinator planning | < 30s | < 60s | > 60s |
| Search burst | < 1s/query | < 2s/query | > 2s/query |
| Researcher total | < 5 min | < 10 min | > 10 min |
| Single LLM call | < 10s | < 30s | > 30s |
| Context size | < 30K | < 50K | > 50K |

## Rollback Plan

If fixes cause issues:

### Revert Coordinator Grep
```bash
git checkout HEAD -- src/orchestration/deep-research-orchestrator.ts
# Comment out isCodeResearch and localContextSection logic
```

### Revert Researcher Grep Removal
```bash
git checkout HEAD -- src/orchestration/researcher.ts
# Remove grep from filter
```

### Revert LLM Logging
```bash
# Remove llmCallStart tracking
# Remove message_start/message_end handlers
```

### Revert Context Warnings
```bash
# Remove context size check logic
```

---

**Next Step:** Run all test scenarios and document results in `TEST_RESULTS.md`
