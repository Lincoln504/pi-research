# Pi-Research Slowness - Root Cause Analysis

## Executive Summary

The new architecture's massive search approach is working FAST (30 queries in 43.5s), but researchers are taking 7-12 MINUTES per tool call due to multiple architectural issues.

## Critical Issues Found

### 1. Massive Silent Gaps (PRIMARY BOTTLENECK)

**Evidence from njnc.log (April 30, 2026):**

```
22:54:43 grep 2/4
[763 SECOND GAP = 12.7 MINUTES]
23:07:26 grep 3/4
[424 SECOND GAP = 7.0 MINUTES]
23:14:31 grep 3/4
```

**Pattern:** Researchers fire tool calls quickly (within seconds), then go completely silent for 7-12 minutes before the next tool call.

**Root Cause:** LLM is taking 7-12 minutes to generate each tool call response.

### 2. Grep Tool Misuse

**Problem:** Researchers are using `grep` to search the LOCAL FILESYSTEM for web research topics.

**Evidence:**
- grep tool description: "Search codebase using ripgrep"
- Researchers calling grep with patterns like "laser engraving technology"
- This searches `/home/ldeen/Documents/pi-research` (the codebase)
- Completely useless for researching external topics

**Impact:**
- Wasteful API calls
- Adds noise to context window
- Confuses LLM about what tools to use

### 3. User Settings Override

**~/.pi/agent/settings.json:**
```json
"defaultThinkingLevel": "high"
```

**Problem:** Even though code sets `thinkingLevel: 'off'` for researchers, the user's default settings might be overriding it.

**Impact:** Every LLM turn does extensive internal thinking, compounding across turns.

### 4. Full Markdown Dump

**Current scrape.ts:**
```typescript
for (const res of successful) {
    markdown += `### ${res.url}\n${res.markdown}\n\n---\n\n`;
}
```

**Problem:**
- No truncation
- No summarization
- Each URL dumps 15-50K characters of markdown
- Context window becomes massive:
  - Batch 1: 4 URLs × 30K = 120K chars ≈ 30K tokens
  - Batch 2: 4 URLs × 30K = 120K chars ≈ 30K tokens
  - Total: 60K+ tokens before synthesis

**Impact:** Large contexts slow down LLM processing dramatically.

### 5. Tool Configuration Mismatch

**Current setup:**
- Researchers have `noSearch: true` (search tool removed)
- Available tools: grep, stackexchange, scrape, security_search, links
- Prompt tells them to "Only use tools available in your session"

**Problem:** Researchers try to search using grep (which is wrong) instead of understanding they should just scrape from the provided evidence.

## Architecture Comparison

### v0.1.13 (Faster)
- Researchers had search tool
- Could do targeted searches
- Smaller, focused contexts
- MAX_SCRAPE_CALLS = 4, MAX_SCRAPE_URLS = 3

### Current (Slower)
- No search tool in researcher sessions
- Massive pre-search (30 queries in 43.5s - FAST!)
- Full markdown dumps into context
- MAX_SCRAPE_CALLS = 2, MAX_SCRAPE_URLS = 4

**The massive pre-search is working great!** The problem is what happens AFTER.

## Proposed Fixes

### Priority 1: Fix LLM Performance (12-minute gaps)

1. **Verify thinkingLevel is being used:**
   - Add logging to confirm `thinkingLevel: 'off'` is actually passed to LLM
   - Check if deepseek-v4-flash respects this parameter
   - Consider forcing `reasoning: 'off'` in API calls if needed

2. **Add LLM call duration logging:**
   ```typescript
   const subscription = session.subscribe((event) => {
       if (event.type === 'message_start') {
           logger.debug(`[${internalId}] LLM call started`);
           llmCallStart.set(internalId, Date.now());
       }
       if (event.type === 'message_end') {
           const duration = Date.now() - (llmCallStart.get(internalId) || 0);
           logger.debug(`[${internalId}] LLM call completed in ${duration}ms`);
       }
   });
   ```

3. **Investigate model-specific issues:**
   - Test with different models (Claude, GPT-4, etc.)
   - Check if deepseek-v4-flash has known performance issues
   - Consider allowing model selection for researchers

### Priority 2: Fix Tool Misuse

4. **Remove grep from web research:**
   ```typescript
   const customTools = noSearch 
     ? allTools.filter(t => t.name !== 'search' && t.name !== 'grep')
     : allTools;
   ```

   Rationale: grep is for local codebases, not web research.

5. **Improve tool descriptions:**
   - grep: "Search LOCAL PROJECT codebase (not web content). Only for code research."
   - Add a new "search_scraped" tool if needed

### Priority 3: Reduce Context Bloat

6. **Implement content truncation/summarization:**
   ```typescript
   const MAX_CHARS_PER_SCRAPE = 10000;
   for (const res of successful) {
       let content = res.markdown;
       if (content.length > MAX_CHARS_PER_SCRAPE) {
           content = content.slice(0, MAX_CHARS_PER_SCRAPE) + '\n\n[...truncated...]';
       }
       markdown += `### ${res.url}\n${content}\n\n---\n\n`;
   }
   ```

7. **Add context-aware gating:**
   - Track total context size
   - Block new tool calls if context exceeds threshold
   - Force synthesis when full

### Priority 4: Improve Researcher Guidance

8. **Clarify prompt about tools:**
   ```markdown
   - scrape: Fetch and read web pages (your primary tool)
   - stackexchange: Get technical Q&A from Stack Exchange
   - links: View collected URLs
   - DO NOT use grep - it's for local code, not web research
   ```

9. **Add tool selection hints:**
   - Tell researchers to start with scrape
   - Explicitly warn against using grep for web topics

### Priority 5: Configuration

10. **Override user settings for researchers:**
    ```typescript
    // Force researchers to use minimal thinking regardless of user settings
    thinkingLevel: 'off',
    // Or create a settingsManager that ignores defaultThinkingLevel
    ```

11. **Add researcher-specific configuration:**
    ```typescript
    interface ResearcherConfig {
        model?: Model<any>;  // Allow different model for researchers
        thinkingLevel?: 'off' | 'minimal';  // Force low thinking
        maxContextTokens?: number;  // Cap context size
    }
    ```

## Testing Plan

1. **Immediate:** Add logging to confirm thinkingLevel is being used
2. **Quick fix:** Remove grep from researcher tools (test if this helps)
3. **Medium:** Add context truncation (test impact on quality vs speed)
4. **Long-term:** Investigate model-specific performance

## Expected Results

After fixes:
- Tool calls should complete in seconds, not minutes
- Total researcher time: 2-5 minutes (vs current 15-25 minutes)
- Context size: 20-30K tokens (vs current 60K+)
- Better quality: No useless grep searches cluttering context
