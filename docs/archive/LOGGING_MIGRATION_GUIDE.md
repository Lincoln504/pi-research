# Structured Logging Migration Guide

This guide explains how to migrate existing code to use the new structured logging system.

## Overview

The new structured logging system provides:
- **Consistent formatting**: No more manual `[Module]` prefixes
- **Context awareness**: Automatic correlation ID and context tracking
- **Testability**: Injectable `ILogger` interface for easy mocking
- **Structured data**: Machine-readable log entries with context

## Quick Migration

### Before (Old Pattern)

```ts
import { logger } from '../logger.ts';

// Manual prefix, inconsistent formatting
logger.log('[BrowserManager] Browser pool initialized');
logger.error('[BrowserManager] Failed to initialize', err);
logger.warn(`[BrowserManager] Retrying (${attempts}/${maxAttempts})...`);
logger.debug('[BrowserManager] Task completed in', duration, 'ms');
```

### After (New Pattern)

```ts
import { createStructuredLogger } from '../utils/structured-logger.ts';

// Create once at module level
const logger = createStructuredLogger('BrowserManager');

// Consistent formatting, automatic context
logger.info('Browser pool initialized');
logger.error('Failed to initialize', err);
logger.warn('Retrying', { attempts, maxAttempts });
logger.info('Task completed', { durationMs: duration });
```

## Migration Steps

### Step 1: Import the structured logger

```ts
// Remove
import { logger } from '../logger.ts';

// Add
import { createStructuredLogger } from '../utils/structured-logger.ts';
```

### Step 2: Create a logger instance

Create a logger instance at the module level (outside classes/functions):

```ts
// At the top of your module
const logger = createStructuredLogger('YourComponentName');
```

**Component Naming:**
- Use PascalCase: `BrowserManager`, `Orchestrator`, `KnowledgeStore`
- Be specific: `DeepResearchOrchestrator` instead of `Orchestrator`
- Match the class/module name when possible

### Step 3: Replace log calls

#### INFO logs

```ts
// Before
logger.log('[Component] Something happened');
logger.info('[Component] Something happened');

// After
logger.info('Something happened');
```

#### ERROR logs

```ts
// Before
logger.error('[Component] Something failed', err);
logger.error(`[Component] Failed to process ${item}:`, error);

// After
logger.error('Something failed', err);
logger.error('Failed to process', error, { item });
```

#### WARN logs

```ts
// Before
logger.warn('[Component] Something suspicious');
logger.warn(`[Component] Retrying (${attempts}/${maxAttempts})`);

// After
logger.warn('Something suspicious');
logger.warn('Retrying', { attempts, maxAttempts });
```

#### DEBUG logs

```ts
// Before
logger.debug('[Component] Debug info:', value);
logger.debug(`[Component] Task took ${duration}ms`);

// After
logger.debug('Debug info', { value });
logger.debug('Task completed', { durationMs: duration });
```

### Step 4: Convert template strings to context

**Before:**
```ts
logger.warn(`[Component] Retrying (${attempts}/${maxAttempts}) after ${delay}ms`);
```

**After:**
```ts
logger.warn('Retrying', { attempts, maxAttempts, delayMs: delay });
```

**Benefits:**
- Machine-readable context data
- Easier to parse and analyze logs
- Consistent field naming

## Advanced Usage

### Adding Context

Use context objects to add structured metadata:

```ts
logger.info('User action', {
  userId: 'user-123',
  action: 'login',
  ipAddress: '192.168.1.1'
});

logger.error('API request failed', error, {
  endpoint: '/api/search',
  method: 'POST',
  statusCode: 500
});
```

### Correlation IDs

Track related operations across components:

```ts
import { createStructuredLoggerWithCorrelation } from '../utils/structured-logger.ts';

const logger = createStructuredLoggerWithCorrelation('Orchestrator', {
  researchRunId: 'run-abc123'
});
```

Or for request-scoped operations:

```ts
import { withCorrelationLogger } from '../utils/structured-logger.ts';

const result = await withCorrelationLogger('BrowserManager', async (logger) => {
  logger.info('Starting search');
  const results = await performSearch(logger);
  logger.info('Search complete', { resultCount: results.length });
  return results;
});
```

### Child Loggers

Create child loggers with additional context:

```ts
const baseLogger = createStructuredLogger('BrowserManager');

// Add operation-specific context
const searchLogger = baseLogger.withContext({
  operation: 'search',
  query: 'example search'
});

searchLogger.info('Starting search');
// Logs include: { component: 'BrowserManager', operation: 'search', query: '...' }
```

### Dependency Injection (for testing)

Use the `ILogger` interface for testable code:

```ts
import type { ILogger } from '../utils/structured-logger.ts';

export class MyService {
  constructor(private logger: ILogger) {}

  doSomething() {
    this.logger.info('Doing something');
  }
}

// In production
import { createStructuredLogger } from '../utils/structured-logger.ts';
const service = new MyService(createStructuredLogger('MyService'));

// In tests
import { NoOpLogger } from '../utils/structured-logger.ts';
const service = new MyService(new NoOpLogger());
```

## Common Patterns

### Timing Operations

```ts
// Before
const start = Date.now();
// ... do work ...
logger.debug(`[Component] Operation took ${Date.now() - start}ms`);

// After
const start = Date.now();
// ... do work ...
logger.info('Operation completed', { 
  durationMs: Date.now() - start,
  operation: 'search' 
});
```

### Conditional Logging

```ts
// Before
if (verbose) {
  logger.debug('[Component] Debug info');
}

// After (structured logger handles verbosity automatically)
logger.debug('Debug info');
```

### Error Context

```ts
// Before
logger.error('[Component] Failed to fetch', err);

// After - include relevant context
logger.error('Failed to fetch', err, {
  url: requestUrl,
  method: 'GET',
  timeout: 5000
});
```

## Field Naming Conventions

Use consistent field names in context objects:

| Purpose | Field Name | Example |
|---------|------------|---------|
| Duration | `durationMs` | `{ durationMs: 1234 }` |
| Counts | `resultCount`, `attemptCount` | `{ resultCount: 5 }` |
| IDs | `userId`, `sessionId`, `correlationId` | `{ userId: 'user-123' }` |
| URLs | `url`, `endpoint` | `{ url: 'https://example.com' }` |
| Status | `status`, `statusCode` | `{ status: 'success' }` |
| Boolean | `isEnabled`, `wasSuccessful` | `{ isEnabled: true }` |

**Avoid:**
- Abbreviations like `dur` or `cnt`
- Inconsistent capitalization (`userId` vs `userID`)
- Vague names like `data` or `info`

## Log Level Guidelines

Use log levels consistently:

| Level | When to Use |
|-------|-------------|
| **ERROR** | Errors that prevent normal operation, require attention |
| **WARN** | Unexpected but recoverable situations, potential issues |
| **INFO** | Important operational events, state changes |
| **DEBUG** | Detailed diagnostic information, timing details |

**Examples:**

```ts
// ERROR - operation failed
logger.error('Failed to initialize browser pool', err);

// WARN - recovered from issue
logger.warn('Transient socket error, retrying', { retriesLeft: 2 });

// INFO - important event
logger.info('Browser pool initialized', { workerCount: 4 });

// DEBUG - diagnostic details
logger.debug('Search task completed', { durationMs: 123, resultCount: 10 });
```

## Testing with Structured Logger

### Using NoOpLogger

Suppress logging in tests:

```ts
import { NoOpLogger } from '../utils/structured-logger.ts';

describe('MyComponent', () => {
  it('should do something', () => {
    const logger = new NoOpLogger();
    const component = new MyComponent(logger);
    // ...
  });
});
```

### Using InMemoryLogger

Assert on log output in tests:

```ts
import { InMemoryLogger } from '../utils/structured-logger.ts';

describe('MyComponent', () => {
  it('should log errors correctly', () => {
    const logger = new InMemoryLogger();
    const component = new MyComponent(logger);

    component.doSomethingThatFails();

    expect(logger.hasLoggedMessage('Failed to do something')).toBe(true);
    expect(logger.hasLogLevel('error')).toBe(true);
  });
});
```

## Migration Checklist

For each module:

- [ ] Import `createStructuredLogger` instead of `logger`
- [ ] Create logger instance with component name
- [ ] Remove all `[Component]` prefixes from log messages
- [ ] Convert template string interpolation to context objects
- [ ] Ensure error logs pass the Error object correctly
- [ ] Use consistent field names in context objects
- [ ] Follow log level guidelines
- [ ] Test that logs are formatted correctly
- [ ] Run existing tests to ensure no regressions

## Module-by-Module Migration Plan

### Phase 1: Critical Infrastructure (Do First)
1. `src/infrastructure/browser-manager.ts`
2. `src/infrastructure/state-manager.ts`
3. `src/core/service-registry.ts`
4. `src/core/health-cache-manager.ts`

### Phase 2: Orchestration
1. `src/orchestration/deep-research-orchestrator.ts`
2. `src/orchestration/quick-research-orchestrator.ts`
3. `src/orchestration/coordinator.ts`

### Phase 3: Tools & Utilities
1. `src/tools/research-tool.ts`
2. `src/utils/metrics.ts`
3. `src/utils/error-tracker.ts`

### Phase 4: Knowledge Store
1. `src/knowledge/index.ts`
2. `src/knowledge/store.ts`
3. `src/knowledge/embedder.ts`

### Phase 5: Commands
1. `src/commands/research-command.ts`
2. `src/commands/health-command.ts`
3. `src/commands/settings-command.ts`

## FAQ

### Q: Should I create a new logger for every function?

**A:** No. Create one logger instance at the module level and reuse it. Use `withContext()` to add operation-specific context when needed.

### Q: What if I need both correlation ID and other context?

**A:** Create the logger with both:

```ts
const logger = createStructuredLogger('Component', {
  correlationId: generateCorrelationId(),
  sessionId: 'session-123'
});
```

### Q: Can I still use the global logger directly?

**A:** Yes, for backwards compatibility. However, new code should use the structured logger, and existing code should be migrated incrementally.

### Q: How do I handle sensitive data in logs?

**A:** Exclude sensitive data from context objects. The structured logger does not automatically redact data:

```ts
// Don't log passwords or tokens
logger.info('User logged in', { userId: 'user-123' }); // ✅
logger.info('User logged in', { userId, password }); // ❌
```

### Q: Will this affect performance?

**A:** Minimal overhead. The structured logger adds negligible cost for context object creation, and verbosity filtering is still handled by the underlying logger.

## Getting Help

If you encounter issues during migration:

1. Check the examples in this guide
2. Look at already-migrated modules (browser-manager, state-manager, etc.)
3. Review the type definitions in `src/utils/structured-logger.ts`
4. Consult the team lead for complex cases