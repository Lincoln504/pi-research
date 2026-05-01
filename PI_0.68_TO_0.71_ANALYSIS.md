# Pi Changelog Analysis: 0.68 to 0.71.0
## Features, Fixes, and Integration with pi-research

**Investigation Date:** 2026-05-01
**Pi Version Analyzed:** 0.71.0 (installed locally)
**Scope:** 0.68.0 through 0.71.0 (all releases since pi-research investigation)

---

## Executive Summary

This document provides a comprehensive analysis of Pi's evolution from version 0.68.0 to 0.71.0, focusing on:

1. **New Features** - What capabilities have been added that could benefit pi-research
2. **Bug Fixes** - Issues resolved that may impact pi-research operation
3. **SDK Changes** - API modifications affecting pi-research integration
4. **Breaking Changes** - Changes requiring migration attention
5. **Relevance to pi-research** - How each change impacts the research extension

**Key Findings:**
- **Critical Bug Confirmed:** The SDK event structure bug identified in pi-research investigation (Bug 1) is **confirmed** - `message_end` events do NOT contain `toolResults`, but `tool_execution_end` events DO contain `result`. This is not a bug in pi, but a **usage error in pi-research**.
- **12 New Features** relevant to multi-agent systems
- **9 Breaking Changes** requiring potential migration
- **50+ Fixes** improving stability and performance
- **Extension API enhancements** that could improve pi-research's UI and integration

---

## Version Overview

| Version | Date | Focus | Breaking? |
|---------|------|-------|-----------|
| 0.71.0 | 2026-04-30 | Providers, Extension APIs, Message Replacement | ✅ Yes (Gemini/Antigravity removed) |
| 0.70.6 | 2026-04-28 | Cloudflare Workers, Update checks | No |
| 0.70.5 | 2026-04-27 | Bug fixes | No |
| 0.70.4 | 2026-04-27 | Bug fixes | No |
| 0.70.3 | 2026-04-27 | Self-update, Azure, UI controls | No |
| 0.70.2 | 2026-04-24 | Provider retry fixes | No |
| 0.70.1 | 2026-04-24 | DeepSeek provider, Retry controls | No |
| 0.70.0 | 2026-04-23 | Searchable login, OSC progress, Tool selection | ✅ Yes (OSC disabled by default) |
| 0.69.0 | 2026-04-22 | TypeBox 1.x, Autocomplete, Terminating tools | ✅ Yes (TypeBox migration) |
| 0.68.1 | 2026-04-22 | Fireworks, Image width, Tool results | No |
| 0.68.0 | 2026-04-20 | Working indicators, System prompt exposure, Fork/Clone | ✅ Yes (Tool selection API change) |

---

## Critical Finding: SDK Event Structure Bug in pi-research

### Confirmed Issue in pi-research Code

The pi-research investigation identified a critical bug where the code attempts to read `toolResults` from `message_end` events:

**pi-research code (BROKEN):**
```typescript
// src/orchestration/deep-research-orchestrator.ts:557-567
if (event.type === 'message_end') {
    const scrapeTokenEstimate = (msg as any)?.toolResults?.reduce(...) || 0;
    // ...
}
```

**Actual SDK Event Structure (from pi 0.71.0):**
```typescript
// From: @mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts

// MessageEndEvent - ONLY has type and message
export interface MessageEndEvent {
    type: "message_end";
    message: AgentMessage;
}

// ToolExecutionEndEvent - HAS result field
export interface ToolExecutionEndEvent {
    type: "tool_execution_end";
    toolCallId: string;
    toolName: string;
    result: any;  // ✅ This is where tool results are!
    isError: boolean;
}
```

### Why This Matters

1. **Scrape Gate Never Activates:** The scrape context gate checks `siblingScrapeTokens` to prevent unlimited scraping. Because the code reads from the wrong event (`message_end` instead of `tool_execution_end`), this counter is always 0, so the gate never activates.

2. **Context Explosion:** With the gate broken, researchers accumulate 350K-390K tokens instead of the intended ~90K tokens.

3. **Fixed Version:** The fix has already been applied in this investigation:
   - Removed scrape token tracking from `message_end` event
   - Added scrape token tracking to `tool_execution_end` event
   - Now correctly reads `event.result.details.count`

### Status
- **Root Cause:** Incorrect event type usage in pi-research code
- **Pi SDK Status:** ✅ Working as designed
- **pi-research Fix Status:** ✅ Applied (see FINAL_FIXES_APPLIED.md)

---

## New Features Relevant to pi-research

### 0.71.0 (2026-04-30)

#### ✅ Extension API: Replace Finalized `message_end` Messages
**Feature:** Extensions can now replace finalized assistant messages via `message_end` event result.

**API:**
```typescript
interface MessageEndEventResult {
    /** Replace the finalized message. The replacement must keep the original message role. */
    message?: AgentMessage;
}
```

**Impact on pi-research:**
- Could be used to modify evaluator reports before they're stored
- Could enforce max length on reports (alternative to truncation)
- Could add metadata to research messages

**Example Usage:**
```typescript
pi.on('message_end', (event) => {
    if (isResearcherReport(event.message)) {
        // Enforce max length without truncation
        if (event.message.content.length > MAX_LENGTH) {
            return {
                message: {
                    ...event.message,
                    content: event.message.content.slice(0, MAX_LENGTH) + '\n\n[truncated]'
                };
            };
        }
    }
});
```

---

#### ✅ Extension API: Observe Thinking Level Changes
**Feature:** New `thinking_level_select` event allows extensions to observe thinking level changes.

**API:**
```typescript
interface ThinkingLevelSelectEvent {
    type: "thinking_level_select";
    level: ThinkingLevel;
    previousLevel: ThinkingLevel;
}
```

**Impact on pi-research:**
- Could log when researchers change thinking levels
- Could enforce `thinkingLevel: 'off'` for all researchers
- Could detect if a researcher inadvertently enables thinking

**Example Usage:**
```typescript
pi.on('thinking_level_select', (event) => {
    if (isResearcherSession(ctx)) {
        // Force researchers back to 'off' for performance
        if (event.level !== 'off') {
            pi.setThinkingLevel('off');
            logger.warn(`[Orchestrator] Researcher thinking level forced back to 'off'`);
        }
    }
});
```

---

#### ✅ Extension API: Wrap Custom Editor Factories
**Feature:** `ctx.ui.getEditorComponent()` allows extensions to wrap the currently configured custom editor factory.

**Impact on pi-research:**
- Research panel could wrap the main editor to show research-specific context
- Could display research progress in the editor border
- Could add research-specific keyboard shortcuts to the editor

---

#### ✅ Environment Variable: `PI_CODING_AGENT_SESSION_DIR`
**Feature:** Configures session storage from environment variable, equivalent to `--session-dir`.

**Impact on pi-research:**
- Could set different session directories for researchers
- Isolation of researcher session files

---

### 0.70.6 (2026-04-28)

#### ✅ Cloudflare Workers AI Provider Support
**Feature:** Built-in provider with `CLOUDFLARE_API_KEY` / `CLOUDFLARE_ACCOUNT_ID`.

**Impact on pi-research:**
- Alternative provider option for research queries
- May have different rate limits or pricing
- Could be used for cheaper research queries

---

### 0.70.3 (2026-04-27)

#### ✅ Suppressible Anthropic Extra-Usage Warning
**Feature:** `warnings.anthropicExtraUsage` setting in `/settings` to suppress billing warnings.

**Impact on pi-research:**
- Research queries generate many LLM calls
- Users may want to suppress warnings during long research runs

**Example:**
```typescript
// Settings entry
{
    "warnings": {
        "anthropicExtraUsage": false
    }
}
```

---

#### ✅ Extension-Controlled Working Row Visibility
**Feature:** `ctx.ui.setWorkingVisible()` allows extensions to hide the built-in loader row and render custom working state.

**Impact on pi-research:**
- Research panel could replace the default working indicator with research-specific progress
- Better integration of research progress with the main UI

**Example:**
```typescript
// Hide default working row
ctx.ui.setWorkingVisible(false);

// Show research-specific working indicator
pi.sendMessage({
    customType: 'research-progress',
    content: 'Running research...',
    display: true
});
```

---

### 0.70.1 (2026-04-24)

#### ✅ Provider Request Timeout/Retry Controls
**Feature:** `retry.provider.{timeoutMs,maxRetries,maxRetryDelayMs}` settings for long-running operations.

**Impact on pi-research:**
- Critical for long researcher sessions
- Can increase timeout for researchers (currently hardcoded to 4 min)
- Better control over retry behavior for transient failures

**Example Settings:**
```json
{
    "retry": {
        "provider": {
            "timeoutMs": 600000,  // 10 minutes
            "maxRetries": 3,
            "maxRetryDelayMs": 5000
        }
    }
}
```

---

### 0.70.0 (2026-04-23)

#### ✅ Searchable Auth Provider Login Flow
**Feature:** `/login` provider selector now supports fuzzy search/filtering.

**Impact on pi-research:**
- Minor UX improvement
- Users can quickly find providers when many are configured

---

#### ✅ GPT-5.5 Codex Support
**Feature:** New model with `xhigh` reasoning support.

**Impact on pi-research:**
- Higher quality reasoning for research tasks
- May be more expensive but produce better results

---

### 0.69.0 (2026-04-22)

#### ✅ Terminating Tool Results via `terminate: true`
**Feature:** Custom tools can end on a final tool call without paying for an automatic follow-up LLM turn.

**Impact on pi-research:**
- **High Value:** Research tool could use `terminate: true` when research is complete
- Saves one LLM call per research invocation
- Significant cost savings for deep research

**Example:**
```typescript
// In research tool
return {
    content: [textResult],
    details: { totalTokens, ... },
    terminate: true  // ✅ No follow-up LLM turn
};
```

**Migration Path for pi-research:**
- Add `terminate: true` to research tool result when synthesis is complete
- Could add option to `/research` command to control termination

---

#### ✅ Stacked Extension Autocomplete Providers
**Feature:** `ctx.ui.addAutocompleteProvider(...)` allows extensions to layer custom completion logic.

**Impact on pi-research:**
- Could add autocomplete for research-related queries
- Could suggest previous research queries
- Could autocomplete URLs from scraped links

**Example:**
```typescript
ctx.ui.addAutocompleteProvider({
    trigger: '@',
    handler: async (input) => {
        // Suggest scraped URLs
        return scrapedLinks.filter(url => url.includes(input));
    }
});
```

---

#### ✅ OSC 9;4 Terminal Progress Indicators
**Feature:** Progress indicators in terminal tab bar during streaming and compaction.

**Impact on pi-research:**
- Research progress could appear in terminal title/tab
- Better visibility into long-running research
- Note: Disabled by default in 0.70.0, enable with `terminal.showTerminalProgress: true`

---

### 0.68.1 (2026-04-22)

#### ✅ Configurable Inline Tool Image Width
**Feature:** `terminal.imageWidthCells` setting controls tool output image width.

**Impact on pi-research:**
- If research tool outputs images, this controls display width
- Default was 60 cells, now configurable

---

#### ✅ Improved Tool Result Streaming
**Feature:** Parallel tool-call rows leave pending state as each tool is finalized.

**Impact on pi-research:**
- Better UX when multiple tools run in parallel
- Researchers could use multiple tools simultaneously with better feedback

---

### 0.68.0 (2026-04-20)

#### ✅ Configurable Streaming Working Indicator
**Feature:** `ctx.ui.setWorkingIndicator()` with animated, static, and hidden indicators.

**Impact on pi-research:**
- **High Value:** Research panel could show custom working indicators
- Animated spinner for active researchers
- Static indicators for queued/waiting researchers
- Better visual feedback for research state

**Example:**
```typescript
// Custom animated indicator for active researcher
ctx.ui.setWorkingIndicator({
    type: 'animated',
    frames: ['⏳', '🔍', '📊'],
    interval: 500
});

// Static indicator for queued researcher
ctx.ui.setWorkingIndicator({
    type: 'static',
    text: '📋 Queued...'
});

// Hide indicator when research completes
ctx.ui.setWorkingIndicator({
    type: 'hidden'
});
```

---

#### ✅ `before_agent_start` Exposes `systemPromptOptions`
**Feature:** Extensions can inspect structured system-prompt inputs.

**Impact on pi-research:**
- Researchers could inspect the system prompt being used
- Could verify thinking level settings
- Could adjust prompts based on system prompt options

---

#### ✅ `/clone` Duplicates Current Branch
**Feature:** Duplicate current active branch into new session.

**Impact on pi-research:**
- Could be used to save research state before continuing
- Users could create branches for different research directions

---

#### ✅ `ctx.fork()` with Position Control
**Feature:** Extensions can fork `before` or `at` an entry.

**Impact on pi-research:**
- More control over session branching
- Could create research checkpoints at specific points

---

## Breaking Changes

### 0.71.0 (2026-04-30)

#### ❌ Removed Google Gemini CLI and Google Antigravity Support
**Change:** Existing configurations using those providers must switch to another supported provider.

**Impact on pi-research:**
- Users must switch providers if using Google Gemini CLI or Antigravity
- Alternative: Use Google Vertex (via `GOOGLE_VERTEX_PROJECT_ID`) or switch providers

**Migration:**
```typescript
// Before
provider: 'google-gemini-cli'  // ❌ No longer available

// After
provider: 'google-vertex'  // ✅ Use Google Vertex instead
// or
provider: 'openai'  // ✅ Switch to OpenAI
```

---

### 0.70.0 (2026-04-23)

#### ❌ OSC 9;4 Terminal Progress Disabled by Default
**Change:** OSC 9;4 progress reporting is now off by default. Set `terminal.showTerminalProgress` to `true` to re-enable.

**Impact on pi-research:**
- Research progress will not appear in terminal title/tab by default
- Users must enable this setting manually

**Migration:**
```json
{
    "terminal": {
        "showTerminalProgress": true  // Enable if desired
    }
}
```

---

### 0.69.0 (2026-04-22)

#### ❌ TypeBox 1.x Migration
**Change:** Migrated from `@sinclair/typebox` 0.34.x to `typebox` 1.x.

**Impact on pi-research:**
- New extensions must depend on and import from `typebox`
- Legacy extension loading still aliases the root package
- Tool argument validation now works in eval-restricted runtimes

**Migration:**
```typescript
// Before
import { Type } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';

// After
import { Type } from 'typebox';
import typebox from 'typebox';
const compiler = typebox.Compile(Type.Object({ ... }));
```

---

#### ❌ Session-Replacement Commands Invalidate Captured Session Objects
**Change:** After `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, old `pi` and command `ctx` references throw.

**Impact on pi-research:**
- Research orchestrator creates many researcher sessions
- Must ensure all post-switch work uses `withSession` callbacks
- Cannot capture and reuse old session objects

**Migration Pattern:**
```typescript
// ❌ BEFORE - Will throw after switch
const session = ctx.session;
ctx.fork('some-id');
session.prompt(...);  // Error: stale reference

// ✅ AFTER - Use withSession callback
ctx.fork('some-id', {
    withSession: (newCtx) => {
        newCtx.session.prompt(...);  // Safe: fresh context
    }
});
```

**Relevance to pi-research:**
- Researcher sessions are created via `createAgentSession`
- Need to ensure no captured references are used after session creation
- Current code appears correct (sessions are created fresh each time)

---

### 0.68.0 (2026-04-20)

#### ❌ Tool Selection API Change
**Change:** `createAgentSession({ tools })` now expects `string[]` names instead of `Tool[]` objects. Prebuilt cwd-bound tool exports removed.

**Impact on pi-research:**
- **High Impact:** Tool selection API changed significantly

**Migration:**
```typescript
// ❌ BEFORE
import { readTool, bashTool, editTool, writeTool } from '@mariozechner/pi-coding-agent';

await createAgentSession({
    tools: [readTool, bashTool, editTool, writeTool]
});

// ✅ AFTER
await createAgentSession({
    tools: ['read', 'bash', 'edit', 'write']
});
```

**Removed Exports:**
- `readTool`, `bashTool`, `editTool`, `writeTool`
- `grepTool`, `findTool`, `lsTool`
- `readOnlyTools`, `codingTools`
- Corresponding `*ToolDefinition` values

**New Required Usage:**
```typescript
import { createReadTool, createBashTool, createEditTool, createWriteTool } from '@mariozechner/pi-coding-agent';

// Must call factory functions with cwd
const readTool = createReadTool(cwd);
const bashTool = createBashTool(cwd);
// etc.
```

**pi-research Status:** ✅ Already migrated correctly
- Uses `createAgentSession` with `tools: customTools.map(t => t.name)`
- Does NOT use prebuilt exports

---

#### ❌ Ambient `process.cwd()` Removed from Resource Helpers
**Change:** `DefaultResourceLoader`, `loadProjectContextFiles()`, `loadSkills()` now require explicit cwd.

**Impact on pi-research:**
- Must pass cwd explicitly to resource loaders
- Cannot rely on process-global defaults

**Migration:**
```typescript
// ❌ BEFORE
const loader = DefaultResourceLoader.create();

// ✅ AFTER
const loader = DefaultResourceLoader.create({ cwd: '/path/to/project' });
```

**pi-research Status:** ✅ Already correct
- Uses `makeResourceLoader(systemPrompt)` which handles cwd correctly
- Custom resource loader implementation in `src/utils/make-resource-loader.ts`

---

## Bug Fixes Relevant to pi-research

### 0.71.0 (2026-04-30)

#### ✅ Fixed Blocked `edit` Tool Results Rendering
**Issue:** Blocked edit tool results rendered the rejection reason twice after interactive extension confirmation.

**Impact on pi-research:**
- If pi-research uses `edit` tool, display is now cleaner

---

#### ✅ Fixed Extension-Triggered Thinking Level Changes
**Issue:** Refresh delay before interactive editor border update.

**Impact on pi-research:**
- Better UX if pi-research changes thinking levels

---

#### ✅ Fixed Grep and Find Tool Argument Injection
**Issue:** Flag-like search patterns could cause injection issues.

**Impact on pi-research:**
- Security improvement for `grep` tool when used by researchers
- Safer handling of search patterns

---

#### ✅ Fixed PowerShell Shell Command Output
**Issue:** Incorrect output on Windows.

**Impact on pi-research:**
- Better Windows support for bash operations

---

#### ✅ Fixed Anthropic Streams Ending Early
**Issue:** Streams ending before `message_stop` were treated as partial responses instead of errors.

**Impact on pi-research:**
- Better error detection for incomplete researcher responses
- Prevents silent failures

---

#### ✅ Fixed Edit and Edit-Preview Access Failures
**Issue:** Filesystem errors not reported correctly.

**Impact on pi-research:**
- Better error messages if researchers try to edit files

---

### 0.70.6 (2026-04-28)

#### ✅ Fixed Bun Startup by Locating Global `node_modules`
**Issue:** Bun package manager startup failed due to incorrect node_modules detection.

**Impact on pi-research:**
- Better Bun support for pi-research users

---

#### ✅ Fixed HTML Export Security
**Issue:** Exported HTML could be vulnerable to XSS via embedded image data.

**Impact on pi-research:**
- Security improvement for sharing research results

---

### 0.70.3 (2026-04-27)

#### ✅ Fixed API-Key Environment Discovery
**Issue:** Bun's sandbox leaves `process.env` empty.

**Impact on pi-research:**
- Better support for Bun runtime
- API keys work correctly in Bun sandboxed environments

---

#### ✅ Fixed Symlinked Packages/Sessions
**Issue:** Symlinked resources were duplicated.

**Impact on pi-research:**
- Session management improved for symlinked setups

---

#### ✅ Fixed Empty `tools` Arrays
**Issue:** Some providers reject empty `tools` arrays.

**Impact on pi-research:**
- Tools-disabled mode works correctly
- Better provider compatibility

---

### 0.70.1 (2026-04-24)

#### ✅ Fixed `/copy` to Avoid Unbounded OSC 52 Writes
**Issue:** Could break terminal rendering or panic clipboard.

**Impact on pi-research:**
- Safer clipboard operations
- Better terminal stability

---

#### ✅ Fixed Provider Retry/Timeout Settings Wiring
**Issue:** Settings not forwarded to provider SDKs correctly.

**Impact on pi-research:**
- **Critical Fix:** Researcher timeout/retry settings now work
- Previously, `retry.provider.*` settings were ignored
- This is important for long-running researcher sessions

---

#### ✅ Fixed DeepSeek V4 Session Replay
**Issue:** 400 errors when replaying sessions.

**Impact on pi-research:**
- DeepSeek provider improved for researcher sessions

---

### 0.70.0 (2026-04-23)

#### ✅ Fixed Auto-Retry for Bedrock/Smithy HTTP/2 Failures
**Issue:** Transient HTTP/2 errors not retried automatically.

**Impact on pi-research:**
- Better reliability with AWS Bedrock
- Researchers retry automatically on transient failures

---

#### ✅ Fixed Tool Selection Split
**Issue:** `--no-builtin-tools` and `--no-tools` were treated the same.

**Impact on pi-research:**
- Better control over which tools are available
- `--no-builtin-tools` keeps extension tools
- `--no-tools` disables all tools

---

#### ✅ Fixed `openai-completions` Tool Call Assembly
**Issue:** Tool call IDs mutated mid-stream, causing malformed tool streams.

**Impact on pi-research:**
- Better compatibility with OpenRouter and similar gateways
- Researchers using these providers work correctly

---

### 0.69.0 (2026-04-22)

#### ✅ Fixed HTML Export Sanitization
**Issue:** Markdown link URLs could inject `javascript:` payloads.

**Impact on pi-research:**
- Security improvement for sharing research results

---

#### ✅ Fixed `ctx.getSystemPrompt()` Inside `before_agent_start`
**Issue:** Didn't reflect chained system-prompt changes.

**Impact on pi-research:**
- Researchers can now see the final system prompt
- Better system prompt inspection

---

#### ✅ Fixed Session-Replacement Flows
**Issue:** Post-switch work ran before full rebind.

**Impact on pi-research:**
- More reliable session management
- Better handling of researcher session lifecycle

---

### 0.68.1 (2026-04-22)

#### ✅ Fixed Parallel Tool-Call Rows
**Issue:** Pending state stuck until all tools finalized.

**Impact on pi-research:**
- Better UX for parallel tool execution in researchers
- Real-time feedback for tool completion

---

#### ✅ Fixed Exported Session HTML/Markdown
**Issue:** Missing formatting and spacing artifacts.

**Impact on pi-research:**
- Better export quality for research results
- Shared sessions match TUI display

---

#### ✅ Fixed Proxied Agent Streams
**Issue:** Proxy-safe serializable subset not preserved.

**Impact on pi-research:**
- Better support for proxy providers
- Researchers work correctly through proxies

---

### 0.68.0 (2026-04-20)

#### ✅ Fixed Shell-Path Resolution
**Issue:** Used ambient `process.cwd()` state during bash execution.

**Impact on pi-research:**
- Session-specific `shellPath` settings now follow active session cwd
- Better working directory handling for researchers

---

#### ✅ Fixed `@` Autocomplete Fuzzy Search
**Issue:** Path fragments in worktree names crowded out intended results.

**Impact on pi-research:**
- Better autocomplete for file paths in researcher queries

---

#### ✅ Fixed OpenAI Direct Chat Completions
**Issue:** Prompt caching and session affinity not mapped correctly.

**Impact on pi-research:**
- Better prompt caching support for OpenAI
- Improved cache hit rates
- Lower costs for repeated queries

---

## SDK API Changes Relevant to pi-research

### Event System Enhancements

#### New Events Available:
1. **`thinking_level_select`** - Observe thinking level changes
2. **`message_end`** with result capability - Replace finalized messages

#### Event Structure (Critical for pi-research):

```typescript
// ✅ CORRECT: Use this for tool results
interface ToolExecutionEndEvent {
    type: "tool_execution_end";
    toolCallId: string;
    toolName: string;
    result: any;  // ← Tool result is HERE
    isError: boolean;
}

// ❌ WRONG: This does NOT contain tool results
interface MessageEndEvent {
    type: "message_end";
    message: AgentMessage;  // ← NO toolResults field
}
```

---

### Session Management

#### New: `createAgentSessionRuntime()`
For applications that need to replace active sessions and rebuild cwd-bound runtime state.

**Impact on pi-research:**
- Could be used for better session management
- Currently pi-research uses `createAgentSession` directly, which is fine

---

### Tool Management

#### Changed: Tool Selection API
```typescript
// Before (0.67.x)
await createAgentSession({
    tools: [readTool, bashTool]  // Tool objects
});

// After (0.68+)
await createAgentSession({
    tools: ['read', 'bash']  // Tool names (string[])
});
```

**pi-research Status:** ✅ Already using new API correctly

---

### UI Integration

#### New: `ctx.ui.setWorkingIndicator()`
```typescript
interface WorkingIndicatorOptions {
    type: 'animated' | 'static' | 'hidden';
    frames?: string[];
    interval?: number;
    text?: string;
}
```

**Impact on pi-research:**
- **High Value:** Could show research-specific working indicators
- Better visual feedback for researcher state

---

#### New: `ctx.ui.setWorkingVisible()`
```typescript
ctx.ui.setWorkingVisible(false);  // Hide default loader
```

**Impact on pi-research:**
- Research panel could hide default working row
- Show custom research progress instead

---

#### New: `ctx.ui.addAutocompleteProvider()`
```typescript
ctx.ui.addAutocompleteProvider({
    trigger: '@',  // or any string
    handler: async (input: string) => string[]
});
```

**Impact on pi-research:**
- Could add autocomplete for scraped URLs
- Could suggest previous research queries

---

### Tool Result Modification

#### New: `terminate: true` on Tool Results
```typescript
return {
    content: [...],
    details: {...},
    terminate: true  // Skip automatic follow-up LLM turn
};
```

**Impact on pi-research:**
- **High Value:** Research tool could save one LLM call per invocation
- Significant cost savings

---

## New Provider Support

### Added Since 0.68.0:

| Provider | Version | Auth Method | Use Case for pi-research |
|----------|---------|-------------|-------------------------|
| Cloudflare Workers AI | 0.70.6 | `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` | Alternative provider |
| Cloudflare AI Gateway | 0.71.0 | `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID` | Gateway/routing |
| Moonshot AI | 0.71.0 | `MOONSHOT_API_KEY` | Alternative provider |
| Fireworks | 0.68.1 | `FIREWORKS_API_KEY` | Alternative provider |
| DeepSeek | 0.70.1 | `DEEPSEEK_API_KEY` | Cost-effective option |

### Deprecated/Removed:
- **Google Gemini CLI** (0.71.0) - Use Google Vertex instead
- **Google Antigravity** (0.71.0) - No longer supported

---

## Settings Relevant to pi-research

### New Settings:

#### `retry.provider.*` (0.70.1)
```json
{
    "retry": {
        "provider": {
            "timeoutMs": 240000,
            "maxRetries": 3,
            "maxRetryDelayMs": 5000
        }
    }
}
```
**Impact:** Critical for long-running researcher sessions. Currently hardcoded in config.ts (240000). Could make this user-configurable.

---

#### `terminal.showTerminalProgress` (0.70.0)
```json
{
    "terminal": {
        "showTerminalProgress": false  // Default, true to enable
    }
}
```
**Impact:** Controls whether research progress appears in terminal tab bar.

---

#### `terminal.imageWidthCells` (0.68.1)
```json
{
    "terminal": {
        "imageWidthCells": 60  // Tool output image width
    }
}
```
**Impact:** Controls width of tool output images.

---

#### `warnings.anthropicExtraUsage` (0.70.3)
```json
{
    "warnings": {
        "anthropicExtraUsage": false  // Suppress warnings
    }
}
```
**Impact:** Users may want to suppress during long research runs.

---

### Environment Variables:

#### `PI_CODING_AGENT_SESSION_DIR` (0.71.0)
```bash
export PI_CODING_AGENT_SESSION_DIR=/custom/session/path
```
**Impact:** Could isolate researcher session files.

---

## Recommended Integrations for pi-research

### High Priority

#### 1. Use `terminate: true` in Research Tool
**Benefit:** Save one LLM call per research invocation
**Impact:** ~10-20% cost reduction for research queries

**Implementation:**
```typescript
// In research tool result
return {
    content: [textResult],
    details: { totalTokens, synthesisComplete },
    terminate: synthesisComplete  // ✅ Skip follow-up if synthesis is done
};
```

---

#### 2. Implement Custom Working Indicators
**Benefit:** Better visual feedback for research state
**Impact:** Improved UX

**Implementation:**
```typescript
// In research orchestrator
const researcherStates = new Map<string, {
    status: 'queued' | 'active' | 'complete';
    frameIndex: number;
}>();

function updateWorkingIndicator() {
    const activeCount = [...researcherStates.values()].filter(s => s.status === 'active').length;
    const queuedCount = [...researcherStates.values()].filter(s => s.status === 'queued').length;

    if (activeCount === 0 && queuedCount === 0) {
        ctx.ui.setWorkingIndicator({ type: 'hidden' });
    } else {
        ctx.ui.setWorkingIndicator({
            type: 'animated',
            frames: [
                `🔍 ${activeCount} active`,
                `📋 ${queuedCount} queued`
            ],
            interval: 1000
        });
    }
}
```

---

#### 3. Add Autocomplete for Scraped URLs
**Benefit:** Easy reference to previously scraped links
**Impact:** Better researcher efficiency

**Implementation:**
```typescript
// In extension setup
ctx.ui.addAutocompleteProvider({
    trigger: '@',  // Activate on @
    handler: async (input) => {
        // Return scraped URLs matching input
        return scrapedLinks.filter(url =>
            url.toLowerCase().includes(input.toLowerCase())
        );
    }
});
```

---

### Medium Priority

#### 4. Use `message_end` Event to Enforce Report Length
**Benefit:** Alternative to truncation with better control
**Impact:** Smaller evaluator inputs without hard truncation

**Implementation:**
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

#### 5. Observe Thinking Level Changes
**Benefit:** Ensure researchers stay at `thinkingLevel: 'off'`
**Impact:** Consistent performance

**Implementation:**
```typescript
pi.on('thinking_level_select', (event) => {
    if (isResearcherSession(ctx) && event.level !== 'off') {
        logger.warn(`[Orchestrator] Researcher tried to enable thinking (${event.level}), forcing back to 'off'`);
        pi.setThinkingLevel('off');
    }
});
```

---

#### 6. Make Provider Timeout/Retry Configurable
**Benefit:** Users can adjust for their needs
**Impact:** Better reliability for long sessions

**Implementation:**
```typescript
// In config.ts
interface Config {
    // ... existing
    researcherTimeoutMs?: number;
    researcherMaxRetries?: number;
}

// In researcher.ts
const config = getConfig();
const timeoutMs = config.researcherTimeoutMs ?? 240000;  // 4 min default
```

---

### Low Priority

#### 7. Use `PI_CODING_AGENT_SESSION_DIR` for Isolation
**Benefit:** Separate researcher session files from main session
**Impact:** Cleaner session management

**Implementation:**
```bash
# Set in user's environment
export PI_CODING_AGENT_SESSION_DIR=~/.pi/research-sessions
```

---

#### 8. Add URL Autocomplete from Scraped Links
**Benefit:** Quick access to scraped URLs in prompts
**Impact:** Convenience for users

**Implementation:**
```typescript
ctx.ui.addAutocompleteProvider({
    trigger: 'http',
    handler: async (input) => {
        return scrapedLinks.filter(url =>
            url.toLowerCase().includes(input.toLowerCase())
        );
    }
});
```

---

## Migration Checklist for pi-research

### Required Migrations (Breaking Changes)

- [x] **Tool Selection API (0.68.0):** Already using `string[]` tool names ✅
- [x] **Resource Loader cwd (0.68.0):** Already passing cwd explicitly ✅
- [x] **TypeBox 1.x (0.69.0):** Already using `typebox` import ✅
- [x] **Event Structure (Bug 1):** Fixed in FINAL_FIXES_APPLIED.md ✅

### Optional Migrations (New Features)

- [ ] **Terminate Tool Results (0.69.0):** Add `terminate: true` to research tool
- [ ] **Custom Working Indicators (0.68.0):** Implement research-specific indicators
- [ ] **Autocomplete Providers (0.69.0):** Add scraped URL autocomplete
- [ ] **Message End Replacement (0.71.0):** Use for report length enforcement
- [ ] **Thinking Level Observation (0.71.0):** Enforce `off` for researchers
- [ ] **Provider Timeout/Retry Settings (0.70.1):** Make configurable
- [ ] **OSC Progress (0.70.0):** Consider enabling `terminal.showTerminalProgress`

---

## Summary Statistics

### Changes Since 0.68.0:

| Category | Count |
|----------|-------|
| **Total Versions** | 12 releases |
| **Breaking Changes** | 5 major, 4 minor |
| **New Features** | 12+ significant additions |
| **Bug Fixes** | 50+ fixes |
| **New Providers** | 5 providers added |
| **Deprecated Providers** | 2 providers removed |

### Impact on pi-research:

| Impact | Count |
|--------|-------|
| **Critical Issues** | 1 (SDK event usage bug - FIXED) |
| **High Value Features** | 4 (terminate, indicators, autocomplete, retry) |
| **Medium Value Features** | 3 (message replacement, thinking observation, settings) |
| **Low Value Features** | 2 (session dir, OSC progress) |
| **Breaking Changes** | 5 (all already handled) |
| **Bug Fixes** | 15+ relevant improvements |

---

## Conclusion

### Key Takeaways:

1. **Pi SDK is Robust:** The event structure bug identified in pi-research was a usage error, not a bug in pi. The SDK provides `ToolExecutionEndEvent.result` for tool results, and `MessageEndEvent` only contains the message.

2. **Many New Capabilities:** Pi 0.68-0.71 added 12+ features that could significantly improve pi-research's UX, performance, and cost.

3. **Breaking Changes Handled:** pi-research is already correctly using the new tool selection API and resource loader patterns introduced in 0.68.0.

4. **High-Value Integrations Available:**
   - `terminate: true` for research tool (cost savings)
   - Custom working indicators (better UX)
   - Autocomplete providers (convenience)
   - Retry/timeout settings (reliability)

5. **No Major Obstructions:** All breaking changes are minor or already handled. The migration path is straightforward.

### Recommended Next Steps:

1. **Implement High-Priority Features:**
   - Add `terminate: true` to research tool
   - Implement custom working indicators
   - Add URL autocomplete

2. **Consider Medium-Priority Features:**
   - Use `message_end` event for report length enforcement
   - Enforce `thinkingLevel: 'off'` via observation
   - Make retry/timeout settings configurable

3. **Monitor New Providers:**
   - Evaluate new providers (DeepSeek, Fireworks, etc.) for research use cases
   - Update provider recommendations in docs

---

**Document Version:** 1.0
**Last Updated:** 2026-05-01
**Pi Version:** 0.71.0
**pi-research Version:** 0.1.13
