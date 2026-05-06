# Contributing to pi-research

Thank you for your interest in contributing to pi-research! This document provides guidelines and patterns for understanding and extending the codebase.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Internal API Patterns](#internal-api-patterns)
3. [Key Components](#key-components)
4. [Testing Guidelines](#testing-guidelines)
5. [Development Workflow](#development-workflow)
6. [Code Style](#code-style)

---

## Architecture Overview

pi-research is organized into several layers:

```
┌─────────────────────────────────────┐
│   Pi Extension (src/index.ts)       │  ← Entry point, tool registration
├─────────────────────────────────────┤
│   Orchestration Layer               │
│   - DeepResearchOrchestrator        │  ← Multi-agent coordination
│   - Researcher Factory              │  ← Creates isolated sessions
│   - Research Manager                │  ← Manages research lifecycle
├─────────────────────────────────────┤
│   Browser Pool Layer                │
│   - BrowserTaskScheduler            │  ← Worker pool manager
│   - BrowserServer                   │  ← HTTP server for workers
│   - StateManager                    │  ← State persistence
├─────────────────────────────────────┤
│   Worker Layer                      │
│   - thread-worker.mjs              │  ← Browser task execution
├─────────────────────────────────────┤
│   Tool Layer                        │
│   - search, scrape, grep, security  │  ← Individual research tools
│   - stackexchange                   │
├─────────────────────────────────────┤
│   Infrastructure Layer             │
│   - browser-manager.ts              │  ← Pool lifecycle management
│   - browser-config.ts               │  ← Browser configuration
│   - shutdown-manager.ts             │  → Global cleanup coordinator
└─────────────────────────────────────┘
```

---

## Internal API Patterns

### 1. Singleton Pattern with Caching

Used for: Browser pool, state manager, logger

```typescript
// Cached singleton with globalThis for shared access
let initializationPromise: Promise<IScheduler> | null = null;

async function getScheduler(config?: Config): Promise<IScheduler> {
    // Check cache first
    let existing = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
    if (existing) return existing;

    // Coalesce concurrent initialization
    if (initializationPromise) return initializationPromise;

    initializationPromise = createScheduler();
    return initializationPromise;
}
```

**Best Practices:**
- Use `globalThis` for cross-module sharing
- Use promises to coalesce concurrent initialization
- Clear cache on config changes or shutdown

---

### 2. Observer Pattern for Progress Tracking

Used for: Orchestrator progress, TUI updates

```typescript
// Observer interface
export interface ResearchObserver {
    onStartResearcher?(id: string, round: number): void;
    onCompleteResearcher?(id: string, report: string): void;
    onError?(id: string, error: Error): void;
    onRoundStart?(round: number, totalRounds: number): void;
}

// Usage in orchestrator
class DeepResearchOrchestrator {
    private observer?: ResearchObserver;

    async execute(signal?: AbortSignal): Promise<string> {
        this.observer?.onRoundStart(this.currentRound, targetRounds);
        // ... research logic ...
        this.observer?.onCompleteResearcher(researcherId, report);
    }
}
```

**Best Practices:**
- Make all observer methods optional
- Call observer methods before/after operations
- Pass relevant context (ids, counts, results)

---

### 3. Factory Pattern for Session Creation

Used for: Creating researcher sessions with tool lockdown

```typescript
export async function createResearcherSession(options: ResearcherOptions): Promise<any> {
    const { query, model, sessionId, tools } = options;

    // Use Pi's agent creation with tool lockdown
    const agent = await ctx.agent.createAgent({
        model,
        tools: tools.map(t => t.name),  // Lock down to specific tools only
        thinking: 'off',  // Disable for efficiency
        hiddenThinkingLabels: ['thinking', 'thought', 'reasoning'],
    });

    return agent;
}
```

**Best Practices:**
- Enforce tool lockdown (only specified tools available)
- Disable thinking for efficiency
- Use hidden labels for thinking output

---

### 4. Task Registration Pattern for Cleanup

Used for: Shutdown manager, resource cleanup

```typescript
// Registration
shutdownManager.register(async () => {
    logger.log('[Component] Cleaning up...');
    await stopBrowserManager();
});

// Usage in shutdown
class ShutdownManager {
    private tasks: CleanupTask[] = [];

    register(task: CleanupTask) {
        this.tasks.push(task);
    }

    async runCleanup(reason: string): Promise<void> {
        for (const task of this.tasks.reverse()) {  // LIFO order
            try {
                await task();
            } catch (error) {
                logger.error('Cleanup task error:', error);
            }
        }
    }
}
```

**Best Practices:**
- Register cleanup tasks during initialization
- Run tasks in LIFO order (last registered, first cleaned)
- Catch and log errors per-task (don't fail entire shutdown)

---

### 5. Error Recovery with Retry

Used for: Transient socket errors, network issues

```typescript
async function runBrowserTask<T>(task: any, retries = 1): Promise<T> {
    try {
        return await scheduler.runSearch(task.query);
    } catch (error: any) {
        // Check if error is transient
        const isTransient = error.message.includes('ECONNREFUSED') ||
                           error.message.includes('EPIPE') ||
                           error.message.includes('timed out');

        if (retries > 0 && isTransient) {
            await forceSchedulerRestart();  // Reset pool state
            await new Promise(r => setTimeout(r, 1000));  // Backoff
            return runBrowserTask(task, retries - 1);  // Retry
        }

        throw error;  // Re-throw non-transient errors
    }
}
```

**Best Practices:**
- Identify transient errors specifically
- Reset state before retrying
- Use exponential backoff (small delays between retries)
- Limit retry count to avoid infinite loops

---

### 6. Hook Pattern for Extensibility

Used for: Pi extension lifecycle hooks

```typescript
// Prompt injection hook
pi.on('before_agent_start', async (event: any, ctx: any) => {
    const needsResearch = RESEARCH_REGEX.test(event.prompt || '');
    if (needsResearch) {
        const prompt = loadPrompt('research-tool-usage');
        return {
            systemPrompt: event.systemPrompt + '\n\n' + prompt
        };
    }
    return { systemPrompt: event.systemPrompt };
});

// Diagnostic hook
pi.on('after_provider_response', async (event: any) => {
    if (event.error) {
        logger.error('[Provider Error]', event.error);
    }
});
```

**Best Practices:**
- Use `before_agent_start` for prompt injection (not `on('input')`)
- Always return modified event structure
- Use diagnostic hooks for logging only (don't modify behavior)

---

### 7. State Persistence Pattern

Used for: State manager, browser server tracking

```typescript
class StateManager {
    async writeState(state: SingletonState): Promise<void> {
        // File locking for concurrent access
        await this.acquireLock();

        try {
            // Backup existing state
            await this.backupState();

            // Write new state
            await fs.writeFile(this.stateFilePath, JSON.stringify(state, null, 2));
            this.lastWrittenState = state;
        } finally {
            await this.releaseLock();
        }
    }

    async readState(): Promise<SingletonState | null> {
        try {
            const data = await fs.readFile(this.stateFilePath, 'utf-8');
            const parsed = JSON.parse(data);
            return isSingletonState(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
}
```

**Best Practices:**
- Use file locking for concurrent access
- Backup before writing (corruption recovery)
- Validate read data with type guards
- Handle parse errors gracefully

---

### 8. Worker Pool Pattern

Used for: Browser pool, concurrent task execution

```typescript
class BrowserTaskScheduler {
    private pool: any | null = null;
    private poolInitializationPromise: Promise<any> | null = null;

    private async ensurePool(): Promise<any> {
        // Return existing pool if config unchanged
        if (this.pool && this.currentWorkerCount === config.WORKER_THREADS) {
            return this.pool;
        }

        // Coalesce initialization
        if (this.poolInitializationPromise) {
            return this.poolInitializationPromise;
        }

        // Create new pool
        this.poolInitializationPromise = this.createPool();
        return this.poolInitializationPromise;
    }

    async runSearch(query: string): Promise<SearchResult[]> {
        const pool = await this.ensurePool();
        return pool.execute({ query });
    }
}
```

**Best Practices:**
- Lazy initialization (create on first use)
- Restart pool on config changes
- Coalesce concurrent initialization
- Track worker count for config change detection

---

## Key Components

### DeepResearchOrchestrator

**Purpose:** Coordinates multi-round, multi-agent research

**Key Methods:**
- `execute(signal?)` - Main execution entry point
- `planNextRound()` - LLM-based research planning
- `launchResearchers()` - Parallel researcher execution
- `evaluateResults()` - LLM-based result evaluation

**Pattern:** State machine with observer pattern

### BrowserManager

**Purpose:** Manages browser pool lifecycle

**Key Methods:**
- `runBrowserTask(task, type)` - Execute search/scrape tasks
- `runBrowserHealthCheck()` - Validate browser availability
- `stopBrowserManager()` - Shutdown pool
- `forceSchedulerRestart()` - Restart on config changes

**Pattern:** Singleton with cached promise

### StateManager

**Purpose:** Persistent state for browser server and sessions

**Key Methods:**
- `readState()` - Read state from disk
- `writeState(state)` - Write state with locking
- `getBrowserServer()` - Get server info
- `isPidAlive(pid)` - Check if process is running

**Pattern:** File-based state with locking and backup

### ShutdownManager

**Purpose:** Coordinate cleanup on process exit

**Key Methods:**
- `register(task)` - Register cleanup callback
- `runCleanup(reason)` - Execute all cleanup tasks

**Pattern:** Task registration with LIFO execution

---

## Testing Guidelines

### Unit Tests

Run with: `npm test`

Structure:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('ComponentName', () => {
    beforeEach(() => {
        // Setup mocks, clear state
    });

    afterEach(() => {
        // Cleanup
    });

    it('should do something', () => {
        // Arrange, Act, Assert
        expect(result).toBe(expected);
    });
});
```

### Integration Tests

Run with: `npm run test:integration`

- Require browser environment (camoufox)
- Use `test/integration/helpers/setup.ts` for graceful skipping
- Set `maxConcurrency: 1` for serial execution
- Clean up resources in `afterAll`

Example:
```typescript
import { setupLifecycle, teardownLifecycle, type TestContext } from './helpers/setup.ts';

describe('Browser Integration', () => {
    let testContext: TestContext;

    beforeAll(async () => {
        testContext = await setupLifecycle();
    });

    afterAll(async () => {
        await teardownLifecycle(testContext);
    });

    it('should work', () => {
        if (testContext.skipTests()) return;
        // Test...
    });
});
```

### Test Coverage

Run with: `npm run test:coverage`

- View HTML report at: `coverage/lcov-report/index.html`
- Aim for >80% coverage on critical paths

---

## Development Workflow

1. **Setup**
   ```bash
   npm install
   npm run setup  # Install browser dependencies
   ```

2. **Development**
   ```bash
   npm run type-check  # Verify types
   npm run lint         # Check code style
   npm test             # Run tests
   ```

3. **Building**
   ```bash
   npm run build        # Build for production
   ```

4. **Local Testing**
   ```bash
   cd /path/to/pi-research
   pi install .         # Install local extension
   ```

---

## Code Style

### TypeScript

- Use `const` for primitives, `let` for reassignment
- Use arrow functions for callbacks
- Use async/await instead of Promises
- Use JSDoc comments for exports
- Use `type` for type aliases, `interface` for objects

### Naming

- Classes: `PascalCase`
- Functions/Methods: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Private members: `_underscorePrefix`

### Error Handling

- Always use try/catch/finally for resource cleanup
- Use specific error messages with context
- Throw `Error` objects (not strings)
- Log errors with `logger.error()`

### Type Safety

- Avoid `any` - use unknown or proper types
- Use TypeBox for runtime validation
- Use type guards for narrowing
- Enable strict TypeScript mode

---

## Getting Help

- Open an issue on GitHub
- Check ARCHITECTURE.md for deeper technical details
- Review existing tests for examples
- Ask in the pi community

---

**Happy contributing!** 🚀
