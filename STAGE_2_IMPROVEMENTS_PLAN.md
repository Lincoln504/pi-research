# Stage 2 Improvements Plan
**Date:** 2026-05-01
**Based On:** PI_FEATURES_RECOMMENDATIONS.md (Pi 0.45-0.71.0 analysis)
**Scope:** Medium-priority and low-priority improvements

---

## Executive Summary

After reviewing the Stage 1 implementation (which included some scope creep), this plan focuses on **medium-priority improvements** that provide significant value with manageable risk. These improvements build on Pi's extension API enhancements from versions 0.45-0.71.0.

**Goal:** Implement 4-6 high-value medium-priority improvements over 2-3 sprints.

---

## Priority Classification

### Priority 1: Implement First (High Value, Low Risk)
These provide immediate value with minimal code changes.

### Priority 2: Implement Second (Medium Value, Medium Risk)
These require more work but provide significant benefits.

### Priority 3: Consider Later (Lower Priority)
These are nice-to-have features.

---

## Priority 1 Improvements

### 1. Tool Execution Progress Tracking

**Pi Feature:** `tool_execution_end` events (v0.56.0)
**Effort:** Low (~30 lines)
**Risk:** Low
**Value:** High

**Description:**
Currently, researcher progress is estimated using a tool call budget rather than actual tool execution. By subscribing to `tool_execution_end` events, we can track actual tool calls completed for more accurate progress tracking.

**Implementation:**

```typescript
// In deep-research-orchestrator.ts, runResearcher() method

// Add progress credit tracking
const completedCalls = new Map<string, number>();

const subscription = session.subscribe((event: AgentSessionEvent) => {
  switch (event.type) {
    case 'tool_execution_start':
      // Tool started
      logger.debug(`[Researcher ${internalId}] Tool ${event.toolName} started`);
      break;

    case 'tool_execution_end':
      if (!event.isError) {
        // Tool completed - track actual progress
        const completed = (completedCalls.get(internalId) ?? 0) + 1;
        completedCalls.set(internalId, completed);

        // Calculate progress: 0.9 progress for tool calls, 0.1 for synthesis
        const progress = (completed / RESEARCHER_TOOL_BUDGET) * 0.9;
        updateSliceProgress(this.options.panelState, label, progress);
        this.options.onUpdate();
      }
      break;
  }
});
```

**Benefits:**
- More accurate progress tracking during researcher execution
- Better user visibility into researcher progress
- Reduced "stuck" perception during long tool calls

**Files Modified:**
- `src/orchestration/deep-research-orchestrator.ts` (~30 lines)

**Testing:**
- Run depth 2 research and verify progress updates accurately
- Verify progress increments on each tool completion
- Test with tool errors (progress should still increment)

---

### 2. Custom Hidden Thinking Label

**Pi Feature:** `ctx.ui.setHiddenThinkingLabel()` (v0.64.0)
**Effort:** Very Low (~5 lines)
**Risk:** Very Low
**Value:** Medium

**Description:**
Customize the collapsed thinking block label for researcher sessions to distinguish researcher thinking from other messages.

**Implementation:**

```typescript
// In researcher.ts, after creating researcher session

const session = await createAgentSession(/* ... */);

// Customize thinking label for researchers
if (ctx.ui?.setHiddenThinkingLabel && typeof ctx.ui.setHiddenThinkingLabel === 'function') {
  ctx.ui.setHiddenThinkingLabel(`Researcher ${internalId}`);
}
```

**Benefits:**
- Better clarity when thinking is collapsed
- Distinguish researcher thinking from other messages
- Improved debugging and troubleshooting

**Files Modified:**
- `src/orchestration/researcher.ts` (~5 lines)

**Testing:**
- Start a deep research session
- Collapse thinking in the TUI
- Verify label shows "Researcher X" instead of generic label

---

### 3. Argument-Hint for Research Tool

**Pi Feature:** `argument-hint` frontmatter field (v0.67.6)
**Effort:** Low (~10 lines)
**Risk:** Very Low
**Value:** Medium

**Description:**
Add an argument-hint to the research-tool-usage.md prompt template to show usage guidance in the `/` autocomplete dropdown.

**Implementation:**

```markdown
<!-- src/prompts/research-tool-usage.md -->
---
argument-hint: <query> [depth:0|1|2|3]
---

When using /research, provide a research query.

Depth levels:
- 0 (quick): Single session, fast results (~85% of queries)
- 1 (normal): Up to 2 researchers, 2 rounds
- 2 (deep): Up to 3 researchers, 3 rounds
- 3 (exhaustive): Up to 5 researchers, 5 rounds
```

**Benefits:**
- Better command discovery
- Clearer usage guidance
- Reduced learning curve

**Files Modified:**
- `src/prompts/research-tool-usage.md` (~10 lines)

**Testing:**
- Type `/` in Pi TUI
- Verify argument-hint appears for research tool
- Verify hint shows correct format

---

## Priority 2 Improvements

### 4. Custom Configuration Dialog

**Pi Feature:** `ctx.ui.custom()` for interactive dialogs (v0.51.0)
**Effort:** Medium (~150 lines)
**Risk:** Medium
**Value:** High

**Description:**
Add a custom dialog for interactive research configuration, allowing users to configure settings without environment variables.

**Implementation:**

```typescript
// In index.ts
pi.registerCommand('research-config', {
  description: 'Configure research settings interactively',
  handler: async (_args, ctx) => {
    const config = getConfig();

    const result = await ctx.ui.custom({
      title: 'Research Configuration',
      component: {
        type: 'form',
        fields: [
          {
            id: 'maxConcurrentResearchers',
            label: 'Max Concurrent Researchers',
            type: 'number',
            default: config.MAX_CONCURRENT_RESEARCHERS,
            min: 1,
            max: 10,
          },
          {
            id: 'researcherTimeoutMs',
            label: 'Researcher Timeout (ms)',
            type: 'number',
            default: config.RESEARCHER_TIMEOUT_MS,
            min: 60000,  // 1 min
            max: 600000, // 10 min
            step: 60000,
          },
          {
            id: 'researcherMaxRetries',
            label: 'Max Retries per Request',
            type: 'number',
            default: config.RESEARCHER_MAX_RETRIES,
            min: 0,
            max: 10,
          },
          {
            id: 'researcherMaxRetryDelayMs',
            label: 'Max Retry Delay (ms)',
            type: 'number',
            default: config.RESEARCHER_MAX_RETRY_DELAY_MS,
            min: 1000,   // 1s
            max: 60000,  // 60s
            step: 1000,
          },
          {
            id: 'tuiRefreshDebounceMs',
            label: 'TUI Refresh Debounce (ms)',
            type: 'number',
            default: config.TUI_REFRESH_DEBOUNCE_MS,
            min: 5,
            max: 100,
            step: 5,
          },
        ],
      },
    });

    if (result.type === 'submit') {
      const data = result.data;

      // Update config
      config.MAX_CONCURRENT_RESEARCHERS = data.maxConcurrentResearchers;
      config.RESEARCHER_TIMEOUT_MS = data.researcherTimeoutMs;
      config.RESEARCHER_MAX_RETRIES = data.researcherMaxRetries;
      config.RESEARCHER_MAX_RETRY_DELAY_MS = data.researcherMaxRetryDelayMs;
      config.TUI_REFRESH_DEBOUNCE_MS = data.tuiRefreshDebounceMs;

      // Validate config
      try {
        validateConfig(config);
        ctx.ui.notify('✅ Configuration updated', 'success');
        logger.info('[pi-research] Configuration updated via dialog:', data);
      } catch (error) {
        ctx.ui.notify(`❌ Invalid configuration: ${error}`, 'error');
      }
    }
  },
});
```

**Benefits:**
- Interactive configuration UI
- No need for environment variables
- Better UX for research settings
- Real-time validation

**Files Modified:**
- `src/index.ts` (~150 lines)
- `src/config.ts` (minor - add mutation support if needed)

**Testing:**
- Run `/research-config` command
- Verify dialog appears with current values
- Modify values and submit
- Verify config is updated
- Test validation (try invalid values)
- Run research with new config to verify

**Notes:**
- Config changes are not persisted across Pi restarts
- For persistence, would need to write to a config file or environment
- This is a runtime-only configuration feature

---

### 5. Provider-Specific Timeout Configuration

**Pi Feature:** Provider retry/timeout settings (v0.70.1)
**Effort:** Medium (~80 lines)
**Risk:** Medium
**Value:** High

**Description:**
Pass provider retry/timeout settings when creating researcher sessions for better timeout handling.

**Implementation:**

**Step 1:** Update config to include provider settings

```typescript
// In config.ts
export interface Config {
  // ... existing fields

  /** Provider request timeout in milliseconds (default: 240000 = 4 min) */
  PROVIDER_TIMEOUT_MS?: number;
  /** Maximum retries for provider requests (default: 3) */
  PROVIDER_MAX_RETRIES?: number;
  /** Maximum delay between provider retries (default: 5000ms) */
  PROVIDER_MAX_RETRY_DELAY_MS?: number;
}

const DEFAULTS: Config = {
  // ... existing defaults
  PROVIDER_TIMEOUT_MS: 240000,
  PROVIDER_MAX_RETRIES: 3,
  PROVIDER_MAX_RETRY_DELAY_MS: 5000,
};

export function createConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    // ... existing config
    PROVIDER_TIMEOUT_MS: parseEnvNumber(
      env,
      'PI_RESEARCH_PROVIDER_TIMEOUT_MS',
      DEFAULTS.PROVIDER_TIMEOUT_MS
    ),
    PROVIDER_MAX_RETRIES: parseEnvNumber(
      env,
      'PI_RESEARCH_PROVIDER_MAX_RETRIES',
      DEFAULTS.PROVIDER_MAX_RETRIES
    ),
    PROVIDER_MAX_RETRY_DELAY_MS: parseEnvNumber(
      env,
      'PI_RESEARCH_PROVIDER_MAX_RETRY_DELAY_MS',
      DEFAULTS.PROVIDER_MAX_RETRY_DELAY_MS
    ),
    // ... rest of config
  };
}
```

**Step 2:** Pass settings to researcher sessions

```typescript
// In researcher.ts or tool.ts
const config = getConfig();

// Note: Pi SDK doesn't expose retry settings directly in createAgentSession
// This is a placeholder implementation - actual implementation depends on SDK capabilities

// When calling the provider API (e.g., via pi-ai), pass retry settings:
const result = await complete(model, {
  messages: [...],
}, {
  apiKey: auth.apiKey,
  headers: auth.headers,
  signal,
  timeoutMs: config.PROVIDER_TIMEOUT_MS,
  // Note: The actual API depends on pi-ai SDK capabilities
});
```

**Step 3:** Add validation

```typescript
// In config.ts
export function validateConfig(config: Config = getConfig()): void {
  // ... existing validation

  if (config.PROVIDER_TIMEOUT_MS !== undefined) {
    if (config.PROVIDER_TIMEOUT_MS < 60000 || config.PROVIDER_TIMEOUT_MS > 600000) {
      throw new Error(
        `PI_RESEARCH_PROVIDER_TIMEOUT_MS must be between 60000ms (1min) and 600000ms (10min), got ${config.PROVIDER_TIMEOUT_MS}ms`
      );
    }
  }

  if (config.PROVIDER_MAX_RETRIES !== undefined) {
    if (config.PROVIDER_MAX_RETRIES < 0 || config.PROVIDER_MAX_RETRIES > 10) {
      throw new Error(
        `PI_RESEARCH_PROVIDER_MAX_RETRIES must be between 0 and 10, got ${config.PROVIDER_MAX_RETRIES}`
      );
    }
  }

  if (config.PROVIDER_MAX_RETRY_DELAY_MS !== undefined) {
    if (config.PROVIDER_MAX_RETRY_DELAY_MS < 1000 || config.PROVIDER_MAX_RETRY_DELAY_MS > 60000) {
      throw new Error(
        `PI_RESEARCH_PROVIDER_MAX_RETRY_DELAY_MS must be between 1000ms (1s) and 60000ms (60s), got ${config.PROVIDER_MAX_RETRY_DELAY_MS}ms`
      );
    }
  }
}
```

**Benefits:**
- Users can configure provider timeout behavior
- Better handling of slow providers
- More control over researcher session timeouts
- Environment variable support for different environments

**Files Modified:**
- `src/config.ts` (~60 lines)
- `src/orchestration/researcher.ts` (~20 lines)

**Testing:**
- Test with different timeout values
- Verify researchers don't timeout prematurely
- Test with fast and slow providers
- Verify retry behavior with different retry counts

**Notes:**
- Implementation depends on Pi SDK capabilities
- May require SDK changes if retry settings not exposed
- Consider documenting this as "experimental" if SDK support is limited

---

### 6. Export History of Previous Research

**Pi Feature:** None specific - general enhancement
**Effort:** Medium (~100 lines)
**Risk:** Low
**Value:** Medium

**Description:**
Add a command to view history of previous research runs, including queries, results, and export paths.

**Implementation:**

```typescript
// In utils/research-history.ts
import { join } from 'node:path';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

const HISTORY_DIR = join(homedir(), '.pi-research', 'history');

export interface ResearchHistoryEntry {
  id: string;
  query: string;
  depth: number;
  timestamp: number;
  exportPath?: string;
  totalTokens: number;
  duration: number;
  status: 'success' | 'error';
}

export function ensureHistoryDir(): void {
  mkdirSync(HISTORY_DIR, { recursive: true });
}

export function saveResearchHistory(entry: ResearchHistoryEntry): void {
  ensureHistoryDir();
  const historyPath = join(HISTORY_DIR, `${entry.id}.json`);
  // Use atomic write for safety
  writeFileSync(historyPath, JSON.stringify(entry, null, 2));
}

export function loadResearchHistory(limit: number = 20): ResearchHistoryEntry[] {
  ensureHistoryDir();
  const files = readdirSync(HISTORY_DIR);
  const entries: ResearchHistoryEntry[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    try {
      const path = join(HISTORY_DIR, file);
      const content = readFileSync(path, 'utf-8');
      const entry = JSON.parse(content) as ResearchHistoryEntry;
      entries.push(entry);
    } catch (error) {
      logger.warn(`[research-history] Failed to load ${file}:`, error);
    }
  }

  // Sort by timestamp (newest first) and limit
  return entries
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

export function formatHistoryEntry(entry: ResearchHistoryEntry): string {
  const date = new Date(entry.timestamp).toLocaleString();
  const depthLabel = ['quick', 'normal', 'deep', 'exhaustive'][entry.depth] ?? 'unknown';
  const duration = `${Math.floor(entry.duration / 60)}m${entry.duration % 60}s`;
  const statusIcon = entry.status === 'success' ? '✅' : '❌';

  return `${statusIcon} ${date} | ${depthLabel} | ${duration} | ${entry.totalTokens} tokens\n   Query: ${entry.query}`;
}

// In index.ts
pi.registerCommand('research-history', {
  description: 'View history of previous research runs',
  handler: async (args, ctx) => {
    const limitStr = args.trim();
    const limit = limitStr ? parseInt(limitStr, 10) : 20;

    const history = loadResearchHistory(limit);

    if (history.length === 0) {
      ctx.ui.notify('No research history found', 'info');
      return;
    }

    const output = `## Research History (${history.length} entries)\n\n` +
      history.map(formatHistoryEntry).join('\n\n');

    pi.sendMessage({
      customType: 'research-history',
      content: output,
      display: true,
    });
  },
});
```

**Integrate with research execution:**

```typescript
// In tool.ts or orchestrator.ts
import { saveResearchHistory, type ResearchHistoryEntry } from './utils/research-history.ts';

// After research completes
const historyEntry: ResearchHistoryEntry = {
  id: createResearchRunId(),
  query: sanitizedQuery,
  depth: complexity,
  timestamp: Date.now(),
  exportPath: exportPath ?? undefined,
  totalTokens: panelState.totalTokens,
  duration: Math.floor((Date.now() - startTime) / 1000),
  status: 'success',
};

saveResearchHistory(historyEntry);
```

**Benefits:**
- Track research queries over time
- Find previous research results
- Understand research patterns
- Debug and troubleshoot issues

**Files Modified:**
- `src/utils/research-history.ts` (~100 lines - new file)
- `src/tool.ts` (~10 lines)
- `src/index.ts` (~20 lines)

**Testing:**
- Run several research queries
- Check `/research-history` shows entries
- Verify timestamps, tokens, durations are correct
- Test limit parameter

---

## Priority 3 Improvements (Consider Later)

### 7. Autocomplete for Scraped URLs

**Pi Feature:** Stacked autocomplete providers (v0.69.0)
**Effort:** Medium (~80 lines)
**Risk:** Low
**Value:** Low-Medium

**Description:**
Add autocomplete for previously scraped URLs when typing URLs in messages.

**Note:** The user previously expressed limited interest in autocomplete. Include only if there's strong demand.

**Implementation:**

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
if (ctx.ui?.addAutocompleteProvider && typeof ctx.ui.addAutocompleteProvider === 'function') {
  ctx.ui.addAutocompleteProvider({
    trigger: 'http',  // Activate when typing http
    handler: async (input) => {
      return Array.from(scrapedLinks)
        .filter(url => url.toLowerCase().includes(input.toLowerCase()))
        .slice(0, 10);  // Limit results
    }
  });
}
```

---

### 8. Terminal Input Interception

**Pi Feature:** `terminal_input` event (v0.56.0)
**Effort:** Medium (~60 lines)
**Risk:** Medium
**Value:** Low-Medium

**Description:**
Add custom input handling for research shortcuts (e.g., `@r <query>` for quick research).

**Implementation:**

```typescript
// In index.ts
pi.on('terminal_input', (event, ctx) => {
  const { input } = event;

  // Handle @r prefix for quick research
  if (input.startsWith('@r ')) {
    const query = input.slice(3).trim();
    if (!query) return { type: 'continue' };

    // Inject research command
    ctx.ui.editor(`\n/research ${query}\n`);
    return { type: 'handled' };  // Consume input
  }

  // Handle @rd prefix for deep research
  if (input.startsWith('@rd ')) {
    const query = input.slice(4).trim();
    if (!query) return { type: 'continue' };

    // Inject research command with depth
    ctx.ui.editor(`\n/research ${query} depth:2\n`);
    return { type: 'handled' };  // Consume input
  }

  return { type: 'continue' };  // Pass through
});
```

---

## Implementation Timeline

### Sprint 1 (1-2 days)
- [ ] Priority 1.1: Tool execution progress tracking
- [ ] Priority 1.2: Custom hidden thinking label
- [ ] Priority 1.3: Argument-hint for research tool

### Sprint 2 (2-3 days)
- [ ] Priority 2.4: Custom configuration dialog
- [ ] Priority 2.5: Provider-specific timeout configuration
- [ ] Testing and documentation

### Sprint 3 (Optional, 1-2 days)
- [ ] Priority 2.6: Export history of previous research
- [ ] Priority 3.7: Autocomplete for scraped URLs (if needed)
- [ ] Priority 3.8: Terminal input interception (if needed)

---

## Risk Mitigation

### Testing Strategy

1. **Unit Tests:** Add tests for new utilities (history tracking, etc.)
2. **Integration Tests:** Test new commands with various inputs
3. **Performance Tests:** Monitor impact of new features
4. **User Testing:** Get feedback on new features

### Rollback Plan

1. Each improvement can be individually reverted
2. Use feature flags if needed (environment variables)
3. Monitor for issues after deployment
4. Have quick rollback procedures documented

### Documentation

1. Update README with new commands
2. Add user documentation for new features
3. Add developer documentation for internals
4. Create migration guide for breaking changes

---

## Success Metrics

### User Experience
- [ ] Research queries faster to start (configuration dialog)
- [ ] Progress more accurate (tool execution tracking)
- [ ] Commands more discoverable (argument-hint)

### Developer Experience
- [ ] Better debugging (history tracking)
- [ ] Better visibility (provider monitoring, status updates)
- [ ] Easier configuration (no env vars needed)

### Performance
- [ ] No performance regression
- [ ] Faster researcher sessions (provider timeout config)
- [ ] Better resource utilization

---

## Conclusion

This Stage 2 plan focuses on **medium-priority improvements** that provide significant value with manageable risk:

- **Priority 1** improvements are quick wins with low risk
- **Priority 2** improvements require more work but provide high value
- **Priority 3** improvements are optional based on user demand

The timeline allows for 2-3 sprints to implement these improvements, with thorough testing and documentation at each stage.

**Estimated Total Effort:** 4-7 days for all improvements
**Expected Impact:** Significantly improved UX, DX, and reliability

---

**Plan Version:** 1.0
**Date:** 2026-05-01
**Based On:** PI_FEATURES_RECOMMENDATIONS.md
**pi-research Version:** 0.1.13
