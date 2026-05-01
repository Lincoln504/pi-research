# Coordinator Grep Access Fix

## Summary

Updated the architecture so different roles have appropriate tool access:

| Role | Has Grep? | Purpose |
|-------|-------------|---------|
| Coordinator | ✅ YES (new) | Plan research with local codebase context |
| Evaluator | ❌ NO | Synthesize reports only |
| Researcher | ❌ NO | Web research only |

## Changes Made

### 1. Coordinator: Added Local Code Context (deep-research-orchestrator.ts)

**What:** Coordinator now searches local codebase before planning when the query references code.

**When it activates:**
```typescript
const isCodeResearch = queryLower.includes('codebase') || 
                     queryLower.includes('code') || 
                     queryLower.includes('project') || 
                     queryLower.includes('this') ||
                     queryLower.includes('implementation') || 
                     queryLower.includes('architecture');
```

**What it does:**
1. Extracts key terms from the user's query
2. Searches the local codebase using grep
3. Limits results to prevent overwhelming context (first 3 terms, 2000 chars each)
4. Injects results into coordinator prompt as "Local Codebase Context" section

**Example use cases:**
- "Research how this codebase handles authentication"
- "Investigate vulnerability patterns in this project"
- "Find industry standards for the implementation in this repository"

**Result:** Coordinator can now:
- See what files and patterns exist in the local codebase
- Plan research that connects external knowledge to local implementation
- Assign researchers to investigate specific aspects relevant to the codebase
- Identify gaps where external research can inform local decisions

### 2. Coordinator Prompt: Updated Instructions (system-coordinator.md)

**Added:** New section explaining how to use local codebase context.

**Instructions:**
1. **Understand what exists** in the codebase related to the research topic
2. **Plan targeted research** that bridges external knowledge with local implementation
3. **Identify gaps** where external research can inform local code decisions
4. **Connect patterns** between local code and industry standards/best practices

**Example:** If grep shows `src/auth/jwt.ts` exists, coordinator might assign a researcher to investigate "JWT security best practices" to compare with local implementation.

### 3. Researcher Prompt: Explicit Tool List (researcher.md)

**Changed:** From vague "Only use tools available" to explicit list.

**New guidelines:**
```
Available Tools:
  - scrape: Fetch and read web pages (your primary tool)
  - stackexchange: Get technical Q&A from Stack Exchange
  - links: View all collected URLs
  - security_search: Query security databases (CVE, NVD, OSV, CISA)

NOT Available: No search or grep tools for web research.
```

**Impact:** Researchers won't try to use grep for web research.

### 4. Evaluator: No Grep Access (unchanged)

**Status:** Evaluator already doesn't have grep access (uses `completeSimple()` without tools).

**Role:** Synthesizes from researcher reports only.

**Correct:** Should not search local code or web - just synthesize.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Orchestrator                      │
└────────────┬────────────────────────────────────────────┘
             │
    ┌────────┴────────┬──────────────┐
    │                 │              │
    ▼                 ▼              ▼
┌─────────┐     ┌─────────┐  ┌──────────┐
│Coordinator│     │Researcher│  │Evaluator  │
│  + grep  │     │ - grep  │  │ - grep   │
└─────────┘     └─────────┘  └──────────┘
     │                │              │
     │                │              │
     ▼                ▼              ▼
   Plans            Web          Synthesizes
   research       research      reports
   with local      (scrape)       only
   code
   context
```

## Use Cases

### Use Case 1: Pure Web Research

**Query:** "laser engraving technology types applications"

**Coordinator behavior:**
- `isCodeResearch = false` (no code keywords)
- No grep calls
- Plans web research only
- Focuses on external sources

**Researchers:**
- Get search results from coordinator
- Scrape URLs
- No grep calls (would be useless)

**Result:** Fast, focused web research.

### Use Case 2: Local Code Research

**Query:** "Research how this codebase handles authentication"

**Coordinator behavior:**
- `isCodeResearch = true` (has "codebase", "authentication")
- Grep for: "codebase", "handles", "authentication"
- Finds files like `src/auth/jwt.ts`, `src/api/login.ts`
- Plans research to compare local implementation with industry standards
- Assigns researchers: "JWT security best practices", "OAuth2 implementation patterns", etc.

**Researchers:**
- Get pre-search results (industry standards)
- Scrape external documentation
- No grep calls (not needed)
- Synthesize how local code compares to best practices

**Evaluator:**
- Synthesizes reports
- Compares external best practices to local implementation patterns

**Result:** Comprehensive research that connects local code to external knowledge.

## Implementation Details

### Grep Integration in Coordinator

```typescript
// Import grep dynamically to avoid circular dependency
const { grep } = await import('../tools/grep.ts');

// Extract meaningful search terms from query
const searchTerms = this.options.query.split(/\s+/)
  .filter((w, i, arr) => w.length > 3 && arr.indexOf(w) === i)
  .slice(0, 3);  // Limit to first 3 terms

// Search codebase for each term
for (const term of searchTerms) {
  const result = await grep(term, this.options.ctx.cwd);
  localContextSection += `\n### Matches for "${term}"\n\n${result.slice(0, 2000)}\n...[truncated]...\n\n`;
}

// Inject into coordinator prompt
messages: [{ 
  role: 'user', 
  content: [{ 
    type: 'text', 
    text: basePlanningPrompt + localContextSection + retryHint 
  }] 
}]
```

### Search Term Extraction

**Goal:** Extract meaningful terms that would actually match code.

**Logic:**
1. Split query on whitespace
2. Filter for words > 3 characters (ignores "is", "the", "for")
3. Keep first occurrence only (unique terms)
4. Limit to first 3 terms (prevents overwhelming context)

**Examples:**
| Query | Search Terms |
|--------|-------------|
| "how this codebase handles authentication" | ["codebase", "handles", "authentication"] |
| "vulnerability patterns in this project" | ["vulnerability", "patterns", "project"] |
| "laser engraving technology" | ["laser", "engraving", "technology"] |

**Note:** For pure web research like "laser engraving", grep might run but won't find anything useful, which is fine - coordinator just doesn't get local context.

### Result Truncation

**Limit:** 2000 characters per grep result.

**Reason:** Prevent overwhelming coordinator with too much local context.

**Format:** Shows `[...[truncated]...` to indicate more matches exist.

**Example:**
```markdown
### Matches for "authentication"

```
./src/auth/jwt.ts:1:import { sign } from 'jsonwebtoken';
./src/auth/jwt.ts:10:export async function authenticate(token: string) {
./src/auth/login.ts:5:const AUTH_SECRET = process.env.JWT_SECRET;
./src/api/middleware.ts:20:  if (!req.headers.authorization) {
  return res.status(401).json({ error: 'Unauthorized' });
  }
```

...[truncated]...
```

## Testing

### Test 1: Pure Web Research

```bash
cd ~/Documents/pi-research
pi --verbose
> research "laser engraving technology types applications"
```

**Expected:**
- Coordinator runs WITHOUT grep
- No "Local Codebase Context" in logs
- Fast planning (< 30s)
- Researchers scrape web only

### Test 2: Local Code Research

```bash
cd ~/Documents/pi-research
pi --verbose
> research "how this codebase handles authentication security"
```

**Expected:**
- Coordinator runs grep for: "codebase", "handles", "authentication"
- "Local Codebase Context" section appears in logs
- Researchers assigned to investigate JWT, OAuth2 patterns, etc.
- Reports compare local implementation to external best practices

### Test 3: Mixed Research

```bash
cd ~/Documents/pi-research
pi --verbose
> research "Compare this project's architecture with industry standards"
```

**Expected:**
- Coordinator runs grep for: "project", "architecture", "industry", "standards"
- Shows relevant files (e.g., `src/`, `package.json`, architectural docs)
- Plans research on industry microservices, monolith, event-driven patterns
- Researchers investigate how local code aligns with standards

## Future Enhancements

1. **Smart Term Extraction**
   - Use NLP to identify code-relevant terms
   - Filter out generic words like "how", "what", "compare"
   - Extract function/method names from query

2. **Context-Aware Grep**
   - Search file extensions relevant to query
   - For "JWT security": grep in `.ts`, `.js` files only
   - For "python patterns": grep in `.py` files only

3. **Integration Results**
   - Show grep matches per file type
   - Highlight function definitions
   - Extract import/dependency information

4. **Two-Phase Coordinator**
   - Phase 1: Grep local code (fast)
   - Phase 2: Plan research with context (slower)
   - Better separation of concerns

## Summary

✅ **Coordinator**: Can now grep local codebase for context
✅ **Evaluator**: Still no grep access (correct)
✅ **Researcher**: No grep access (previously fixed)
✅ **Prompts**: Updated to reflect tool availability
✅ **Compilation**: All changes compile cleanly

The coordinator now has the ability to understand local code context when planning research, enabling intelligent research that bridges external knowledge with local implementation.
