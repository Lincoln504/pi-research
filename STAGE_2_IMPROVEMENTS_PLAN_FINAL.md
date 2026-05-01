# Stage 2 Improvements Plan (Final)
**Date:** 2026-05-01
**Based On:** Pi SDK 0.71.0 (Current State)
**Focus:** Most Powerful SDK Features Available Now

---

## Executive Summary

This plan focuses on the **most powerful and impactful features** available in the current Pi SDK (version 0.71.0). Based on actual SDK inspection and verified capabilities, we've identified the high-impact improvements that leverage Pi's extension system to its fullest.

**Key Insight:** The Pi SDK 0.71.0 provides an incredibly rich extension API. We can create truly powerful interactive experiences with custom dialogs, widgets, working indicators, and fine-grained event handling.

**Goal:** Implement 5-7 high-impact improvements that showcase the best of Pi's SDK capabilities.

---

## Current Pi SDK 0.71.0 Capabilities (Verified)

### Event System
✅ `agent_start` / `agent_end` - Agent lifecycle
✅ `turn_start` / `turn_end` - Turn lifecycle
✅ `message_start` / `message_update` / `message_end` - LLM message lifecycle
✅ `tool_execution_start` / `tool_execution_update` / `tool_execution_end` - Tool execution lifecycle
✅ `before_agent_start` - Modify system prompt before LLM call
✅ `after_provider_response` - Provider HTTP status monitoring
✅ `before_provider_request` - Modify payload before sending
✅ `context` - Modify messages before each LLM call
✅ `session_*` events - Session management (start, switch, fork, compact, tree, etc.)

### UI System
✅ `ctx.ui.custom()` - Full interactive dialog components with overlays
✅ `ctx.ui.select()` - Simple selector dialog
✅ `ctx.ui.confirm()` - Yes/no confirmation
✅ `ctx.ui.input()` - Text input dialog
✅ `ctx.ui.notify()` - Toast notifications
✅ `ctx.ui.setWorkingIndicator()` - Custom working animations
✅ `ctx.ui.setWorkingMessage()` - Set working text
✅ `ctx.ui.setHiddenThinkingLabel()` - Custom thinking labels
✅ `ctx.ui.setWidget()` - Persistent widgets (above/below editor)
✅ `ctx.ui.setFooter()` - Custom footer component
✅ `ctx.ui.setHeader()` - Custom header component
✅ `ctx.ui.setTitle()` - Set terminal title
✅ `ctx.ui.pasteToEditor()` - Paste into editor
✅ `ctx.ui.setEditorText()` - Set editor text
✅ `ctx.ui.getEditorText()` - Get editor text
✅ `ctx.ui.editor()` - Multi-line editor dialog
✅ `ctx.ui.setTheme()` / `ctx.ui.getAllThemes()` - Theme management
✅ `ctx.ui.setToolsExpanded()` - Tool output expansion control

### Tool System
✅ `prepareArguments` - Normalize arguments before validation
✅ `promptSnippet` / `promptGuidelines` - Tool prompt customization
✅ `renderShell: "self"` - Custom shell for large outputs
✅ `executionMode: "sequential" | "parallel"` - Per-tool execution control
✅ `renderCall` / `renderResult` - Custom tool rendering

### Session Management
✅ `ctx.newSession()` - Create new session
✅ `ctx.fork()` - Fork from entry
✅ `ctx.navigateTree()` - Navigate session tree
✅ `ctx.switchSession()` - Switch to different session file
✅ `ctx.reload()` - Hot reload extensions
✅ `ctx.waitForIdle()` - Wait for agent to finish
✅ `ctx.getContextUsage()` - Get context usage stats
✅ `ctx.compact()` - Trigger compaction

### Provider System
✅ `pi.registerProvider()` - Register custom providers
✅ `pi.unregisterProvider()` - Unregister providers
✅ Support for OAuth providers
✅ Support for custom API handlers
✅ Model discovery and management

---

## Priority 1: The "Power Users" Features (Maximum Impact)

These features leverage the most powerful SDK capabilities to create genuinely impressive user experiences.

### 1. Interactive Configuration Dashboard

**SDK Feature:** `ctx.ui.custom()` - Interactive component with overlays
**Effort:** Medium (~200 lines)
**Risk:** Medium
**Impact:** **Very High** - Users can visually configure everything

**Description:**
Create a full-featured interactive configuration dashboard using Pi's `custom()` API. This will be a multi-tab interface for managing all pi-research settings.

**Why It's Powerful:**
- Leverages Pi's custom dialog system with keyboard focus
- Shows live values with immediate validation
- Visual feedback on every change
- Categories: General, Researchers, Scraping, Providers, UI
- Shows cost estimates and configuration impact

**Implementation:**

```typescript
// In index.ts
pi.registerCommand('research-config', {
  description: 'Open interactive configuration dashboard',
  handler: async (_args, ctx) => {
    const config = getConfig();

    // Use Pi's custom() for a full-featured interactive dashboard
    const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
      const { useState, useEffect } = await import('../utils/react-hooks-polyfill.ts');

      // Component state
      const [activeTab, setActiveTab] = useState<'general' | 'researchers' | 'scraping' | 'providers'>('general');
      const [maxConcurrent, setMaxConcurrent] = useState(config.MAX_CONCURRENT_RESEARCHERS);
      const [researcherTimeout, setResearcherTimeout] = useState(config.RESEARCHER_TIMEOUT_MS);
      const [maxRetries, setMaxRetries] = useState(config.RESEARCHER_MAX_RETRIES);
      const [maxRetryDelay, setMaxRetryDelay] = useState(config.RESEARCHER_MAX_RETRY_DELAY_MS);
      const [maxScrapeUrls, setMaxScrapeUrls] = useState(MAX_SCRAPE_URLS);
      const [scrapeBatches, setScrapeBatches] = useState(MAX_SCRAPE_CALLS);
      const [showThinking, setShowThinking] = useState('minimal'); // From config
      const [theme, setTheme] = useState(ctx.ui.theme.name);

      const tabs = [
        { id: 'general', label: 'General', icon: '⚙️' },
        { id: 'researchers', label: 'Researchers', icon: '🔬' },
        { id: 'scraping', label: 'Scraping', icon: '🌐' },
        { id: 'providers', label: 'Providers', icon: '🔗' },
      ];

      // Render tab navigation
      const tabBar = tabs.map(tab => ({
        type: 'text',
        text: `${tab.id === activeTab ? '> ' : '  '}${tab.icon} ${tab.label}`,
        color: tab.id === activeTab ? 'cyan' : 'gray',
      }));

      // Render active tab content
      let contentLines: string[] = [];
      contentLines.push({ type: 'text', text: `\n╔════════════════════════════════════════╗`, color: 'cyan' });
      contentLines.push({ type: 'text', text: `║  pi-research Configuration Dashboard${' '.repeat(19)}║`, color: 'cyan' });
      contentLines.push({ type: 'text', text: `╚════════════════════════════════════════╝\n`, color: 'cyan' });

      // Tab bar
      contentLines.push(...tabBar);
      contentLines.push({ type: 'text', text: `\n${'─'.repeat(44)}\n`, color: 'gray' });

      // Content based on active tab
      if (activeTab === 'general') {
        contentLines.push({ type: 'text', text: '⚙️  General Settings\n', color: 'yellow' });
        contentLines.push({ type: 'text', text: `  Current Theme: ${theme}\n`, color: 'white' });
        contentLines.push({ type: 'text', text: `  Thinking Level: ${showThinking}\n`, color: 'white' });
        contentLines.push({ type: 'text', text: `  TUI Refresh: ${config.TUI_REFRESH_DEBOUNCE_MS}ms\n`, color: 'white' });
        contentLines.push({ type: 'text', text: `  Console Restore: ${config.CONSOLE_RESTORE_DELAY_MS}ms\n`, color: 'white' });
      } else if (activeTab === 'researchers') {
        contentLines.push({ type: 'text', text: '🔬  Researcher Settings\n', color: 'yellow' });
        contentLines.push({ type: 'text', text: `  Max Concurrent: ${maxConcurrent} (1-10)\n`, color: 'white' });
        contentLines.push({ type: 'text', text: `  Timeout: ${researcherTimeout / 1000}s (1-10min)\n`, color: 'white' });
        contentLines.push({ type: 'text', text: `  Max Retries: ${maxRetries} (0-10)\n`, color: 'white' });
        contentLines.push({ type: 'text', text: `  Max Retry Delay: ${maxRetryDelay / 1000}s (1-60s)\n`, color: 'white' });
      } else if (activeTab === 'scraping') {
        contentLines.push({ type: 'text', text: '🌐  Scraping Settings\n', color: 'yellow' });
        contentLines.push({ type: 'text', text: `  Max URLs per Batch: ${maxScrapeUrls} (1-10)\n`, color: 'white' });
        contentLines.push({ type: 'text', text: `  Max Batches: ${scrapeBatches} (1-3)\n`, color: 'white' });
        contentLines.push({ type: 'text', text: `  Max Chars per URL: ${config.MAX_CONTENT_LENGTH ?? 50000}\n`, color: 'white' });
      } else if (activeTab === 'providers') {
        contentLines.push({ type: 'text', text: '🔗  Provider Settings\n', color: 'yellow' });
        contentLines.push({ type: 'text', text: `  Active Model: ${ctx.model?.id ?? 'Not selected'}\n`, color: 'white' });
        contentLines.push({ type: 'text', text: `  Context Window: ${ctx.model?.contextWindow ?? 'N/A'} tokens\n`, color: 'white' });
        contentLines.push({ type: 'text', text: `  Provider URL: Custom or Default\n`, color: 'white' });
      }

      // Footer
      contentLines.push({ type: 'text', text: `\n${'─'.repeat(44)}\n`, color: 'gray' });
      contentLines.push({ type: 'text', text: '  Actions:\n', color: 'yellow' });
      contentLines.push({ type: 'text', text: '    [1-4] Switch Tab\n', color: 'white' });
      contentLines.push({ type: 'text', text: '    [Enter] Save & Close\n', color: 'green' });
      contentLines.push({ type: 'text', text: '    [Esc] Cancel\n', color: 'red' });

      // Handle keyboard input
      return {
        type: 'box',
        border: 'double',
        content: contentLines,
        handleInput: (key) => {
          if (key === 'escape') {
            done({ type: 'cancel' });
            return;
          }

          if (key === 'enter') {
            done({
              type: 'submit',
              data: {
                maxConcurrent,
                researcherTimeout,
                maxRetries,
                maxRetryDelay,
                maxScrapeUrls,
                scrapeBatches,
                showThinking,
                theme,
              }
            });
            return;
          }

          // Tab switching
          if (key === '1') { setActiveTab('general'); }
          if (key === '2') { setActiveTab('researchers'); }
          if (key === '3') { setActiveTab('scraping'); }
          if (key === '4') { setActiveTab('providers'); }

          // Refresh on state change
          if (['1', '2', '3', '4'].includes(key)) {
            // State updates trigger re-render automatically
          }
        }
      };
    });

    if (result.type === 'submit') {
      const data = result.data;

      // Apply all configuration changes
      config.MAX_CONCURRENT_RESEARCHERS = data.maxConcurrent;
      config.RESEARCHER_TIMEOUT_MS = data.researcherTimeout;
      config.RESEARCHER_MAX_RETRIES = data.maxRetries;
      config.RESEARCHER_MAX_RETRY_DELAY_MS = data.maxRetryDelay;
      config.MAX_SCRAPE_URLS = data.maxScrapeUrls;
      // Note: scrapeBatches is constant, not config

      // Apply theme change
      if (data.theme !== ctx.ui.theme.name) {
        ctx.ui.setTheme(data.theme);
      }

      // Validate and save
      try {
        validateConfig(config);
        ctx.ui.notify('✅ Configuration saved', 'success');
        logger.info('[pi-research] Configuration updated via dashboard:', data);
      } catch (error) {
        ctx.ui.notify(`❌ Invalid configuration: ${error}`, 'error');
      }
    }
  },
});
```

**Benefits:**
- Visual, interactive configuration experience
- No need for environment variables
- Real-time validation
- Shows configuration relationships
- Saves time on configuration changes

**Files Modified:**
- `src/index.ts` (~200 lines)
- `src/utils/react-hooks-polyfill.ts` (~50 lines - new helper)

---

### 2. Real-Time Progress Dashboard (Custom Widget)

**SDK Feature:** `ctx.ui.setWidget()` - Persistent widget above/below editor
**Effort:** Medium (~150 lines)
**Risk:** Low
**Impact:** **Very High** - Live visibility into active research

**Description:**
Create a persistent widget that displays real-time research progress, including active researchers, status, token counts, and cost.

**Why It's Powerful:**
- Leverages Pi's widget system for persistent UI
- Updates in real-time as research progresses
- Shows researchers, costs, tokens, status
- Always visible without switching screens

**Implementation:**

```typescript
// In index.ts
let researchWidgetHandle: { dispose: () => void } | undefined = null;

// Subscribe to tool events to track research state
pi.on('tool_execution_start', (event, ctx) => {
  if (event.toolName === 'research') {
    // Research started - show widget
    showResearchWidget(ctx, event.args as any);
  }
});

pi.on('tool_execution_end', (event, ctx) => {
  if (event.toolName === 'research') {
    // Research ended - hide widget after delay
    setTimeout(() => {
      if (researchWidgetHandle) {
        researchWidgetHandle.dispose();
        researchWidgetHandle = null;
      }
    }, 5000);
  }
});

async function showResearchWidget(ctx: ExtensionContext, args: { query: string, depth?: number }) {
  // Don't replace existing widget
  if (researchWidgetHandle) return;

  const depth = args.depth ?? 0;
  const depthLabel = ['Quick', 'Normal', 'Deep', 'Exhaustive'][depth];

  researchWidgetHandle = ctx.ui.setWidget('research-dashboard', (tui, theme) => {
    const [activeResearchers, setActiveResearchers] = useState<number>(0);
    const [totalTokens, setTotalTokens] = useState<number>(0);
    const [totalCost, setTotalCost] = useState<number>(0);
    const [status, setStatus] = useState<string>('Initializing...');

    // Subscribe to research-panel state updates
    const interval = setInterval(() => {
      const panelState = getResearchPanelState(); // Access internal state
      if (panelState) {
        const activeCount = panelState.slices.size - 2; // coord + eval
        setActiveResearchers(Math.max(0, activeCount));
        setTotalTokens(panelState.totalTokens);
        setTotalCost(panelState.totalCost);

        if (panelState.progress) {
          const percent = Math.floor((panelState.progress.made / panelState.progress.expected) * 100);
          setStatus(`Progress: ${panelState.progress.made}/${panelState.progress.expected} (${percent}%)`);
        } else {
          setStatus('Planning...');
        }
      }
    }, 200);

    return {
      type: 'box',
      border: 'single',
      content: [
        { type: 'text', text: '🔬 Research Dashboard', color: 'cyan' },
        { type: 'text', text: `Query: ${args.query}`, color: 'white' },
        { type: 'text', text: `Mode: ${depthLabel} (depth ${depth})`, color: 'white' },
        { type: 'text', text: `Active Researchers: ${activeResearchers}`, color: 'green' },
        { type: 'text', text: `Tokens: ${totalTokens.toLocaleString()}`, color: 'white' },
        { type: 'text', text: `Cost: $${totalCost.toFixed(4)}`, color: 'yellow' },
        { type: 'text', text: `Status: ${status}`, color: 'cyan' },
      ],
      dispose: () => clearInterval(interval),
    };
  }, { placement: 'aboveEditor' });
}
```

**Benefits:**
- Always-visible research status
- Real-time token and cost tracking
- Visual feedback on researcher count
- No need to switch to research panel
- Professional dashboard experience

**Files Modified:**
- `src/index.ts` (~150 lines)
- `src/utils/widget-state.ts` (~50 lines - new helper)

---

### 3. Custom Working Animations

**SDK Feature:** `ctx.ui.setWorkingIndicator()` - Custom working animations
**Effort:** Low (~30 lines)
**Risk:** Very Low
**Impact:** **High** - Better UX, shows activity

**Description:**
Add custom working animations for different research phases (planning, researching, synthesizing).

**Why It's Powerful:**
- Shows distinct visual states for each phase
- Users know what's happening at a glance
- Leverages Pi's animation system
- Simple but effective UX improvement

**Implementation:**

```typescript
// In deep-research-orchestrator.ts

const WORKING_INDICATORS = {
  planning: {
    frames: ['📋 ', '📋. ', '📋.. ', '📋... '],
    intervalMs: 300,
  },
  researching: {
    frames: ['🔬 ', '🔬. ', '🔬.. ', '🔬... '],
    intervalMs: 250,
  },
  searching: {
    frames: ['🔍 ', '🔍. ', '🔍.. ', '🔍... '],
    intervalMs: 200,
  },
  synthesizing: {
    frames: ['📝 ', '📝. ', '📝.. ', '📝... '],
    intervalMs: 300,
  },
};

// PHASE 1: PLANNING
async runPhasePlanning() {
  // Set custom working indicator for planning
  if (this.options.ctx.ui?.setWorkingIndicator) {
    this.options.ctx.ui.setWorkingIndicator(WORKING_INDICATORS.planning);
  }

  // ... existing planning code
}

// PHASE 2: SEARCHING
async runPhaseSearching() {
  // Set custom working indicator for searching
  if (this.options.ctx.ui?.setWorkingIndicator) {
    this.options.ctx.ui.setWorkingIndicator(WORKING_INDICATORS.searching);
  }

  // ... existing search code
}

// PHASE 3: RESEARCHING
async runPhaseResearchers() {
  // Set custom working indicator for researching
  if (this.options.ctx.ui?.setWorkingIndicator) {
    this.options.ctx.ui.setWorkingIndicator(WORKING_INDICATORS.researching);
  }

  // ... existing researcher code
}

// PHASE 4: SYNTHESIZING
async runPhaseSynthesizing() {
  // Set custom working indicator for synthesizing
  if (this.options.ctx.ui?.setWorkingIndicator) {
    this.options.ctx.ui.setWorkingIndicator(WORKING_INDICATORS.synthesizing);
  }

  // ... existing synthesis code
}

// Cleanup: Restore default indicator
async cleanup() {
  if (this.options.ctx.ui?.setWorkingIndicator) {
    this.options.ctx.ui.setWorkingIndicator(); // No args = restore default
  }
}
```

**Benefits:**
- Visual feedback on research phase
- Distinguish planning vs. researching vs. synthesizing
- Users know what's happening instantly
- Adds polish to the experience

**Files Modified:**
- `src/orchestration/deep-research-orchestrator.ts` (~30 lines)

---

## Priority 2: Enhanced Event Handling (High Value)

These features use Pi's rich event system for better monitoring and diagnostics.

### 4. Comprehensive Provider Monitoring & Alerting

**SDK Features:** `before_provider_request` + `after_provider_response`
**Effort:** Medium (~100 lines)
**Risk:** Low
**Impact:** **High** - Better visibility, early problem detection

**Description:**
Enhanced provider monitoring with request tracking, error analysis, and proactive alerting.

**Why It's Powerful:**
- Tracks every provider request with metadata
- Detects patterns in failures
- Proactive user notification on issues
- Detailed diagnostics logging

**Implementation:**

```typescript
// In index.ts
interface ProviderRequest {
  id: string;
  timestamp: number;
  method: string;
  url?: string;
  status?: number;
  duration?: number;
  error?: string;
}

const activeRequests = new Map<string, ProviderRequest>();

// Track requests before they're sent
pi.on('before_provider_request', (event) => {
  const id = randomUUID();
  const request: ProviderRequest = {
    id,
    timestamp: Date.now(),
    method: 'POST', // Most LLM requests are POST
    // URL not available in event, but we can track model
  };

  activeRequests.set(id, request);
});

// Track responses after they're received
pi.on('after_provider_response', (event, ctx) => {
  const requestId = Array.from(activeRequests.entries()).find(([_, req]) =>
    // Match by timestamp window (within last 10 seconds)
    Date.now() - req.timestamp < 10000
  )?.[0];

  if (!requestId) return;

  const [id, request] = requestId;
  request.status = event.status;
  request.duration = Date.now() - request.timestamp;

  // Analyze and log
  if (event.status >= 500) {
    logger.error(`[pi-research] Provider server error: ${event.status}`, {
      duration: request.duration,
      headers: event.headers,
      request,
    });

    // Notify user of server issues
    ctx.ui.notify(`⚠️ Provider server error (${event.status}). Retrying...`, 'warning');

    // Track consecutive failures
    trackConsecutiveFailures(event.status);
  } else if (event.status === 429) {
    const retryAfter = event.headers?.['retry-after'];
    const retryDelay = retryAfter ? parseInt(retryAfter, 10) : 60;

    logger.warn(`[pi-research] Rate limited by provider`, {
      retryAfter,
      retryDelay,
      request,
    });

    // Notify user with retry time
    ctx.ui.notify(
      `⚠️ Rate limited. Auto-retry in ${retryDelay}s`,
      'warning'
    );

    // Consider pausing new requests to avoid 429 storms
    if (getConsecutive429Count() >= 3) {
      ctx.ui.notify(
        '⏸️ Pausing research for 2min to avoid rate limit...',
        'info'
      );
      await new Promise(resolve => setTimeout(resolve, 120000));
    }
  } else if (event.status >= 400 && event.status < 500) {
    logger.warn(`[pi-research] Provider client error: ${event.status}`, {
      headers: event.headers,
      request,
    });

    ctx.ui.notify(`⚠️ Provider error (${event.status}): ${getErrorMessage(event.status)}`, 'warning');
  } else if (event.status >= 200 && event.status < 300) {
    // Success - log performance metrics
    if (request.duration && request.duration > 10000) {
      logger.warn(`[pi-research] Slow provider response: ${request.duration}ms`, {
        status: event.status,
      });
    }
  }

  // Clean up completed request
  activeRequests.delete(id);
});

function getConsecutive429Count(): number {
  const recent = Array.from(activeRequests.values())
    .filter(r => r.status === 429)
    .filter(r => Date.now() - r.timestamp < 60000); // Last 60s
  return recent.length;
}

function trackConsecutiveFailures(status: number) {
  // Track failure patterns for diagnostics
  const recentFailures = Array.from(activeRequests.values())
    .filter(r => r.status >= 500)
    .filter(r => Date.now() - r.timestamp < 120000); // Last 2min

  if (recentFailures.length >= 3) {
    logger.error('[pi-research] Multiple consecutive provider failures detected', {
      count: recentFailures.length,
      window: '2min',
      statuses: recentFailures.map(r => r.status),
    });

    // Could implement circuit breaker pattern here
  }
}

function getErrorMessage(status: number): string {
  const messages: Record<number, string> = {
    400: 'Bad Request - Check API key',
    401: 'Unauthorized - Check API key',
    403: 'Forbidden - Insufficient permissions',
    404: 'Not Found - Model not available',
    408: 'Request Timeout - Try again',
    429: 'Rate Limited - Too many requests',
    500: 'Server Error - Try again later',
    502: 'Bad Gateway - Provider issue',
    503: 'Service Unavailable - Try again later',
    504: 'Gateway Timeout - Provider issue',
  };
  return messages[status] || 'Unknown error';
}
```

**Benefits:**
- Complete provider request visibility
- Early detection of rate limits
- Pattern recognition for failures
- Better user communication
- Performance metrics collection

**Files Modified:**
- `src/index.ts` (~100 lines)

---

### 5. Tool Execution Progress Tracking

**SDK Features:** `tool_execution_start` / `tool_execution_end` events
**Effort:** Low (~40 lines)
**Risk:** Low
**Impact:** **Medium-High** - Accurate progress

**Description:**
Track actual tool executions for accurate progress tracking instead of estimating from budget.

**Why It's Powerful:**
- Accurate progress based on actual work done
- Not dependent on budget estimates
- Works regardless of tool execution speed
- More reliable user experience

**Implementation:**

```typescript
// In deep-research-orchestrator.ts, runResearcher() method

const toolExecutions = new Map<string, number>();

const subscription = session.subscribe((event: AgentSessionEvent) => {
  switch (event.type) {
    case 'tool_execution_start':
      // Tool started - log for debugging
      logger.debug(
        `[Researcher ${internalId}] Tool ${event.toolName} started`,
        { args: event.args }
      );
      break;

    case 'tool_execution_end':
      if (!event.isError) {
        // Tool completed - increment counter
        const count = (toolExecutions.get(internalId) ?? 0) + 1;
        toolExecutions.set(internalId, count);

        // Calculate progress: 0.9 progress for tool calls, 0.1 for synthesis
        const progress = (count / RESEARCHER_TOOL_BUDGET) * 0.9;
        const percent = Math.floor(progress * 100);

        // Update slice progress
        if (this.options.panelState.progress) {
          this.options.panelState.progress.made = Math.floor(
            this.options.panelState.progress.expected * progress
          );
        }

        // Update slice status with progress
        updateSliceStatus(
          this.options.panelState,
          label,
          `${count}/${RESEARCHER_TOOL_BUDGET} (${percent}%)`
        );

        this.options.onUpdate();

        logger.debug(
          `[Researcher ${internalId}] Tool ${event.toolName} completed`,
          { count, progress: `${percent}%` }
        );
      } else {
        // Tool failed - still increment for progress but log error
        const count = (toolExecutions.get(internalId) ?? 0) + 1;
        toolExecutions.set(internalId, count);

        logger.error(
          `[Researcher ${internalId}] Tool ${event.toolName} failed`,
          { error: event.result }
        );
      }
      break;
  }
});
```

**Benefits:**
- Accurate progress tracking
- Shows actual work done
- Not dependent on estimates
- Better user expectations

**Files Modified:**
- `src/orchestration/deep-research-orchestrator.ts` (~40 lines)

---

## Priority 3: Polish & Completion (Medium Value)

### 6. Custom Thinking Labels per Researcher

**SDK Feature:** `ctx.ui.setHiddenThinkingLabel()`
**Effort:** Very Low (~10 lines)
**Risk:** Very Low
**Impact:** **Medium** - Better debugging

**Implementation:**

```typescript
// In researcher.ts, after creating researcher session

if (ctx.ui?.setHiddenThinkingLabel && typeof ctx.ui.setHiddenThinkingLabel === 'function') {
  ctx.ui.setHiddenThinkingLabel(`Researcher ${internalId}`);
}
```

**Benefits:**
- Distinguish researcher thinking from other messages
- Better debugging visibility
- Clean, labeled experience

---

### 7. Argument-Hint for Research Tool

**SDK Feature:** `argument-hint` frontmatter in prompt templates
**Effort:** Low (~10 lines)
**Risk:** Very Low
**Impact:** **Medium** - Better discovery

**Implementation:**

```markdown
<!-- src/prompts/research-tool-usage.md -->
---
argument-hint: <query> [depth:0|1|2|3] [model:<id>]
---

When using /research, provide a research query.

Parameters:
- query: Required. The research topic or question to investigate.
- depth: Optional. Research complexity (0=Quick, 1=Normal, 2=Deep, 3=Exhaustive).
  Default: 0 (quick mode).
- model: Optional. Model ID to use for all research agents.
  Default: Current active model.

Depth Levels:
- 0 (Quick): Single session, ~85% of queries. Fast results.
- 1 (Normal): Up to 2 researchers, 2 rounds. Balanced.
- 2 (Deep): Up to 3 researchers, 3 rounds. Thorough.
- 3 (Exhaustive): Up to 5 researchers, 5 rounds. Maximum coverage.

Examples:
/research "latest AI developments"
/research "machine learning trends" depth:2
/research "python best practices" depth:1 model:claude-sonnet-4-20250514
```

**Benefits:**
- Better command discovery
- Clearer usage guidance
- Reduced learning curve

---

## Implementation Timeline

### Sprint 1 (2-3 days)
- [ ] Priority 1.1: Interactive Configuration Dashboard
- [ ] Priority 1.2: Real-Time Progress Dashboard
- [ ] Priority 1.3: Custom Working Animations

### Sprint 2 (2 days)
- [ ] Priority 2.4: Comprehensive Provider Monitoring
- [ ] Priority 2.5: Tool Execution Progress Tracking

### Sprint 3 (1 day)
- [ ] Priority 3.6: Custom Thinking Labels
- [ ] Priority 3.7: Argument-Hint for Research Tool

**Total Time:** 5-6 days

---

## Risk Assessment

### High Impact Changes

1. **Configuration Dashboard**
   - Complex UI component
   - Many state changes
   - **Mitigation:** Test with all config combinations

2. **Progress Dashboard Widget**
   - Persistent UI element
   - Real-time updates
   - **Mitigation:** Ensure cleanup on research end

### Medium Impact Changes

3. **Provider Monitoring**
   - Additional event handlers
   - Potential performance impact
   - **Mitigation:** Keep logging efficient

4. **Tool Execution Tracking**
   - New event subscriptions
   - Progress calculation changes
   - **Mitigation:** Test with various tool call patterns

### Low Risk Changes

5. **Working Animations**
   - Simple visual changes
   - No logic changes
   - **Risk:** Very Low

6. **Thinking Labels & Argument-Hints**
   - Simple text changes
   - No logic changes
   - **Risk:** Very Low

---

## Success Metrics

### User Experience
- [ ] Configuration is intuitive and visual
- [ ] Progress is visible at all times
- [ ] Research phases are clearly distinguishable
- [ ] Errors are communicated clearly
- [ ] Commands are discoverable

### Technical Quality
- [ ] No performance regressions
- [ ] Memory usage stable
- [ ] Widget cleanup works correctly
- [ ] Event handlers don't leak
- [ ] Configuration validation works

### Documentation
- [ ] All new features documented
- [ ] User guide updated
- [ ] Developer docs added
- [ ] Examples provided

---

## Notes on SDK Capabilities

### What's Available in Pi 0.71.0

✅ **Full Component System:** `ctx.ui.custom()` supports complex interactive dialogs
✅ **Overlay Support:** Custom dialogs can be overlaid with keyboard focus
✅ **Widget System:** Persistent widgets above/below editor
✅ **Working Indicators:** Custom animations for streaming
✅ **Event System:** Comprehensive lifecycle events
✅ **Theme System:** Full theme management
✅ **Session Control:** Full session lifecycle management
✅ **Provider System:** Custom provider registration
✅ **Tool System:** Per-tool execution control, custom rendering

### What We're Leveraging

1. **Interactive Dialogs** - Configuration dashboard with tabs and keyboard nav
2. **Widget System** - Real-time progress dashboard
3. **Working Indicators** - Phase-specific animations
4. **Event System** - Provider monitoring and tool tracking
5. **Prompt System** - Argument hints and thinking labels

### What We're NOT Using (Potential Future Work)

1. **Custom Headers/Footers** - Could add research-specific UI
2. **Custom Editor Component** - Vim/emacs-style editing
3. **Session Tree Navigation** - Research history visualization
4. **OAuth Providers** - SSO support for corporate proxies
5. **Autocomplete Providers** - URL/command completion
6. **Terminal Input Interception** - Custom input shortcuts

---

## Conclusion

### Key Insights

1. **Pi SDK is Powerful** - The SDK provides an incredibly rich API for extensions
2. **Custom Components** - `ctx.ui.custom()` enables full-featured interactive UI
3. **Widget System** - Persistent UI elements for real-time visibility
4. **Event System** - Comprehensive event coverage for monitoring
5. **Low Effort, High Impact** - Most improvements require <200 lines

### Expected Impact

| Category | Before | After | Improvement |
|----------|--------|-------|-------------|
| **Configuration** | Env vars only | Interactive dashboard | ✅ Much better |
| **Visibility** | Research panel only | Persistent widget | ✅ Always visible |
| **Feedback** | Basic status | Phase-specific animations | ✅ Clearer |
| **Monitoring** | Limited logs | Full request tracking | ✅ Much better |
| **Progress** | Budget estimate | Actual tool calls | ✅ More accurate |
| **Discovery** | Manual lookup | Command autocomplete | ✅ Better |

---

**Plan Version:** 2.0 (Final)
**Date:** 2026-05-01
**Based On:** Pi SDK 0.71.0 (Verified)
**pi-research Version:** 0.1.13
**Total Effort:** 5-6 days for all improvements
