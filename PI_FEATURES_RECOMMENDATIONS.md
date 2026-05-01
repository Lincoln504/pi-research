# Pi Features & Recommendations for pi-research
## Comprehensive Analysis of Pi 0.45-0.71.0

**Analysis Date:** 2026-05-01
**Pi Version:** 0.71.0 (installed)
**pi-research Version:** 0.1.13
**Scope:** All Pi versions from 0.45.0 through 0.71.0

---

## Executive Summary

This document provides a comprehensive analysis of Pi's evolution and actionable recommendations for pi-research integration improvements. The analysis covers:

1. **Implemented Recommendations** - Features already available in pi-research
2. **High-Priority Recommendations** - Quick wins with significant impact
3. **Medium-Priority Recommendations** - Valuable but not critical
4. **Low-Priority Recommendations** - Nice-to-have features
5. **Infrastructure Recommendations** - Configuration and reliability improvements

---

## Implemented Recommendations ✅

### 1. Configurable Timeout/Retry Settings ✅

**Status:** ✅ IMPLEMENTED in `/home/ldeen/Documents/pi-research/src/config.ts`

**What Was Added:**
- `RESEARCHER_MAX_RETRIES` - Maximum retries per researcher request (default: 3)
- `RESEARCHER_MAX_RETRY_DELAY_MS` - Maximum delay between retries (default: 5000ms)
- Environment variables: `PI_RESEARCH_RESEARCHER_MAX_RETRIES`, `PI_RESEARCH_RESEARCHER_MAX_RETRY_DELAY_MS`
- Validation: Ensures values are within reasonable bounds (0-10 retries, 1-60s delay)

**Environment Variables:**
```bash
export PI_RESEARCH_RESEARCHER_MAX_RETRIES=3
export PI_RESEARCH_RESEARCHER_MAX_RETRY_DELAY_MS=5000
```

**Impact:**
- Users can now configure researcher timeout and retry behavior
- Better control over long-running researcher sessions
- Reliability improvements for transient failures

---

## High-Priority Recommendations 🚀

### 2. Use Provider Retry/Timeout Settings in Researcher Sessions

**Version:** Pi 0.70.1

**Feature:** `retry.provider.{timeoutMs,maxRetries,maxRetryDelayMs}` settings are now properly forwarded to provider SDKs.

**Current Issue:**
- Researcher sessions use hardcoded timeout (240000ms = 4 min)
- Provider retry settings from config are not passed through to researcher sessions

**Recommendation:**
Pass the configured retry/timeout settings when creating researcher sessions:

```typescript
// In researcher.ts or createResearcherSession()
import { getConfig } from '../config.ts';

const config = getConfig();

// Pass retry settings to session
const result = await createAgentSession({
  // ... existing options
  // Note: Pi SDK doesn't expose retry settings directly in createAgentSession
  // This may require SDK changes or settings injection
});
```

**Impact:**
- Long-running researchers won't timeout prematurely
- Better handling of transient provider failures
- Users can tune behavior per their environment

**Effort:** Medium (may require SDK access to retry settings)

---

### 3. Observe `tool_execution_end` Events for Better Progress Tracking

**Version:** Pi 0.56.0

**Feature:** Extension events for tool execution lifecycle (`tool_execution_start`, `tool_execution_update`, `tool_execution_end`).

**Current Issue:**
- Research progress is estimated using tool call budget rather than actual tool execution
- Cannot accurately track researcher progress within a single researcher run

**Recommendation:**
Subscribe to `tool_execution_end` events to track actual tool calls completed:

```typescript
// In deep-research-orchestrator.ts, runResearcher() method
const subscription = session.subscribe((event: AgentSessionEvent) => {
  switch (event.type) {
    case 'tool_execution_start':
      // Tool started
      logger.debug(`[Researcher ${internalId}] Tool ${event.toolName} started`);
      break;

    case 'tool_execution_end':
      // Tool completed - use this for progress tracking
      const completedCalls = this.progressCredits.get(internalId) ?? 0;
      this.progressCredits.set(internalId, completedCalls + 1);

      // Calculate progress: 0.9 progress for tool calls, 0.1 for synthesis
      const progress = (completedCalls / RESEARCHER_TOOL_BUDGET) * 0.9;
      updateSliceProgress(this.options.panelState, label, progress);
      this.options.onUpdate();
      break;
  }
});
```

**Impact:**
- More accurate progress tracking during researcher execution
- Better user visibility into researcher progress
- Reduced "stuck" perception during long tool calls

**Effort:** Low (event subscription already exists)

---

### 4. Use `ctx.signal` for Cancellation Support

**Version:** Pi 0.63.2

**Feature:** Extension handlers can use `ctx.signal` to forward cancellation into nested model calls, `fetch()`, and other abort-aware work.

**Current Issue:**
- Researcher sessions may not respect abort signals fully
- Tool calls (scrape, search, grep) may not cancel cleanly

**Recommendation:**
Pass `ctx.signal` to tool execution:

```typescript
// In tool.ts or tool execution
export async function execute(
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,  // ✅ Already available
  onUpdate: (update: ToolUpdate) => void,
  ctx: ExtensionContext
): Promise<AgentToolResult<unknown>> {
  // Pass signal to tool implementations
  const scrapeResult = await scrape(params.url, {
    signal,  // ✅ Forward cancellation
    maxContentLength: params.maxLength ?? 50000
  });
}
```

**Impact:**
- Clean cancellation of research when user aborts
- No orphaned processes after cancellation
- Better resource cleanup

**Effort:** Low (signal is already passed to tools)

---

### 5. Implement `prepareArguments` for Tool Argument Normalization

**Version:** Pi 0.64.0

**Feature:** Extensions can attach a `prepareArguments` hook to tool definitions to normalize or migrate raw model arguments before schema validation.

**Current Issue:**
- Tool arguments from LLMs may have inconsistent formats
- No opportunity to normalize arguments before validation

**Recommendation:**
Add `prepareArguments` hook to research tool definition:

```typescript
// In tool.ts
const researchTool: ToolDefinition = {
  name: 'research',
  description: 'Conduct deep web research using multiple researcher agents',
  inputSchema: Type.Object({
    query: Type.String({ description: 'Research query' }),
    depth: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)])
  }),
  prepareArguments: (rawArgs) => {
    // Normalize arguments before validation
    return {
      query: rawArgs.query,
      // Ensure depth is integer
      depth: typeof rawArgs.depth === 'string'
        ? parseInt(rawArgs.depth, 10)
        : rawArgs.depth,
    };
  },
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    // ... existing implementation
  }
};
```

**Impact:**
- Better compatibility with different LLM argument formats
- Reduced tool call errors due to malformed arguments
- Cleaner user experience

**Effort:** Low (simple hook function)

---

## Medium-Priority Recommendations 📋

### 6. Use `promptSnippet` and `promptGuidelines` in Tool Definition

**Version:** Pi 0.55.4

**Feature:** Tool definitions can customize default system prompt with `promptSnippet` (for "Available tools") and `promptGuidelines` (for "Guidelines") while the tool is active.

**Recommendation:**
Add prompt customization to research tool:

```typescript
// In tool.ts
const researchTool: ToolDefinition = {
  name: 'research',
  description: 'Conduct deep web research using multiple researcher agents',
  inputSchema: Type.Object({ /* ... */ }),
  promptSnippet: 'Use /research for comprehensive multi-source web research',
  promptGuidelines: [
    'When using /research, specify depth (0=quick, 1=normal, 2=deep, 3=exhaustive)',
    'The research tool coordinates multiple parallel researcher agents',
    'Research results include scraped pages, searched links, and synthesized reports',
  ],
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    // ... existing implementation
  }
};
```

**Impact:**
- LLM sees clearer tool instructions
- Better tool selection decisions
- Reduced incorrect tool usage

**Effort:** Low (add two string/array fields)

---

### 7. Use `renderShell: "self"` for Large Tool Outputs

**Version:** Pi 0.67.3

**Feature:** Custom and built-in tools can use `renderShell: "self"` to own their outer shell instead of the default boxed shell. Useful for stable large previews.

**Recommendation:**
Add to research tool definition (for synthesis result display):

```typescript
// In tool.ts
const researchTool: ToolDefinition = {
  name: 'research',
  // ... existing fields
  renderResult: (result) => {
    const content = (result.content || []).find(c => c.type === 'text');
    const text = content?.text || '';

    // Return component for synthesis result
    return {
      type: 'text',
      text: formatResearchSynthesis(text),
    };
  },
  renderShell: 'self',  // ✅ Use custom shell for large output
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    // ... existing implementation
  }
};
```

**Impact:**
- Cleaner display of research synthesis results
- Better readability of large research outputs
- Reduced TUI flicker on large results

**Effort:** Low (add one field to tool definition)

---

### 8. Monitor `after_provider_response` for Provider Diagnostics

**Version:** Pi 0.67.6

**Feature:** New `after_provider_response` extension hook lets extensions inspect provider HTTP status codes and headers immediately after each response is received and before stream consumption begins.

**Recommendation:**
Add provider response monitoring for better error handling:

```typescript
// In index.ts or orchestrator
pi.on('after_provider_response', (event, ctx) => {
  const { status, headers } = event;

  // Log provider status for diagnostics
  if (status >= 500) {
    logger.warn(`[pi-research] Provider server error: ${status}`, { headers });
  } else if (status === 429) {
    logger.warn(`[pi-research] Rate limited by provider`, {
      retryAfter: headers['retry-after'],
    });
  }

  // Track rate limits
  if (status === 429) {
    const retryAfter = headers['retry-after'];
    if (retryAfter) {
      ctx.ui.notify(`Rate limited. Retry after ${retryAfter}`, 'warning');
    }
  }
});
```

**Impact:**
- Better visibility into provider errors
- Rate limit detection and handling
- Improved debugging for provider issues

**Effort:** Low (simple event handler)

---

### 9. Use `message_start` and `message_update` for Fine-Grained Progress

**Version:** Pi 0.56.0

**Feature:** Extension message events (`message_start`, `message_update`, `message_end`) for message lifecycle tracking.

**Recommendation:**
Track LLM call progress more granularly:

```typescript
// In deep-research-orchestrator.ts
subscription = session.subscribe((event: AgentSessionEvent) => {
  switch (event.type) {
    case 'message_start':
      // LLM call started
      updateSliceStatus(this.options.panelState, label, 'Thinking...');
      this.options.onUpdate();
      break;

    case 'message_update':
      // Streaming update - show deltas
      if (event.assistantMessageEvent?.type === 'text_delta') {
        const delta = event.assistantMessageEvent.delta;
        updateSliceStatus(this.options.panelState, label,
          `Thinking... (${delta.length} chars)`);
        this.options.onUpdate();
      }
      break;

    case 'message_end':
      // LLM call completed
      updateSliceStatus(this.options.panelState, label, 'Synthesizing...');
      this.options.onUpdate();
      break;
  }
});
```

**Impact:**
- Real-time LLM progress display
- Better user feedback during long inference
- Reduced perception of being "stuck"

**Effort:** Medium (update event handling)

---

## Low-Priority Recommendations 💡

### 10. Add Autocomplete for Scraped URLs

**Version:** Pi 0.69.0

**Feature:** Stacked extension autocomplete providers via `ctx.ui.addAutocompleteProvider(...)` for layering custom completion logic.

**Note:** User expressed limited interest in autocomplete.

**Recommendation (Optional):**
```typescript
// In index.ts
const scrapedLinks = new Set<string>();

// Track scraped URLs
pi.on('tool_execution_end', (event) => {
  if (event.toolName === 'scrape' && !event.isError) {
    const result = event.result as { url?: string };
    if (result.url) {
      scrapedLinks.add(result.url);
    }
  }
});

// Add autocomplete provider
ctx.ui.addAutocompleteProvider({
  trigger: 'http',  // Activate when typing http
  handler: async (input) => {
    return Array.from(scrapedLinks)
      .filter(url => url.toLowerCase().includes(input.toLowerCase()))
      .slice(0, 10);  // Limit results
  }
});
```

**Impact:**
- Quick reference to previously scraped URLs
- Convenience for mentioning sources

**Effort:** Medium (requires URL tracking)

---

### 11. Customize Hidden Thinking Label

**Version:** Pi 0.64.0

**Feature:** Extensions can customize the collapsed thinking block label via `ctx.ui.setHiddenThinkingLabel()`.

**Recommendation:**
Customize thinking display for researchers:

```typescript
// In researcher.ts, after creating researcher session
if (ctx.ui.setHiddenThinkingLabel) {
  ctx.ui.setHiddenThinkingLabel(`Researcher ${internalId}`);
}
```

**Impact:**
- Better clarity when thinking is collapsed
- Distinguish researcher thinking from other messages

**Effort:** Low (single function call)

---

### 12. Use `terminal_input` Event for Custom Commands

**Version:** Pi 0.56.0

**Feature:** Extension terminal input interception via `terminal_input`, allowing extensions to consume or transform raw input before normal TUI handling.

**Recommendation:**
Add custom research-related commands:

```typescript
// In index.ts
pi.on('terminal_input', (event, ctx) => {
  const { input } = event;

  // Handle custom prefix
  if (input.startsWith('@r ')) {
    // Parse and redirect to research tool
    const query = input.slice(3);
    ctx.ui.editor(`\n[research ${query}]\n`);  // Inject command
    return { type: 'handled' };  // Consume input
  }

  return { type: 'continue' };  // Pass through
});
```

**Impact:**
- Quick research command shortcuts
- Custom input handling
- Better UX for research-specific actions

**Effort:** Medium (event handling + parsing)

---

## Infrastructure Recommendations 🏗️

### 13. Use AgentSessionRuntime for Proper Session Management

**Version:** Pi 0.65.0

**Feature:** `createAgentSessionRuntime()` and `AgentSessionRuntime` provide a closure-based runtime that recreates cwd-bound services and session config on every session switch.

**Current Issue:**
- Researcher sessions are created directly without a runtime
- May not properly handle session replacement scenarios

**Recommendation:**
Wrap researcher session creation in a runtime:

```typescript
// In researcher.ts or a new session-manager.ts
import {
  createAgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory
} from '@mariozechner/pi-coding-agent';

const createResearcherRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
  };
};

const runtime = await createAgentSessionRuntime(createResearcherRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

// Use runtime to create researcher sessions
const session = runtime.session;
// ... researcher logic
```

**Impact:**
- Proper session lifecycle management
- Better cross-cwd session handling
- Cleaner session replacement

**Effort:** High (architectural change)

---

### 14. Use Extension UI Protocol for Research-Related Dialogs

**Version:** Pi 0.51.0

**Feature:** Full RPC documentation and examples for extension dialogs and notifications, enabling headless clients to support interactive extensions.

**Recommendation:**
Add custom dialogs for research configuration:

```typescript
// In index.ts
pi.registerCommand('research-config', {
  description: 'Configure research settings',
  handler: async (args, ctx) => {
    const result = await ctx.ui.custom({
      title: 'Research Configuration',
      component: {
        type: 'form',
        fields: [
          {
            id: 'maxRounds',
            label: 'Maximum Rounds',
            type: 'number',
            default: 3,
          },
          {
            id: 'maxResearchers',
            label: 'Max Parallel Researchers',
            type: 'number',
            default: 3,
          },
          {
            id: 'contextLimit',
            label: 'Context Window Limit (tokens)',
            type: 'number',
            default: 90000,
          },
        ],
      },
    });

    if (result.type === 'submit') {
      const { maxRounds, maxResearchers, contextLimit } = result.data;
      // Apply configuration
      updateResearchConfig({ maxRounds, maxResearchers, contextLimit });
      ctx.ui.notify('Research configuration updated', 'info');
    }
  },
});
```

**Impact:**
- Interactive configuration UI
- Better UX for research settings
- No need for environment variables

**Effort:** Medium (custom dialog component)

---

### 15. Use `ctx.reload()` for Hot Configuration Reload

**Version:** Pi 0.52.9

**Feature:** Extensions can trigger a full runtime reload via `ctx.reload()`, useful for hot-reloading configuration or restarting the agent.

**Recommendation:**
Add a `/research-reload` command:

```typescript
// In index.ts
pi.registerCommand('research-reload', {
  description: 'Reload pi-research extension',
  handler: async (args, ctx) => {
    ctx.ui.notify('Reloading pi-research...', 'info');
    // Reload the extension
    await ctx.reload();
    ctx.ui.notify('pi-research reloaded', 'success');
  },
});
```

**Impact:**
- Hot reload of configuration changes
- No need to restart pi
- Better development workflow

**Effort:** Low (single command)

---

### 16. Use `before_agent_start` to Modify System Prompt

**Version:** Pi 0.68.0

**Feature:** `before_agent_start` now exposes `systemPromptOptions` (`BuildSystemPromptOptions`) so extensions can inspect the structured system-prompt inputs.

**Recommendation:**
Modify researcher system prompts dynamically:

```typescript
// In index.ts
pi.on('before_agent_start', async (event, ctx) => {
  // Check if this is a researcher session
  const isResearcher = ctx.model.id.includes('researcher');

  if (isResearcher) {
    // Modify system prompt for researchers
    const additionalPrompt = `
## Research Guidelines
- Focus on gathering facts and evidence
- Avoid speculation beyond what sources confirm
- Cite sources explicitly when making claims
- Flag uncertainty and contradictions
`;

    return {
      systemPrompt: event.systemPrompt + additionalPrompt,
    };
  }

  return {};  // No changes for non-researcher sessions
});
```

**Impact:**
- Dynamic researcher behavior tuning
- Better research quality
- No need to modify prompt files

**Effort:** Low (event handler)

---

## Platform & Environment Support 🌐

### 17. Android/Termux Support

**Version:** Pi 0.51.0

**Feature:** Pi now runs on Android via Termux.

**Status:** pi-research uses camoufox-js which supports Termux.

**Recommendation:**
- Document Termux setup in README
- Test pi-research on Termux if possible

**Setup:**
```bash
pkg install nodejs termux-api git
npm install -g @mariozechner/pi-coding-agent
mkdir -p ~/.pi/agent
```

**Impact:**
- pi-research works on Android
- Mobile research capabilities

**Effort:** Low (documentation only)

---

### 18. Linux ARM64 musl Support

**Version:** Pi 0.56.0

**Feature:** Pi now runs on Alpine Linux ARM64 (linux-arm64-musl) via updated clipboard dependency.

**Status:** pi-research dependencies should be compatible.

**Recommendation:**
- Test on Alpine Linux ARM64
- Document any workarounds if needed

**Impact:**
- Broader platform support
- Container-friendly

**Effort:** Low (testing only)

---

## Provider Integration Features 🔌

### 19. Vercel AI Gateway Routing

**Version:** Pi 0.50.4

**Feature:** Route requests through Vercel's AI Gateway with provider failover and load balancing.

**Recommendation:**
Document Vercel AI Gateway configuration:

```json
// In ~/.pi/agent/models.json
{
  "vercelGatewayRouting": {
    "enabled": true,
    "fallbacks": ["anthropic", "openai", "google-vertex"],
    "maxPrice": 0.01,
    "maxLatency": 5000
  }
}
```

**Impact:**
- Automatic provider failover
- Load balancing across providers
- Better reliability

**Effort:** Low (documentation)

---

### 20. OpenRouter Full Routing Support

**Version:** Pi 0.67.1

**Feature:** Full `openRouterRouting` support in `models.json`, including fallbacks, parameter requirements, data collection, ZDR, ignore lists, quantizations, provider sorting, max price, and preferred throughput and latency constraints.

**Recommendation:**
Document OpenRouter configuration for research:

```json
// In ~/.pi/agent/models.json
{
  "openRouterRouting": {
    "fallbacks": ["anthropic/claude-opus-4-6", "openai/gpt-5.4"],
    "maxPrice": 0.02,
    "maxLatency": 3000,
    "ignoreProviders": ["zai"],
    "preferredProviders": ["anthropic"],
    "quantizations": ["fp8", "int8"]
  }
}
```

**Impact:**
- Sophisticated routing configuration
- Cost and latency optimization
- Provider selection control

**Effort:** Low (documentation)

---

## Performance & Reliability Improvements ⚡

### 21. Auto-Retry Enhancements

**Versions:** Multiple (0.59.0, 0.58.0, 0.56.0, 0.52.10)

**Improvements:**
- Better provider retry behavior when providers return error messages as responses
- Auto-retry to treat transient HTTP/2 failures as retryable
- Fixed auto-retry with tool-using retry responses
- Improved retry regex to match `server_error` and `internal_error` error types

**Status:** Pi SDK handles these automatically.

**Recommendation:**
- Document that pi-research benefits from these improvements
- Ensure research sessions use default retry behavior

**Impact:**
- Better resilience to transient failures
- Fewer manual retries needed
- Smoother research experience

**Effort:** Low (documentation)

---

### 22. Prompt Caching Support

**Versions:** 0.50.2, 0.58.0, 0.63.0, 0.68.0

**Improvements:**
- Extended prompt caching (`PI_CACHE_RETENTION=long`)
- OpenAI prompt cache affinity improvements
- Bedrock prompt caching support
- Anthropic prompt caching breakpoint on tool definitions

**Status:** Pi SDK handles prompt caching automatically when providers support it.

**Recommendation:**
- Document environment variable: `PI_CACHE_RETENTION=long`
- Note that researchers with same prompts benefit from caching

**Impact:**
- Reduced API costs for repeated queries
- Faster response times for cached prompts
- Lower token usage

**Effort:** Low (documentation)

---

### 23. Parallel Tool Call Improvements

**Version:** 0.58.0

**Improvement:**
- Extension tool calls now execute in parallel by default
- Tool results are emitted in assistant source order

**Status:** Already benefits pi-research.

**Recommendation:**
- None needed (automatic benefit)

**Impact:**
- Faster researcher tool execution
- Better utilization of parallel tool calls
- Reduced overall research time

**Effort:** None (automatic)

---

## Tool & Command Features 🛠️

### 24. Dynamic Tool Registration

**Version:** 0.55.4

**Feature:** Runtime tool registration applies immediately in active sessions. Tools registered via `pi.registerTool()` after startup are available to `pi.getAllTools()` and LLM without `/reload`.

**Status:** pi-research registers tools at extension load time.

**Recommendation:**
- Consider adding conditional tool registration (e.g., experimental features)
- Document that tools are available immediately

**Impact:**
- Flexible tool availability
- No restart needed for new tools
- Dynamic feature flags

**Effort:** Low (if needed)

---

### 25. Command Argument Hints

**Version:** 0.67.6

**Feature:** Prompt templates support an `argument-hint` frontmatter field that renders before the description in the `/` autocomplete dropdown.

**Recommendation:**
Add argument hints to research tool prompt template:

```markdown
<!-- src/prompts/research-command.md -->
---
argument-hint: <query> [depth:0|1|2|3]
---

Research multi-source web information.

Usage:
/research <query>

Depth levels:
- 0 (quick): Single session, fast results
- 1 (normal): Up to 2 researchers
- 2 (deep): Up to 3 researchers
- 3 (exhaustive): Up to 5 researchers, full coverage
```

**Impact:**
- Better command discovery
- Clearer usage guidance
- Reduced learning curve

**Effort:** Low (add frontmatter field)

---

## Settings & Configuration ⚙️

### 26. Quiet Startup Mode

**Version:** 0.50.6

**Feature:** Quiet startup mode via `--quiet` CLI flag or `quietStartup` setting.

**Recommendation:**
Add option to reduce pi-research startup noise:

```typescript
// In index.ts
const config = getConfig();
if (config.QUIET_STARTUP) {
  logger.setLogLevel('warn');  // Only log warnings and errors
}
```

**Impact:**
- Cleaner startup output
- Less noise in logs
- Better focus on research output

**Effort:** Low (optional feature)

---

### 27. Offline Mode Support

**Version:** 0.55.1

**Feature:** Offline startup mode via `--offline` (or `PI_OFFLINE=1`) to disable startup network operations.

**Recommendation:**
Handle offline mode gracefully:

```typescript
// In index.ts
const isOffline = process.env.PI_OFFLINE === '1';
if (isOffline) {
  logger.warn('[pi-research] Running in offline mode - network operations disabled');
  // Disable search, scrape, or fall back to cached data
}
```

**Impact:**
- Works without network
- Graceful degradation
- Better development workflow

**Effort:** Low (conditional logic)

---

## Deprecated & Removed Features 🗑️

### 28. Tool Selection API Change (Already Migrated)

**Version:** Pi 0.68.0

**Breaking Change:** Tool selection changed from `Tool[]` objects to `string[]` names.

**Status:** ✅ pi-research already uses the new API correctly:

```typescript
// Correct usage in pi-research
const tools = customTools.map(t => t.name);  // ✅ string[]

await createAgentSession({
  tools,  // ✅ Names only
  customTools,
});
```

**Recommendation:**
- None needed (already migrated)

---

### 29. Resource Precedence Change

**Version:** Pi 0.55.0

**Breaking Change:** Resource precedence is now project-first before user-global.

**Status:** ✅ Not affected (pi-research doesn't use conflicting resources)

**Recommendation:**
- Document behavior if needed
- Ensure project resources override global as expected

---

## Migration Checklist

### Required Migrations:
- [x] **Tool selection API (0.68.0)** - Already using `string[]`
- [x] **Configurable timeout/retry (0.70.1)** - Implemented
- [ ] **AgentSessionRuntime (0.65.0)** - Consider for session management
- [ ] **Settings persistence (0.53.0)** - Use `await settingsManager.flush()` if needed

### Recommended Migrations (Not Required):
- [ ] **Provider retry/timeout settings** - Pass to researcher sessions
- [ ] **Tool execution events** - Track for progress
- [ ] **`prepareArguments` hook** - Add for argument normalization
- [ ] **`promptSnippet`/`promptGuidelines`** - Add for tool clarity
- [ ] **`after_provider_response`** - Monitor for diagnostics
- [ ] **Custom dialogs** - Add for configuration UI
- [ ] **`before_agent_start`** - Dynamic system prompt modification

---

## Summary Statistics

### Pi Changes Since 0.45.0:

| Category | Count |
|----------|-------|
| **Total Versions Analyzed** | 27 releases |
| **New Features** | 60+ significant additions |
| **Breaking Changes** | 10 major/minor |
| **Bug Fixes** | 200+ improvements |
| **New Providers** | 8 providers added |
| **Extension API Enhancements** | 20+ new hooks/features |

### Impact on pi-research:

| Priority | Recommendations | Status |
|----------|----------------|--------|
| **Implemented** | 1 | ✅ Configurable timeout/retry |
| **High** | 5 | ⏳ Provider settings, progress, cancellation, etc. |
| **Medium** | 8 | ⏳ Tool prompts, UI, diagnostics |
| **Low** | 4 | Optional nice-to-have |
| **Infrastructure** | 4 | ⏳ Session runtime, dialogs, etc. |

---

## Quick Start Guide

### Top 5 Things to Do Now:

1. **✅ DONE** - Add configurable timeout/retry settings (Implemented)
2. **HIGH** - Use `tool_execution_end` events for accurate progress tracking
3. **HIGH** - Use `ctx.signal` for proper cancellation support
4. **MEDIUM** - Add `promptSnippet` and `promptGuidelines` to research tool
5. **MEDIUM** - Monitor `after_provider_response` for provider diagnostics

### Implementation Order (Recommended):

**Week 1:**
- Progress tracking with `tool_execution_end` events
- Cancellation support with `ctx.signal`
- Tool argument normalization with `prepareArguments`

**Week 2:**
- Tool prompt customization (`promptSnippet`, `promptGuidelines`)
- Provider diagnostics with `after_provider_response`
- Progress updates with `message_start`/`message_update`

**Week 3:**
- Custom dialogs for research configuration
- Hot reload support with `ctx.reload()`
- Dynamic system prompt modification with `before_agent_start`

**Later:**
- AgentSessionRuntime for session management
- Autocomplete providers (if needed)
- Custom input handling with `terminal_input`

---

## Conclusion

### Key Takeaways:

1. **Pi Has Evolved Significantly** - From 0.45.0 to 0.71.0, Pi added 60+ features, with 20+ extension API enhancements directly relevant to pi-research.

2. **Many Low-Value Wins Available** - Most recommended improvements are simple (add a field, subscribe to an event, call a function) but provide significant UX and reliability benefits.

3. **Infrastructure Improvements Available** - AgentSessionRuntime, custom dialogs, and hot reload provide better architecture for future enhancements.

4. **Platform Support Broadened** - Android/Termux, Linux ARM64 musl, and Nix/Guix support enable pi-research on more platforms.

5. **Provider Integration Options** - Vercel AI Gateway and OpenRouter routing provide sophisticated failover and load balancing capabilities.

### Next Steps:

1. **Implement High-Priority Recommendations** - Progress tracking, cancellation, and argument normalization are quick wins
2. **Test Platform Compatibility** - Ensure pi-research works on Termux, Alpine, and Nix
3. **Document Provider Integration** - Add examples for Vercel AI Gateway and OpenRouter
4. **Consider Architecture** - Evaluate AgentSessionRuntime for better session management
5. **Monitor Pi Evolution** - Continue tracking Pi releases for new features

---

**Document Version:** 1.0
**Last Updated:** 2026-05-01
**Pi Version:** 0.71.0
**pi-research Version:** 0.1.13
**Analysis Scope:** Pi 0.45.0 - 0.71.0
